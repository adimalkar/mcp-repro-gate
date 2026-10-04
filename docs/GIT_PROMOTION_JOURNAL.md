# Prepared Git promotion journal

This library slice implements durable prepared-intent reservation (T1). It consumes one linked signed approval for an already-installed candidate in the private connection owned by `SqliteGitApprovalStore`. A prepared record is not permission to dispatch a Git command or a receipt for a changed ref. Final admission, ref compare-and-swap, terminal evidence, restart recovery, and a promotion CLI remain future work.

## Reservation and retained evidence

`reserveGitPromotionFromPlan` captures and validates a version 2 proposal, prepared candidate, exact fence owner, and host configuration. Trusted plan storage, catalog, policy, and operator trust remain live inputs. It instantiates the concrete filesystem fence controller itself; callers cannot provide a fake controller or authorization callback.

Before acquiring the SQLite writer lock, reservation rederives authority from the persisted plan, authenticates the current linked signed approval, and verifies the installed candidate's raw commit, tree, sole parent, fixed host metadata, manifest, diff, and effect. After `BEGIN IMMEDIATE` completes, including any busy wait, it checks current plan authority, signed proof, trust, expiry, and the exact held fence again. The candidate must already exist: reservation does not prepare objects, change a ref, change source HEAD, or modify the index or worktree.

The attempt, approval, and proposal are each permanently unique. Approval, signed decision, and attempt links share foreign keys and one connection/transaction. Reservation commits a `prepared` record, then returns only an exact, strict canonical readback. Retained evidence includes the version 2 proposal, staged manifest and digests, candidate object identifiers, plan authority, review digest, fence owner and paths, and reservation/admission timestamps. Raw patches and private signing keys are not retained in this journal. Canonical records are bounded to 16 MiB.

Every replay rejects, including retrying the same attempt. Neither expiry, a new fence token, nor reopening the database resets consumption. A thrown COMMIT or readback error does not establish rollback or approval reusability. The host must retain the fence and inspect the journal; this slice supplies no automatic recovery or release-on-error path. `getGitPromotionAttempt` is an immutable status read, not authorization to dispatch.

## SQL invariants and raw revocation

The journal uses a STRICT table with foreign keys, column/JSON bindings, and integer epoch ordering. A deterministic `reprogate_promotion_epoch_ms` function is registered on every private connection. Its insertion trigger binds the epoch columns to the exact canonical UTC timestamps in the record, including negative epochs, extended years, milliseconds, and supported Date endpoints. Invalid or normalized timestamps yield NULL and reject. Reopening also installs this trigger on an already-created journal table without rewriting or deleting consumption.

Raw external connections cannot insert journal rows without the function. On Node 22, `trusted_schema=OFF` also causes insertion to reject because the custom function cannot be marked SQLITE_INNOCUOUS. This is a compatibility restriction, not a bypass. Host-owned schema/function configuration is a trusted assumption.

Only `prepared` may be inserted. Updates, deletes, replacements, and insertion of terminal states are rejected by SQL guards. The future state vocabulary reserves `confirmed`, `failed`, and `indeterminate`; it does not expose a terminal setter or accepted terminal evidence in this slice. A future transition implementation requires an additive migration and concrete evidence verifier.

`revoke` checks unresolved attempts and updates approval status under the same writer lock. Any attempt remains unresolved in this slice. SQL also blocks raw revocation of linked approvals. Strict journal corruption rejects revocation; malformed evidence cannot manufacture completion or quiescence.

## Physical identity, durability, and compatibility

Durable reservation requires an absolute disk ledger matching the exact concrete fence owner. Identity is pinned by device/inode at connection initialization and checked again before and during the reservation transaction. The connection's filename comes from SQLite's `CAST(file AS BLOB)` projection of `pragma_database_list`; decoding a TEXT result can replace invalid bytes with U+FFFD and identify a different existing file. Native realpath likewise returns bytes, and fatal UTF-8 validation precedes filename lookup and inode pinning. Invalid physical filenames reject rather than normalize to a Unicode twin. A genuine U+FFFD filename, valid symlinks, and canonical aliases remain supported. Failed initialization closes the private connection before journal schema/WAL setup.

The connection enables foreign keys, uses WAL, and requires `synchronous=FULL` at reservation checks. Consumption shares the approval/review ledger; there is no separate production database. In-memory and relative-path constructors retain legacy grant, matching, review, and revocation behavior for valid paths, but cannot reserve durable promotion. Version 1 proposals, unsigned/legacy approvals, authenticated denials, and revoked grants do not acquire promotion authority.

The host must own configuration, ledger/schema access, plan storage, trust configuration, key isolation, and the clock. One canonical Git common-directory/approval-ledger pair must map to one configured fence across cooperating hosts/processes. The fence is not an OS sandbox. Same-user hostile filesystem/database writers, a compromised host, alternate fence configuration, disabled durability, and filesystem/SQLite failures are outside a claim of atomic Git promotion. POSIX ownership/mode checks and Windows ACL deployment requirements remain those of the [host fence](../src/git-promotion-host-control.ts); FULL does not establish a cross-system atomic commit or a replica lease.

The independent [promotion plan](plans/journaled-git-promotion.md) remains a design document; this page describes the implemented prepared-only slice.
