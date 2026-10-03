# Journaled authenticated Git promotion implementation plan

> **For Hermes:** Use subagent-driven-development, with specification then independent security/quality review after each task. Preserve unrelated user changes.

**Goal:** One-use, operator-reviewed Git compare-and-swap promotion to a non-checked-out destination, with serialized revocation and conservative crash recovery.

**Architecture:** Introduce explicit V2 workspace/proposal contracts while retaining V1 behavior. Reuse isolated staging to materialize exactly reviewed objects. Persist a one-use attempt in the existing approval database before the Git write. Hold a persistent host ownership fence and ledger write transaction for final authorization/CAS; ambiguous interrupted effects remain indeterminate.

**Tech stack:** Existing TypeScript/NodeNext, Node >=22.13 crypto/fs/SQLite, zod/AJV/node:test and Git. No new dependencies by default. Local supported interpreter is /home/aditya/.hermes/node/bin/node (22.23.2); CI includes Node24 on Linux/macOS/Windows.

**Proposal/base:** https://github.com/adimalkar/mcp-repro-gate/issues/21. Main fde471f4931d8d497b2bda3910ebf5e321f11d39 after merged #20. Durable worktree: /mnt/1TB_Drive/Data/MyFiles/Projects/.reprogate-worktrees/git-promotion, branch feat/phase3-journaled-git-promotion. The previous scratch worktree was pruned after a rate-limited implementer stopped; its uncommitted prototype is not treated as completed work. Baseline111 tests and audit independently passed again. Target current main unless an immediate open prerequisite requires stacking; do not auto-merge or force-push other branches.

## Contracts and claim limits

- V1 constructor/schema/checked-out-destination behavior remains unchanged. Never upgrade or reinterpret an old V1 approval into promotion compatibility.
- Add V2 intent/proposal/workspace/request. Source HEAD must be symbolic; destination must be an existing direct refs/heads branch at the same base commit, different from source headRef and not checked out in any registered worktree. Bind canonical root/common-directory digests, source headRef/commit/tree and destination ref/OID.
- OperatorReviewV1 signature domain/payload, ApprovalV1 and StagedGitChangeV1 stay unchanged: proposal/action/effect digests bind V2 transitively. Strict parsing and schema dispatch must agree.
- Reuse the same private patch staging interpreter. Materialize only the exact candidate tree/one-parent commit in the target object store; source HEAD/index/worktree and unrelated refs stay unchanged. Object/scratch/reflog writes and possible orphan objects are explicit effects.
- All cooperating promotion/revocation/checkout/worktree/config/plan/key writers share a persistent host-owned repository fence and approval ledger. Fence survives worker death, never auto-steals on PID/time, and is released only after writer quiescence. Recovery requires explicit trusted-host stopping/reaping of possible orphan Git subprocesses.
- Expiry is the deadline for admitting the bounded operation at the final gate, not an atomic clock test inside Git CAS. Record authorizationCheckedAt independently of completion.
- A reserved approval is permanently consumed, including failed or ambiguous attempts. Raw revocation cannot bypass unresolved/non-quiescent promotion fencing.
- Git/SQLite are not a distributed atomic transaction. Recovery never retries, clears consumption, rolls back or overwrites refs, or infers verified historical authorization from candidate/old/newer ref equality. ABA observations remain unknown.
- Git-ref-scoped claim only under trusted host/config/ledger/process/key/clock/repository ownership. No human-presence/inspection, OS confinement, global replay protection, compromised-host repair or portable signed promotion receipt.

## Task 1 — V2 witness and exact review compatibility

**Files:** Modify src/git-change-proposal.ts, src/git-plan-binding.ts, src/git-change-stage.ts, src/git-approval-store.ts, src/git-operator-review.ts and src/git-operator-review-plan.ts for shared strict parsing/type/version dispatch only. Optionally create src/git-change-contract.ts. Add schemas/git-change-proposal-v2.schema.json and tests/git-change-proposal-v2.test.ts plus narrow existing-test coverage. Do not modify config/CLI/exports/other docs or implement ref/object writes, fencing or journal yet.

