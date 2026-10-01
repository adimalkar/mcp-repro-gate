# Authenticated Git Operator Review Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement and review this plan task-by-task.

**Goal:** Authenticate an out-of-band, authorized-key decision about an exact staged Git effect and durably bind it to a plan-bound approval, without promoting a Git ref.

**Architecture:** Reuse persisted-plan authority derivation and the isolated Git staging/SQLite approval primitives from PR #14. Add a domain-separated Ed25519 review contract, a host-owned key/permission allowlist, a same-database first-decision ledger, and a separate host-only CLI/configuration path. Keep existing proposals, staging digests, legacy approval APIs, Phase 2 CLI, and MCP tool listings compatible.

**Tech Stack:** TypeScript/NodeNext, Node >=22.13 crypto/SQLite/fs, existing zod/AJV, node:test, Git subprocesses. No new dependencies.

**Feature proposal:** https://github.com/adimalkar/mcp-repro-gate/issues/19

**Stack:** Implementation started on PR #14 (`feat/phase3-trusted-plan-binding`). That prerequisite has now merged; `feat/phase3-authenticated-git-review` was reconciled with main without changing its reviewed file tree and will target main. Further dependent work should target its immediate open prerequisite PR. Do not merge automatically or force-push prerequisite branches. Repo permits squash/rebase merges, not merge commits: descendants may require ancestry-only reconciliation after squash merges.

## Acceptance criteria and trust limits

- Strictly parse a versioned, bounded signed review; reject extra fields, malformed digests/signatures/times, wrong algorithm/version/key/audience/operator/permission and temporal inconsistency.
- Authenticate only with configured public keys and exact repository/worktree-root/destination-ref permissions. Recompute key fingerprints; reject ambiguous operator/key declarations. Never trust identity, keys, permissions, or an authenticated flag from proposals/review artifacts.
- Show the exact freshly Git-generated staged diff plus manifest/authority/repository/ref/base/expiry before signing. Escape controls and preserve all bytes; never silently truncate. Load a protected private-key file only after all staging operations needed for review have finished. No signing secrets in argv, environment, logs, artifacts or SQLite.
- Reuse current plan/catalog/policy/witness derivation; rederive and revalidate after staging and immediately before recording. Signed expiry is the approval expiry, bounded by proposal/plan expiry and host TTL; no caller extension.
- First accepted decision wins per proposal/database: approve atomically inserts approval plus signed evidence; deny persists a tombstone without approval. Duplicate/conflicting/replayed decisions and retroactive authentication of a legacy approval fail. Deny is not signed revocation; trusted host `revoke` remains separate.
- Authenticated matching loads linked durable signed evidence, revalidates current keys/permissions and exact bindings, checks fresh staging/approval state, then rereads evidence and rederives authority before returning true. Legacy approval without valid evidence cannot pass; missing/altered/swapped evidence, expiry, drift, disabling/removing a key and ledger revocation fail closed.
- Preserve protected repository HEAD/ref/index/worktree during every operation.
- Do not claim human presence/inspection, OS confinement, global replay protection, atomic promotion/reservation, or a promotion receipt. Host configuration/DB/process/key protection and clock remain trusted. Existing legacy APIs are host-only primitives, not equivalent to the authenticated path.

## Task 1: Signed-review contract and exact staging inspection

**Files:** Create `src/git-operator-review.ts`, `schemas/git-operator-review.schema.json`, `tests/git-operator-review.test.ts`; modify `src/git-change-stage.ts`; add staging compatibility tests in `tests/git-change-stage.test.ts` only as necessary. Do not modify ledger/CLI/docs/exports yet.

**Payload contract:**

```ts
interface GitOperatorReviewPayloadV1 {
  reviewVersion: 1;
  audience: string;
  operatorId: string;
  keyId: Digest; // SHA-256 of Ed25519 public SPKI DER
  decision: "approve" | "deny";
  proposalId: Digest;
  authorityDigest: Digest;
  effectDigest: Digest;
  issuedAt: string;
  expiresAt: string;
}
interface GitOperatorReviewV1 {
  payload: GitOperatorReviewPayloadV1;
  signature: { algorithm: "ed25519"; value: string };
}
interface GitOperatorReviewTrustV1 {
  audience: string;
  maxReviewTtlMs: number;
  operators: Array<{
    operatorId: string;
    enabled: boolean;
    keys: Array<{ keyId: Digest; publicKeyPem: string; enabled: boolean }>;
    permissions: Array<{
      repositoryId: string;
      workspaceRootDigest: Digest;
      destinationRef: string;
    }>;
  }>;
}
```

