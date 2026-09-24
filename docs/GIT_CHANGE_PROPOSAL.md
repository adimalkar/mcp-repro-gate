# Git change proposal v1

The proposal contract binds a proposed patch's bytes to a read-only observation of a clean Git worktree and exact, operator-intended path list. The second Phase 3 slice can stage that patch in a disposable Git index and inspect its actual changed paths. Neither API approves, commits, or promotes the patch.

The exported `createGitChangeProposal` function takes a repository path, destination branch ref, repository/action/policy identifiers, patch bytes, allowed file paths, and expiry. It returns a versioned proposal containing:

- the SHA-256 digest of the exact patch bytes, with no patch contents;
- a Git-observed canonical worktree-root digest, HEAD commit/tree, checked-out branch ref, and ref OID;
- sorted exact relative POSIX paths, not globs;
- a digest of the complete proposal, so accidental or adversarial field changes are detectable.

`observeCleanGitWorkspace` rejects a nested path, detached/wrong branch, missing commit, or Git-dirty tracked/untracked state. It clears inherited `GIT_*` variables so they cannot redirect the Git repository or index, reads the key Git values twice, and refuses an inconsistent observation. `matchesCurrentGitWorkspace` can later detect a changed patch, dirty worktree, or moved ref, but it is only a read-only drift check; it is **not** atomic with a future write.

The structural format is in [`git-change-proposal.schema.json`](../schemas/git-change-proposal.schema.json). The library additionally validates Git ref and path semantics. This first version limits patches to 4 MiB and path lists to 256 exact files. It deliberately requires a Git-clean worktree; an explicit dirty-state witness is future work.

## Trust and limits

- The workspace fields are observed through local Git commands. `repositoryId`, `actionId`, `policyDigest`, path scope, and patch bytes are caller inputs until a later phase wires them to the operator catalog, durable plan, and approval store. The proposal does not authenticate those references.
- `verifyGitChangeProposal` checks the proposal's digest, **not** a signature. Anyone who can rewrite a proposal can compute a new digest.
- The proposal alone hashes the patch without parsing it. `stageGitChangeProposal` checks the exact patch bytes, expiry, and worktree witness; clones into a temporary directory; applies the patch to that clone's index; then reads Git's NUL-delimited raw diff. It rejects an empty or malformed effect, a path outside `allowedPaths`, and symlink, submodule, or other non-regular file modes. A rename requires both old and new paths in scope.
- The staged result records the candidate tree OID, exact changed paths, and digest of Git's staged diff. It is an ephemeral computation, **not** an approval, signature, durable receipt, or object installed in the protected repository. The temporary clone and its objects are deleted when the call returns.
- Git's clean status excludes ignored files, and the observation does not cover process, network, credential, or other external effects. Root-path hashing binds this local worktree but is not a portable proof of repository ownership.
- The pre/post worktree checks do not eliminate a race or ABA change between observations. There is no atomic approval/revocation check or compare-and-swap ref update yet. Do not describe a proposal or staged result as an authorized code change or effect-confinement receipt.

The next slice must bind a trusted approval to the exact proposal/effect and design a safe compare-and-swap promotion without writing a checked-out branch behind its worktree. See the [roadmap](ROADMAP.md).