Preserve existing constructor return types and defaults. Add observeGitPromotionWorkspace, createGitChangeIntentV2, createGitChangeProposalV2 and explicit GitWorkspaceWitness/GitChangeIntent/GitChangeProposal union aliases. V2 workspace fields:

    workspaceVersion: 2
    source: git_observed
    destinationMode: uncheckout_destination
    rootDigest, commonDirDigest: Digest
    headRef, headCommit, headTree, destinationRef, destinationOid: string
    status: clean

V2 intent/proposal version literals are2; otherwise same fields as V1 with V2 workspace. Observe actual root identity, clean tracked/untracked status, source symbolic HEAD, direct destination, equality to source base and all registered worktrees with bounded porcelain-NUL parsing. Repeat observations consistently; reject nested/bare/detached/symbolic/checked-out destinations, moved/unequal refs and source/common/root drift. V2 uses native physical paths; preserve old V1 root digest conventions. Sanitize inherited Git redirects.

Strict union parsing consumes unknown values once into owned snapshots, rejects cross-version/mixed/missing/extra fields and preserves actual existing identity/ref/digest/OID/canonical-time checks. Shared observer dispatch reconstructs the exact versioned witness in staging/current-match/plan binding, not an unbound boolean bypass. gitChangeIntentFromProposal preserves correct version for exact persisted arguments digests. prepareGitOperatorReviewFromPlan returns RequestV2(requestVersion2/proposalV2) for V2 and RequestV1 for V1, using overloads where necessary to preserve legacy CLI typing. All other request/staging/approval/signature fields unchanged.

**TDD:** Write failing new constructor/witness/schema tests, compile/run and record red before implementation. Real Git reviewer and distinct target branch at equal base; complete source HEAD/index/worktree/ref snapshots; linked target checkout, symbolic target, detached/nested/bare/dirty source, source headRef/common/root/ref drift, inherited Git environment, SHA256 objects if supported. Real persisted SQLite plan + Ed25519 prepare/sign/import/check library round trip for V2; field/version/getter/alias mutations and schema/runtime agreement. Old V1 rejection behavior and schema bytes unchanged. Close SQLite before cleanup and use native canonical fixture paths. Run full check, audit and diff check.

**Gate:** Independent spec PASS then security/quality APPROVED; parent reruns and commits before Task2.

## Task 2 — Hardened Git runner and candidate objects

**Files:** Shared src/git-change-stage.ts; new src/git-runner.ts, src/git-promotion-objects.ts and tests/git-promotion-objects.test.ts; narrow observation/runner regressions. No journal/CLI/fence effects yet.

Before clone cleanup, materialize a bounded commit using fixed host-owned author/committer/message, trusted timestamp and fresh attempt UUID; hash-object -t commit -w --stdin avoids commit hooks. Exact reviewed tree and sole parent expected-old destination OID. Pack candidate closure excluding base; import index-pack --stdin --strict; verify raw commit/tree/parent/diff against approved staging result. Bound pack/output16MiB and command15s unless actual tests justify a change; never truncate. Output limits do not bound clone disk growth, which is a separate trusted-host budget.

Clear GIT_* and disable fsmonitor, replacement objects, configured hooks/upload-pack pack hooks, maintenance, external diff/textconv and unintended transport; allow only required local file cloning. Use portable trusted empty hook directory, no shell. Harden existing clone path as well. Do not retain private data/raw diagnostics in public evidence.

**TDD/gates:** Missing candidate -> exact installed object closure, no refs/source-state changes; binary/mode/rename/out-of-scope/large-object pack cap, hostile hooks/config/environment, cleanup. Legacy staging digests preserved. Spec then security, independent parent tests and commit.

## Task 3 — Ownership fence, one-use journal and final promotion gate

**Files:** New src/git-promotion-contract.ts, src/git-promotion-host-control.ts, src/git-promotion-plan.ts; additive src/git-approval-store.ts machinery; schemas/git-promotion-attempt.schema.json; tests/git-promotion-host-control.test.ts, tests/git-promotion-plan.test.ts and compiled tests/fixtures/git-promotion-worker.ts.

Persistent exclusive directory latch outside all protected roots, bounded owner/token record, safe physical aliases/permissions, no PID/timeout stealing. Current-user private POSIX ownership; explicit Windows ACL deployment responsibility. Release only exact token after child quiescence; retain on ambiguous dispatch. One repo common-dir/ledger/fence mapping is an explicit deployment assumption.

