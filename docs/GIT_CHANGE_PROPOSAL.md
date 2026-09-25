# Git change proposal, staging, and approval

The proposal contract binds a proposed patch's bytes to a read-only observation of a clean Git worktree and exact, operator-intended path list. The staging API applies that patch in a disposable Git index and inspects its actual changed paths. A host-side SQLite ledger can record an operator-reviewed effect and later check that the same effect is still active. None of these APIs commits or promotes the patch.

The exported `createGitChangeProposal` function takes a repository path, destination branch ref, repository/action/policy identifiers, patch bytes, allowed file paths, and expiry. It returns a versioned proposal containing:

- the SHA-256 digest of the exact patch bytes, with no patch contents;
- a Git-observed canonical worktree-root digest, HEAD commit/tree, checked-out branch ref, and ref OID;
- sorted exact relative POSIX paths, not globs;
- a digest of the complete proposal, so accidental or adversarial field changes are detectable.

`observeCleanGitWorkspace` rejects a nested path, detached/wrong branch, missing commit, or Git-dirty tracked/untracked state. It clears inherited `GIT_*` variables so they cannot redirect the Git repository or index, reads the key Git values twice, and refuses an inconsistent observation. `matchesCurrentGitWorkspace` can later detect a changed patch, dirty worktree, or moved ref, but it is only a read-only drift check; it is **not** atomic with a future write.

The structural format is in [`git-change-proposal.schema.json`](../schemas/git-change-proposal.schema.json). The library additionally validates Git ref and path semantics. This first version limits patches to 4 MiB and path lists to 256 exact files. It deliberately requires a Git-clean worktree; an explicit dirty-state witness is future work.

## Bind a Git proposal to a persisted plan

For new Git-change plans, the trusted host first calls `createGitChangeIntent` and passes that exact object as `ReproGateKernel.plan(...).arguments` for an operator-configured Git catalog tool. It then creates the proposal with the resulting `actionId` and policy digest. The intent contains the repository ID, observed Git witness, patch digest, exact path list, and expiry; raw patch contents stay out of the plan.

`deriveGitApprovalAuthorityFromPlan` loads the persisted plan and checks its envelope digest, exact intent argument digest, current Git witness, configured repository/destination, catalog tool identity/schema/effects/scopes, current policy decision, and both expiries. The catalog tool must include `local_write` and the `git_change:promote` scope. `grantGitChangeFromPlan` uses that derived authority when recording the reviewed staged effect; `matchesGitApprovalFromPlan` re-derives it before checking the ledger. A policy, catalog, repository, plan, or workspace change fails closed.

These are host-side library functions, not MCP tools. The host must own the plan store, repository configuration, catalog, and policy; the helpers cannot prove that a caller-supplied store/config came from a trusted deployment. Existing proposals made without the Git intent will not match a plan retroactively. No default server tool exposes Git planning or approval yet.

## Host-side approval ledger

`SqliteGitApprovalStore.grant` re-stages the exact patch before writing one durable approval per proposal. The trusted host must supply an authority binding from its repository configuration and persisted action/policy state, plus the digest of the staged effect actually reviewed by the operator. Granting fails if either differs from the fresh observation. The approval expires no later than the proposal and host authority. `matchesActiveApproval` re-stages and checks the authority, effect, expiry, and ledger state before and after staging. `revoke` persists a revocation; a revoked proposal cannot be re-granted under the same proposal ID.

The approval API is a **host-side library boundary**, not an MCP tool. The host must authenticate the operator, protect SQLite write access, derive authority from the persisted plan and current operator configuration, and present the patch and staged manifest for review before passing its reviewed digest. The library cannot prove the reviewer is human or that an injected host configuration is genuine. The ledger is not signed portable evidence, and a caller with write access to its database can forge or alter it. Place the database outside the watched Git worktree.

## Trust and limits

- The workspace fields are observed through local Git commands. In a bare proposal, `repositoryId`, `actionId`, `policyDigest`, path scope, and patch bytes remain caller inputs. The plan-binding helper checks them against a host-owned persisted plan, catalog, policy, and repository configuration. It cannot authenticate the host inputs themselves or the operator identity.
- `verifyGitChangeProposal` checks the proposal's digest, **not** a signature. Anyone who can rewrite a proposal can compute a new digest.
- The proposal alone hashes the patch without parsing it. `stageGitChangeProposal` checks the exact patch bytes, expiry, and worktree witness; clones into a temporary directory; applies the patch to that clone's index; then reads Git's NUL-delimited raw diff. It rejects an empty or malformed effect, a path outside `allowedPaths`, and symlink, submodule, or other non-regular file modes. A rename requires both old and new paths in scope.
- The staged result records the candidate tree OID, exact changed paths, and digest of Git's staged diff. It is an ephemeral computation, **not** an approval, signature, durable receipt, or object installed in the protected repository. The temporary clone and its objects are deleted when the call returns.
- Git's clean status excludes ignored files, and the observation does not cover process, network, credential, or other external effects. Root-path hashing binds this local worktree but is not a portable proof of repository ownership.
- The pre/post worktree and ledger checks do not eliminate a race or ABA change between observations. There is no atomic approval/revocation check with a compare-and-swap ref update yet. Do not describe a proposal, staged result, or approval match as an authorized code change or effect-confinement receipt.

The next slice must authenticate an out-of-band operator review and design a safe compare-and-swap promotion without writing a checked-out branch behind its worktree. See the [roadmap](ROADMAP.md).
