# Git promotion CLI and version 2 review configuration

Status: proposed implementation. This is Task 4 of the [journaled promotion plan](../plans/journaled-git-promotion.md), tracked by issue #21. It stacks on the final gate (#46). Today the gate is library-only, and the `git-review` CLI accepts only version 1 proposals, whose destination is the checked-out branch and which can never be promoted.

## Deliverable

### Git Review Configuration v2

```json
{
  "configVersion": 2,
  "destinationMode": "uncheckout_destination",
  "ownership": {
    "kind": "persistent_directory",
    "fencePath": "/trusted/reprogate/fence"
  },
  "...": "every version 1 field, unchanged"
}
```

- `fencePath` must be absolute. It names the persistent repository fence (the latch directory itself), and must be outside the protected repository and distinct from the plan and approval databases.
- The host fence enforces its own private-location rules on every use. On POSIX that means current-user `0700` parents and `0600` ledger and state files.
- Version 1 configurations keep their exact behavior and cannot promote.
- A version 2 configuration accepts only version 2 proposals; a version 1 configuration only version 1.
- A new [schema](../../schemas/git-review-config-v2.schema.json) describes version 2; the version 1 schema is unchanged.

### Commands

The existing commands (`prepare`, `sign`, `import`, `check`, `revoke`) work unchanged, and under a version 2 configuration they accept version 2 proposals. The new commands are host-only. There is still no MCP promotion tool.

- `git-review promote --config <v2> --proposal <p> --patch <patch> --approval-id <uuid>`:
  1. acquire the fence for a fresh attempt ID;
  2. prepare the candidate objects;
  3. reserve the approval;
  4. run the final gate.

  If anything fails before the reservation is recorded, the CLI releases the fence through a new library check (below); otherwise the fence follows the gate's rules. The output is a compact JSON summary, and the attempt ID is printed for every outcome.

- `git-review resume --config <v2> --attempt-id <uuid>` runs the final gate again for a prepared attempt whose precheck rejected it, for example after a moved destination was restored. The fence must still be held by the attempt's own owner.
- `git-review status --config <v2> --attempt-id <uuid>` prints the strict readback: attempt, admission and outcome.
- `git-review recover --config <v2> --attempt-id <uuid> --confirm-quiescent` runs the library recovery. `--confirm-quiescent` is a valueless flag that states the host has stopped or reaped every possible promotion worker. If no attempt was ever reserved, it releases a fence still held for that attempt ID.

Exit status:

| Command             | 0                  | 1                                       | 2           |
| ------------------- | ------------------ | --------------------------------------- | ----------- |
| `promote`, `resume` | `confirmed`        | `failed`, `indeterminate`, or any error | usage error |
| `status`            | attempt found      | unknown attempt                         | usage error |
| `recover`           | recovery completed | error                                   | usage error |

### Library addition

`releaseUnreservedGitPromotionFence` takes an attempt ID, the host-control configuration and the quiescence acknowledgement. It releases the fence only when all of the following hold:

- the fence is held for that attempt ID and bound to this ledger;
- a check under the ledger writer lock finds no attempt row.

If an attempt exists, it refuses and points to recovery.

Revocation is unchanged. It already serializes with reservation through the ledger writer lock, and it is refused once an attempt exists.

## Claim limits

- The same as the final gate: the claim is scoped to the Git ref, under trusted host configuration, ledger, process, key, clock and cooperating fence ownership.
- `--confirm-quiescent` is an operator assertion, not proof.
- After a failed reservation, the CLI's own Git children have all exited. If a reservation `COMMIT` reports an I/O error but is actually durable, the attempt row is visible to the locked check and the fence stays held.

## Verification

- Version 2 parsing and schema agreement. Rejected: a relative or protected `fencePath`, missing or unknown fields, a fence equal to a database path, and cross-version proposals.
- Real CLI flows on Git, SQLite and Ed25519 fixtures:
  - `promote` confirms and moves only the destination, and `status` reads it back;
  - a second `promote` is refused and releases its fence;
  - a version 1 configuration cannot promote;
  - `resume` confirms a prepared attempt;
  - `recover` fails a reserved attempt that was never admitted, and releases an unreserved fence;
  - flag parsing refuses a missing or valued `--confirm-quiescent`, duplicates and unknown options;
  - unknown attempts return exit 1;
  - `prepare` emits a version 2 request under a version 2 configuration.
- Full check, audit, package check, and docs: the operator guide, `GIT_PROMOTION.md`, the threat model, the CHANGELOG, the roadmap and the backlog.