Same approval database STRICT table: attemptId PK, permanent unique approvalId/proposal linkage, immutable review/authority/effect/root/common/ref/base/candidate/commit-metadata/fence bindings and timestamps. State prepared|confirmed|failed|indeterminate; outcome reason, admission context/time, completion/quiescence and bounded ref observations. Cross-column constraints/canonical record parsing, no raw patch/key/diagnostics. synchronous=FULL for pre-dispatch durable reservation. No arbitrary execute-under-approval callback API.

Preauthenticate/derive, stage/import outside SQLite lock. Acquire fence. T1 BEGIN IMMEDIATE: revalidate linked active proof, insert unique prepared intent/consumption, COMMIT. T2 BEGIN IMMEDIATE and fence: reread intent/proof; rederive current plan/catalog/policy; authenticate key/audience/permission/signature/expiry admission; exact candidate tree/parent/effect; V2 workspace/direct ref/worktree list; config/path/fence freshness. Then bounded update-ref --no-deref destination candidate expectedOld. Definite success plus exact ref/object/source-state readback -> confirmed and COMMIT; release after reaping. Final-gate rejection before dispatch -> failed/consumed. Uncertain dispatched result/readback/completion commit never returns confirmed, keeps durable prepared/indeterminate and fence for recovery.

Raw revoke must refuse unresolved non-quiescent attempts; V2 ownership-aware revoke takes the fence before the same ledger write lock. Recovery requires explicit host quiescence, leaves permanent consumption, never mutates refs/retries, and conservatively marks interrupted prepared state indeterminate. Confirmed response-loss/status is idempotent; terminal records don't get rewritten from present-ref guesses.

**TDD/gates:** Signed exact real Git/SQLite/key fixtures; legacy/deny/revoked/expired/drift/cross-version/mutated journal/proof/input rejection; competing promotion, checked-out refs in any worktree, stale CAS; revoke-before/after gate; SQL triggers/commit failures; hard kills at each durable boundary, live orphan updater fence, response loss, ABA/newer/old ref recovery. Spec then security; parent full tests and actual pipeline smoke before commit.

## Task 4 — V2 host config/CLI, documentation and publication

**Files:** src/git-review-config.ts, src/git-review-cli.ts, src/cli.ts, src/index.ts; schemas/git-review-config-v2.schema.json; tests/git-promotion-cli.test.ts; README, Git contracts/operator guide, threat model, roadmap/backlog and docs/GIT_PROMOTION.md.

V2 config literal2, explicit uncheckout_destination mode and ownership {kind:persistent_directory,fencePath:absolute}; strict legacy fields/trust/catalog/policy reused and fenced/state paths canonically outside all protected metadata. V1 cannot promote. Existing review commands stay compatible; V2 ownership-aware revoke. Add host-only git-review promote --config --proposal --patch --approval-id; status --config --attempt-id; recover --config --attempt-id --confirm-quiescent (explicit boolean flag, duplicates/unknown rejected). Preserve signing-key-last/no-Git-after-key/no-secret-output rules. No new default MCP promotion tool.

Document precise statuses/exit codes, admission expiry, fence and all writer/checkout/config/key cooperation, quiescence assertion responsibility, one-use failure policy, actual object/ref effects, pack/disk bounds and V1/V2 migration. Portable signatures/receipts and broader OS enforcement remain pending.

**Verify/publish:** Full check/audit/package/diff; real CLI V1/V2 round trips/races/hard-kill/recovery plus independent spec/security/final integration gates. Parent commits/pushes with correct upstream, opens PR against live main/immediate prerequisite, reads back exact head/base/body, verifies every Linux22/24/macOS/Windows/CodeQL/dependency check and leaves it open.

## Recovery and execution discipline

Source worktrees/plans must remain outside scratch retention cleanup. Temporary fixtures/probes remain under Hermes scratch. Save worker prompts/results and completed task commits durably. Do not treat an interrupted/rate-limited child's partial files or summary as verified completion. Do not skip spec/security gates or claim CI from a different head. Any missing ownership/quiescence assumption or claim requiring atomic external expiry-at-Git-write blocks escalation; no fabricated output or unsafe automatic retry.
