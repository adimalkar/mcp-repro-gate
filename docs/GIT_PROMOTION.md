# Promoting a reviewed Git change

This guide covers the host-only `git-review` promotion commands. They move one destination branch to the exact commit an operator approved, at most once per approval, after a fresh check at the promotion boundary. The [promotion journal](GIT_PROMOTION_JOURNAL.md) describes the underlying gate, its records and its guarantees. There is no MCP promotion tool: an agent can propose and plan, but only the trusted host promotes.

## What you need

- **A version 2 proposal.** Its destination is an existing local branch at the same commit as the source HEAD, and that branch is not checked out in any worktree. The host creates the plan and proposal with `createGitChangeIntentV2` and `createGitChangeProposalV2`, as in the [persisted-plan binding](GIT_CHANGE_PROPOSAL.md#bind-a-git-proposal-to-a-persisted-plan).
- **An imported, signed approval** for that proposal, from the usual [operator review](GIT_OPERATOR_REVIEW.md) flow: `prepare`, `sign`, `import`. Those commands accept version 2 proposals under a version 2 configuration.
- **Private host state.** On POSIX, the fence's parent directory and the directories holding the approval database, the plan database and the config file must be owned by the current user with mode `0700`. Those files, and any SQLite sidecars, must be single-link regular files with mode `0600`. The fence checks these on every use and never repairs them. On Windows, deploy equivalent private ACLs yourself.
- **Cooperating writers.** Every process that promotes, revokes, checks out branches, adds worktrees, or edits configuration, plans or keys for this repository must use the same fence and approval ledger. The fence is a cooperative latch, not an OS sandbox.

## Version 2 configuration

Git Review Configuration v2 adds two fields to every version 1 field ([schema](../schemas/git-review-config-v2.schema.json)):

```json
{
  "configVersion": 2,
  "destinationMode": "uncheckout_destination",
  "ownership": {
    "kind": "persistent_directory",
    "fencePath": "/trusted/reprogate/fence"
  }
}
```

`fencePath` is absolute and names the latch directory itself, which must not exist while nothing is promoting. It must be outside the repository and its Git metadata, and separate from both databases and their sidecars. A version 1 configuration keeps its exact behavior and cannot promote. Each configuration version accepts only proposals of the same version.

## Commands

```bash
node dist/src/cli.js git-review promote --config /trusted/review.json --proposal proposal.json --patch change.patch --approval-id <approval-id>
node dist/src/cli.js git-review status  --config /trusted/review.json --attempt-id <attempt-id>
node dist/src/cli.js git-review resume  --config /trusted/review.json --attempt-id <attempt-id>
node dist/src/cli.js git-review recover --config /trusted/review.json --attempt-id <attempt-id> --confirm-quiescent
```

- **`promote`** acquires the fence for a fresh attempt ID, prepares the candidate objects, reserves the approval, and runs the final gate. It prints a JSON summary: `attemptId`, `state`, `reason`, `fence`, the destination, the expected old and candidate commits, and the observed destination. If it stops before the reservation is recorded, it releases the fence and the approval is not consumed. Any later error names the attempt ID.
- **`status`** prints the strict readback of the attempt, its admission and its outcome, or `{"found":false}`.
- **`resume`** runs the gate again for an attempt that is still `prepared`, for example after a moved destination is restored. The fence must still be held by that attempt's own owner. An admitted or resolved attempt is refused.
- **`recover`** is for after a crash or an `indeterminate` result. `--confirm-quiescent` states that you have stopped or reaped every process that might still be promoting; it is your assertion, not something the tool can prove.
  - An admitted attempt with no outcome becomes `indeterminate`.
  - A reserved attempt that was never admitted becomes `failed` (`abandoned`).
  - An existing outcome is kept.
  - The fence is released if the attempt's owner still holds it.
  - A fence acquired for an attempt that was never reserved is released, and the command reports `"state":"unreserved"`.
  - Recovery never moves, restores or overwrites refs.

| Command             | Exit 0        | Exit 1                                  | Exit 2 |
| ------------------- | ------------- | --------------------------------------- | ------ |
| `promote`, `resume` | `confirmed`   | `failed`, `indeterminate`, or any error | usage  |
| `status`            | attempt found | unknown attempt or error                | usage  |
| `recover`           | completed     | error                                   | usage  |

## Reading outcomes

| State           | Meaning                                                                                                           | Fence                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `confirmed`     | The destination moved from the expected old commit to the candidate, and the readback was exact.                  | released                 |
| `failed`        | Rejected at the gate before any Git write, or abandoned by recovery. The approval stays consumed.                 | released                 |
| `indeterminate` | The write was admitted, but its effect is not proven: a lost compare-and-swap, an error, or a non-exact readback. | retained until `recover` |
| `prepared`      | Reserved but not resolved: a precheck rejected it, or it was interrupted.                                         | held by the attempt      |

A `failed` or `indeterminate` attempt cannot be retried, so get a new approval for a new proposal. After an `indeterminate` result, inspect the destination yourself. The recorded `observedDestinationOid` is an observation, not proof of who moved the ref.

## Effects and limits

- A confirmed promotion moves only the destination ref and appends a reflog entry `reprogate promotion <attemptId>`. Candidate preparation can leave unreachable objects. Source HEAD, index and worktree are not written.
- Expiry bounds admission, not the instant of the ref write. Git and SQLite are not one atomic transaction.
- The claim is scoped to the Git ref, under trusted host configuration, ledger, process, key and clock, and cooperating fence ownership. See the [threat model](THREAT_MODEL.md#final-git-promotion-gate-boundary).
- Portable signed promotion receipts and offline verification are future work.