Sign the UTF-8 domain `ReproGate/GitOperatorReview/v1`, followed by one NUL byte and `canonicalJson(payload)`, with Ed25519. `reviewDigest` is SHA-256 of those domain-separated payload bytes. Signature must be canonical unpadded base64url representing exactly 64 bytes. Keys must be Ed25519; trust PEMs must be public-only SPKI, never private-key material. Public helper names: `gitOperatorKeyId`, `gitOperatorReviewDigest`, `signGitOperatorReview`, `authenticateGitOperatorReview`, `verifyGitOperatorReview` and strict parsing/trust-validation helpers where needed.

Verification uses `verifyGitOperatorReview(review, proposal, authority, expectedEffectDigest, hostTrust): boolean`. Decision-making and persistence must instead consume `authenticateGitOperatorReview` with the same arguments, returning the newly parsed, fully authenticated snapshot (frozen at top level, payload and signature) or undefined. Never narrow or reread the original unknown input as authenticated: an accessor can yield signed deny during verification and unsigned approve afterward. Require canonical UTC `toISOString()` representation, `proposal.createdAt <= issuedAt <= now < expiresAt`, expiry <= proposal/authority expiry, and lifetime <= maxReviewTtlMs. No externally supplied time override in the CLI. Do not equate signing with permission verification. A preliminary parsed snapshot can safely supply the claimed effect digest before expensive staging, but reauthenticate against the actual staged digest before recording.

Add `stageGitChangeForReview(proposal, repositoryPath, patch)` returning `{ staged: StagedGitChangeV1, stagedPatch: Uint8Array }` from one isolated staging pass. The old `stageGitChangeProposal` must return the same metadata/digest as before. Its clone cleanup and protected-repo invariants remain.

**TDD:** Write protocol/compatibility tests, run failing targeted build/tests, implement, then run `npm run check`. Cover every signed field mutation, malformed signatures/times/extra fields, wrong/disabled keys, audience/operator/root/ref permissions, TTL boundaries, Ed25519 key ID agreement, and exact staged-patch digest equality. AJV schema acceptance/rejection must agree with runtime structural validation.

**Review gate:** Specification review first, then independent code/security quality review. Fix important findings before Task 2; no self-review substitution.

## Task 2: Atomic decision evidence and plan-bound authenticated APIs

**Files:** Modify `src/git-approval-store.ts`; create `src/git-operator-review-plan.ts`, `tests/git-operator-review-plan.test.ts` and targeted subprocess fixtures if useful. Do not modify CLI/docs/exports yet.

Add a companion decision table in the same DB, with unique proposal ID and review digest, complete signed envelope, decision, nullable unique approval ID and received-at timestamp. Atomic approve/evidence insertion and denial tombstones; do not hold the SQLite write lock while cloning/staging Git. Refactor internal approval insert/construction only as required; preserve `GitChangeApprovalV1` and legacy signatures. Reject existing legacy grants rather than attaching signed evidence to them. Legacy grant should also respect a recorded denial/decision so host primitives cannot casually reverse first-decision semantics. Authentication must happen before expensive staging; post-staging authority/key/time checks must occur immediately before insertion. Any rollback must leave neither an orphan approval nor evidence.

Host APIs:

- `prepareGitOperatorReviewFromPlan({ proposal, patch, context })` returns `{ request, stagedPatch }`, where request contains `requestVersion: 1`, proposal, authority, staged manifest, authorityDigest and effectDigest. Request contains no raw patch/private key/volatile timestamp.
- `applyGitOperatorReviewFromPlan(store, { proposal, patch, context, trust, review })` verifies signature/current permission, stages freshly, rederives authority and revalidates before atomically recording approve/deny. Return the decision/review digest and approval only for approve; use signed expiry.
- `matchesOperatorReviewedGitApprovalFromPlan(store, { approvalId, proposal, patch, context, trust })` loads proof from the store (not caller-supplied evidence), verifies linkage/current trust, uses existing active-approval fresh staging semantics, then rereads/rederives/rechecks before returning true.

Store method names may be chosen to keep responsibilities clear; they must not provide a public attach-evidence-to-existing-approval operation. A mandatory post-staging revalidation callback used only by the real plan-bound wrapper is acceptable if needed; keep the trusted-host boundary explicit and no generic speculative hooks.

**TDD:** Real Git/SQLite/key fixtures for approve, deny, replay/restart, revocation, legacy rejection, missing/altered/swapped evidence, policy/catalog/plan/workspace/ref drift, key removal/narrowing, expired-during-stage decisions, transaction rollback, and concurrent approve/approve plus approve/deny imports. Assert table cardinalities and protected HEAD/index/worktree remain unchanged. Use generous fixture expiry to avoid Windows timing flakes.

**Review gate:** Specification review, then independent security/quality review before Task 3.

