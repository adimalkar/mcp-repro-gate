# ADR 0004. Final Git authorization and revocation

## Decision

Keep a durable admission marker before starting a Git ref write. In the next SQLite writer transaction, reauthenticate the current plan, catalog, policy, signed approval, operator trust, workspace and installed candidate. Recheck fence ownership, destination occupancy and the deadline before starting the Git compare-and-swap. Hold the writer transaction through ref readback and outcome insertion. V2 revocation acquires the same repository fence and performs its guarded approval update under a writer transaction on the bound ledger.

## Timing and recovery

The admission marker allows crash recovery to treat a lost dispatch response as indeterminate. It remains durable if acquiring the dispatch lock or reading current state fails. A recorded veto after admission yields `indeterminate/not_dispatched` and retains the fence. Recovery requires the host to establish quiescence. Reservation permanently consumes the approval.

The original issue specified admission-only expiry. The subsequent gate review introduced a second expiry check to limit how long a stalled promoter can wait before launching Git. We retain that stricter rule. `admittedAt` records when the admission check succeeded. The dispatch transaction checks the trusted wall clock again. Git and SQLite have separate durability boundaries, and an external clock can advance between the final check and Git's write. [Original acceptance criteria](https://github.com/adimalkar/mcp-repro-gate/issues/21) · [Gate review](../proposals/git-promotion-gate.md) · [Journal protocol](../GIT_PROMOTION_JOURNAL.md)
