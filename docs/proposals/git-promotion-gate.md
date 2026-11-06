# Final Git promotion gate: admission, compare-and-swap and recovery

Status: proposed implementation. This is the second half of Task 3 in the [journaled promotion plan](../plans/journaled-git-promotion.md), tracked by issue #21. Reservation (#23) durably consumes one linked signed approval as a `prepared` attempt. Nothing yet moves the destination ref, records an outcome, or recovers an interrupted attempt. The promotion CLI (Task 4) is a separate later slice.

## Problem

A `prepared` record says that an approval is consumed. It does not say whether a ref update was ever dispatched. If the gate dispatched `update-ref` and its process died, a later call could not tell "never dispatched" from "dispatched, outcome unknown". A retry would then observe the moved ref as drift and record a false `failed` outcome, or update the ref twice. The gate therefore needs a durable admission record that is committed **before** any Git write.

## Deliverable

`SqliteGitApprovalStore` gains three host-only methods. None of them is an MCP tool.

- **`promoteGitPromotionAttempt`** takes the attempt ID, the live plan-binding context, operator trust, the host-control configuration and the exact fence owner.
  1. **Precheck, outside the SQLite lock.** It strictly reads back the attempt and requires that it has no admission and no outcome. The fence must be held by exactly the attempt's persisted owner. It verifies the installed candidate objects, rederives plan authority (which re-observes the V2 workspace) and checks the admission deadline. A precheck failure throws and records nothing. Nothing was dispatched, so the attempt can be retried.
  2. **Admission, under `BEGIN IMMEDIATE` and the fence.** It rereads the attempt, fence and ledger identity. It rederives plan, catalog and policy authority, which re-observes the source HEAD and tree, cleanliness, the destination ref and the worktree list. It authenticates the linked signed review under current trust and requires `now < admissionDeadline`. It reverifies the exact candidate commit, tree, parent and effect.
     - Any rejection here records a `failed` outcome with a stable reason code, commits, and releases the fence.
     - Otherwise it inserts an admission record (`admittedAt`, the authorization check time) and commits it with `synchronous=FULL`.
  3. **Dispatch.** In a new `BEGIN IMMEDIATE` transaction it runs `update-ref --no-deref <destination> <candidate> <expected-old>` through the hardened runner, then reads back the destination ref, source HEAD and worktree list.
     - Exit 0 with exact readback records `confirmed`, commits, and releases the fence.
     - Any dispatch error, non-exact readback or uncertain step records `indeterminate` and **keeps the fence**. A stale compare-and-swap is reported as `indeterminate` too, because the runner does not distinguish it from other nonzero exits.
     - If recording the outcome itself fails, the attempt stays admitted without an outcome, and the fence stays held.
- **`recoverGitPromotionAttempt`** requires an explicit `{ childrenQuiescent: true }` host assertion, made after stopping or reaping any possible promotion workers.
  - An attempt that was admitted but has no outcome becomes `indeterminate` (`interrupted`).
  - A prepared attempt that was never admitted becomes `failed` (`abandoned`). No dispatch can have happened, because dispatch always follows a durable admission.
  - An attempt that already has an outcome is left unchanged.
  - Recovery then releases the fence if it is still held by the attempt's own persisted owner. It never retries, rolls back or overwrites refs, and never clears consumption. It records the current destination OID only as an observation, never as evidence of authorization.
- **`getGitPromotionStatus`** returns the strict readback of the attempt plus its optional admission and outcome. It is an idempotent read, so a confirmed promotion whose response was lost still reads back as `confirmed`.

## Journal changes

The change is additive. The immutable `git_promotion_attempts` table and its guards stay as they are, and consumption stays permanent.

- `git_promotion_admissions`: one row per attempt, insert-only, linked by foreign key to the attempt.
- `git_promotion_outcomes`: one row per attempt, insert-only, holding the state (`confirmed`, `failed` or `indeterminate`), a reason code, the decision time, and the observed destination OID.
- SQL triggers reject:
  - updates and deletes on both tables;
  - a `confirmed` outcome without an admission, or whose observed OID is not the attempt's candidate commit;
  - a `failed` outcome after an admission.
- Strict canonical readback cross-checks every column binding. The new records get JSON Schemas.
- Raw revocation keeps refusing any approval with an attempt, including terminal ones.

## Claim limits

- The claim is scoped to the Git ref, under trusted host configuration, ledger, process, key, clock and cooperating fence ownership.
- Expiry is the deadline for admitting the attempt. It is not checked atomically inside Git's compare-and-swap.
- Git and SQLite do not form an atomic transaction: an interrupted dispatch stays `indeterminate`.
- Reflog entries and unreachable objects are documented effects.
- Out of scope: portable signed receipts, OS confinement, and a cancel path for an unadmitted attempt that keeps its fence.

## Verification

Real Git, SQLite and Ed25519 fixtures, for both SHA-1 and SHA-256 repositories:

- An exact promotion is confirmed. The ref moves to the candidate while source HEAD, index, worktree and other refs stay unchanged. The fence is released. A second promote is refused, and status reads back as `confirmed` after reopening the ledger.
- Precheck rejections record nothing: wrong fence owner or token, a different config, a destination moved or checked out in a linked worktree, a policy change, an expired admission.
- Rejections at the gate record `failed` and release the fence: a policy change injected after the precheck, and expiry at the exact deadline. (Ref and trust changes at the gate share the same checks but have no dedicated test.)
- A compare-and-swap that loses a race injected just before dispatch records `indeterminate` and retains the fence. Recovery then releases the fence and leaves the outcome unchanged.
- Hard-killed worker processes before and after admission recover to `failed` (`abandoned`) and `indeterminate` (`interrupted`), and an admitted attempt cannot be promoted again.
- The SQL guards reject updates, deletes, duplicates and the invalid outcome combinations above. Recovery without the quiescence assertion is rejected. Revocation stays refused.
- Full check, audit and package check; independent review before merge.

## Review

An independent review requested changes; none were HIGH.

- **Medium (fixed): durability.** Git's default does not sync refs or loose objects, so after a power loss the journal could say `confirmed` while the ref had reverted. Fix: the runner forces `core.fsync=committed,reference` and `core.fsyncMethod=fsync` on every command.
- **Medium (fixed): unbounded dispatch.** After admission only the fence was rechecked, so a stalled promoter could write after its deadline, or after recovery had concluded. Fix: dispatch re-reads the attempt under the fence and writes only with an admission, no outcome and time left before the deadline. A checked-out destination or a passed deadline records the new `indeterminate` reason `not_dispatched`.
- **Medium (fixed): tests.** New tests (`tests/git-promotion-dispatch.test.ts`) cover:
  - workers killed after `update-ref` and after the outcome;
  - two racing promoters;
  - an outcome committed by recovery during a stall;
  - an expired deadline or new checkout after admission;
  - a fence lost after admission;
  - a source moved during dispatch;
  - a failed outcome write;
  - a clock stepped back;
  - a transient ledger failure at the gate.

  Every guard the review mutated now fails a test. The one exception is the locked `assertUnresolved`, which the admission primary key backs up.

- **Low (fixed):**
  - transient Git or SQLite failures at the gate no longer record a rejection;
  - a destination checked out after admission is caught before dispatch;
  - `null` acknowledgements get the intended error;
  - the docs state the wall-clock and SQLite-busy limits.