## Task 3: Host-only Git-review configuration and complete CLI

**Files:** Create `src/git-review-config.ts`, `src/git-review-cli.ts`, `schemas/git-review-config.schema.json`, `tests/git-review-cli.test.ts`; modify `src/cli.ts` for a narrow `git-review` dispatch and `src/index.ts` for exports. Read actual Task 1/2 exported APIs before implementing.

Separate strict `GitReviewConfigV1`: configVersion, repositoryPath, repositoryId, destinationRef, planDatabasePath, approvalDatabasePath, catalogTool, currentPolicy and trust. Bound config reads to 1 MiB using one regular-file descriptor; require absolute repository/DB paths, DB files outside protected worktree, current valid public trust configuration, supported catalog/policy fields. Do not call `createConfiguredRuntime` or demand Phase 2 backend/HMAC configuration. Do not persist private keys or require signing-key environment variables.

Subcommands, exact options to document after implementation:

- `git-review prepare --config ... --proposal ... --patch ...` -> bounded review-request JSON stdout (metadata only).
- `git-review sign --config ... --proposal ... --patch ... --request ... --operator ... --key-file ... --decision approve|deny --expires-at ...` -> recompute/compare prepared request, render full safe diff/metadata to stderr, load the private key last, build and validate the signed decision, JSON stdout. Explicit decision required; no default approve. This may be automated by an authorized signer; it is not proof of a human UI.
- `git-review import --config ... --proposal ... --patch ... --review ...` -> apply authenticated decision, JSON result.
- `git-review check --config ... --proposal ... --patch ... --approval-id ...` -> JSON `{ valid }`, failure exit code when false.
- `git-review revoke --config ... --approval-id ...` -> trusted-host durable revocation, no signing key necessary.

Every input is bounded/validated; usage errors are fail closed. Re-read the host configuration at post-staging and final decision/check boundaries and fail if its canonical digest differs from the operation's initial snapshot, including database paths, trust, catalog and policy. A plan-store read adapter can enforce that invariant when the real plan-bound helper rederives authority; do not silently continue with a stale file snapshot. Private-key read/parse/sign errors must not expose bytes. Safely escape terminal C0/C1/bidi controls in all displayed untrusted values, and use a lossless representation for non-UTF8/binary staged diff bytes. Clearly delimit the diff as untrusted content; no silent truncation. Preserve all old CLI commands and MCP tool lists.

**TDD/E2E:** Actual subprocess prepare/sign/import/check/revoke with persistent plans and Ed25519 test key files; prove stdout is parseable JSON and private material absent from stdout/stderr/SQLite. Test denied/replayed/tampered reviews, stale prepared request, missing explicit decision, bad config/unsafe DB paths, invalid key file without byte disclosure, terminal controls/binary diff, and protected Git invariants.

**Review gate:** Spec first, independent security/quality review second.

## Task 4: Documentation and stacked-PR CI

**Files:** Modify README, `docs/GIT_CHANGE_PROPOSAL.md`, `docs/THREAT_MODEL.md`, `docs/ROADMAP.md`, `docs/IMPROVEMENTS.md`; optionally add a focused configuration example/document. Modify only pull-request base branch filters in `.github/workflows/ci.yml`, `codeql.yml`, `dependency-review.yml` to `[main, "feat/**"]`; leave push triggers, permissions, pinned action SHAs and release policy untouched.

Describe the actual commands/config/API contracts, first-decision/denial/revocation semantics, durable proof linkage, key rotation/current-trust checks, compatibility with legacy host primitives, and all known trust/race/coverage limits. Mark only truly delivered backlog items complete; atomic promotion and signed promotion bundles remain pending. Explain stack order and post-squash reconciliation.

**Verification:** `npm run check`, `npm audit --audit-level=high`, `npm run pack:check`, `git diff --check`. Parent independently reruns full suite and exercises the CLI, reviews package/schema contents, then commits/pushes and opens a PR targeting the live prerequisite branch (or reconciled main if #14 has merged). Read back exact PR head/base/body and all CI, including Windows/macOS/Linux and CodeQL/Dependency Review. Do not infer CI success from old or workflow-dispatch runs.

## Workflow gates

- Pre-flight: feature proposal exists, clean isolated worktree, parent tree/context understood, tests reproduce failures. Missing preconditions block entry.
- Revision: spec and quality/security reviews, bounded to three meaningful iterations; findings must decrease, otherwise escalate.
- Escalation: unresolved security/design trade-offs, failed review convergence, unexpected parent changes that alter implementation.
- Abort: unsafe secret exposure, writes outside authorized worktrees, or unavailable verification path; preserve evidence and report rather than fabricate results.
