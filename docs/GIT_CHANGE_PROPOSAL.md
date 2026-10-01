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

## Signed operator decision contract

Git Operator Review v1 authenticates an explicit `approve` or `deny` decision using an Ed25519 key configured by the host. Its signed payload binds an audience, operator ID, public-key fingerprint, proposal digest, derived authority digest, staged-effect digest, issue time, and expiry. It contains neither raw patch bytes nor private signing material. The [review schema](../schemas/git-operator-review.schema.json) describes its strict structure; cryptographic identity, permission, real-date and freshness checks remain library responsibilities.

`gitOperatorKeyId` hashes public Ed25519 SPKI DER, not PEM text. Signatures cover the UTF-8 domain `ReproGate/GitOperatorReview/v1`, one NUL byte, and the canonical JSON payload. Signature encoding is canonical unpadded base64url representing exactly 64 bytes. The host-owned trust configuration declares enabled operators/keys and exact repository ID, worktree-root digest, and destination-ref permissions. A key or permission supplied by a proposal or review is not an authority source.

`authenticateGitOperatorReview` returns a detached, frozen snapshot only after checking the signature, current host trust, exact bindings, and bounded canonical UTC times. Decision-making consumers must use that snapshot rather than reread the original input object. `verifyGitOperatorReview` is a boolean convenience, not an original-input type guard. Signing or authenticating a denial does not approve it, and a valid signature is not a ledger grant or Git ref update.

`stageGitChangeForReview` returns the exact Git-generated staged binary diff alongside the same metadata returned by `stageGitChangeProposal`. This lets an operator inspect the computed effect instead of relying only on the agent's submitted patch. The diff is transient untrusted source content; the staged metadata and signed decision retain digests, not the diff bytes.

The signature proves possession of an authorized key, not human presence or actual inspection. The host must protect configuration, its approval database and private keys, use a deployment-specific audience, and recheck current key/permission state. Replay protection is a ledger concern, not a property of signing alone. See the [threat model](THREAT_MODEL.md) for the host/process/clock and promotion boundaries.

## Plan-bound authenticated review workflow

`prepareGitOperatorReviewFromPlan` derives current persisted-plan authority, stages once, and rederives authority before returning a deterministic review request and transient diff bytes. The request contains the proposal, authority, staged manifest and their digests, but no raw patch, signing key or preparation timestamp. A signer can regenerate and compare the complete request before inspecting the effect.

`applyGitOperatorReviewFromPlan` imports a signed decision using owned proposal/patch/review snapshots. It authenticates before expensive staging, compares the fresh effect with the signed digest, and rederives authority after staging. The approval store reauthenticates current trust and time inside a short SQLite transaction before recording anything. An approval's expiry is exactly the signed expiry; the caller cannot extend it independently.

The first accepted decision wins for one proposal in one approval database. An `approve` inserts its approval and signed evidence atomically. A `deny` inserts a permanent tombstone without an approval. Repeated, conflicting or replayed decisions are rejected, including across processes and restarts. An existing legacy or revoked approval cannot acquire signed evidence retroactively. A denial is an initial refusal, not a post-approval revocation request: trusted-host `revoke` remains separate. Renewal requires a new proposal and a fresh signed decision.

`matchesOperatorReviewedGitApprovalFromPlan` reads linked proof from the ledger, checks its columns and exact approval/digest/expiry bindings, authenticates against current host trust, and re-stages the patch. It then rereads evidence and rederives authority before returning true. Missing, altered or swapped evidence, legacy grants without linked proof, expired or revoked grants, policy/workspace drift and removed/disabled/narrowed keys fail closed. This is a repeatable fresh observation, not a reservation or an atomic promotion gate.

The [operator review guide](GIT_OPERATOR_REVIEW.md) documents the separate host-only prepare/sign/import/check/revoke CLI, strict public configuration, protected-key handling and lossless untrusted-diff display.

## Host-side approval ledger

`SqliteGitApprovalStore.grant` re-stages the exact patch before writing one durable approval per proposal. The trusted host must supply an authority binding from its repository configuration and persisted action/policy state, plus the digest of the staged effect actually reviewed by the operator. Granting fails if either differs from the fresh observation. The approval expires no later than the proposal and host authority. `matchesActiveApproval` re-stages and checks the authority, effect, expiry, and ledger state before and after staging. `revoke` persists a revocation; a revoked proposal cannot be re-granted under the same proposal ID.

The approval API is a **host-side library boundary**, not an MCP tool. Legacy `grant`/`grantGitChangeFromPlan` remain trusted-host primitives and do not authenticate an operator; they refuse proposals already carrying a signed decision. Use the authenticated review import/check path when reviewer-key evidence is required. The host must protect SQLite write access, derive authority from the persisted plan and current operator configuration, and present the patch and staged manifest for review. The library cannot prove the reviewer is human or that an injected host configuration is genuine. Signed review evidence is not a portable promotion receipt, and a caller with write access to the database can forge or alter ledger state. Place the database outside the watched Git worktree.

## Trust and limits

- The workspace fields are observed through local Git commands. In a bare proposal, `repositoryId`, `actionId`, `policyDigest`, path scope, and patch bytes remain caller inputs. The plan-binding helper checks them against a host-owned persisted plan, catalog, policy, and repository configuration. The signed-review path authenticates an authorized configured key and exact decision, not the provenance of host configuration or human identity/presence.
- `verifyGitChangeProposal` checks the proposal's digest, **not** a signature. Anyone who can rewrite a proposal can compute a new digest.
- The proposal alone hashes the patch without parsing it. `stageGitChangeProposal` checks the exact patch bytes, expiry, and worktree witness; clones into a temporary directory; applies the patch to that clone's index; then reads Git's NUL-delimited raw diff. It rejects an empty or malformed effect, a path outside `allowedPaths`, and symlink, submodule, or other non-regular file modes. A rename requires both old and new paths in scope.
- The staged result records the candidate tree OID, exact changed paths, and digest of Git's staged diff. It is an ephemeral computation, **not** an approval, signature, durable receipt, or object installed in the protected repository. The temporary clone and its objects are deleted when the call returns.
- Git's clean status excludes ignored files, and the observation does not cover process, network, credential, or other external effects. Root-path hashing binds this local worktree but is not a portable proof of repository ownership.
- The pre/post worktree and ledger checks do not eliminate a race or ABA change between observations. There is no atomic approval/revocation check with a compare-and-swap ref update yet. Do not describe a proposal, staged result, or approval match as an authorized code change or effect-confinement receipt.

The next slice must design a safe compare-and-swap promotion using a fresh authenticated review and serialized revocation, without writing a checked-out branch behind its worktree. Current review checks are not reservations or promotion gates. See the [roadmap](ROADMAP.md).
