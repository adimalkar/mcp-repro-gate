# Prepared Git promotion journal

This library implements durable prepared-intent reservation (T1), the final promotion gate, and conservative recovery. Reservation consumes one linked signed approval for an already-installed candidate in the private connection owned by `SqliteGitApprovalStore`. A prepared record is not permission to dispatch a Git command or a receipt for a changed ref; only the final gate below dispatches. The host-only [promotion commands](GIT_PROMOTION.md) drive these APIs; portable signed receipts remain future work.

## Reservation and retained evidence

`reserveGitPromotionFromPlan` captures and validates a version 2 proposal, prepared candidate, exact fence owner, and host configuration. Trusted plan storage, catalog, policy, and operator trust remain live inputs. It instantiates the concrete filesystem fence controller itself; callers cannot provide a fake controller or authorization callback.

Before acquiring the SQLite writer lock, reservation rederives authority from the persisted plan, authenticates the current linked signed approval, and verifies the installed candidate's raw commit, tree, sole parent, fixed host metadata, manifest, diff, and effect. After `BEGIN IMMEDIATE` completes, including any busy wait, it checks current plan authority, signed proof, trust, expiry, and the exact held fence again. The candidate must already exist: reservation does not prepare objects, change a ref, change source HEAD, or modify the index or worktree.

The attempt, approval, and proposal are each permanently unique. Approval, signed decision, and attempt links share foreign keys and one connection/transaction. Reservation commits a `prepared` record, then returns only an exact, strict canonical readback. Retained evidence includes the version 2 proposal, staged manifest and digests, candidate object identifiers, plan authority, review digest, fence owner and paths, and reservation/admission timestamps. Raw patches and private signing keys are not retained in this journal. Canonical records are bounded to 16 MiB.

Every replay rejects, including retrying the same attempt. Neither expiry, a new fence token, nor reopening the database resets consumption. A thrown COMMIT or readback error does not establish rollback or approval reusability. The host must retain the fence and inspect the journal; this slice supplies no automatic recovery or release-on-error path. `getGitPromotionAttempt` is an immutable status read, not authorization to dispatch.

## SQL invariants and raw revocation

The journal uses a STRICT table with foreign keys, column/JSON bindings, and integer epoch ordering. A deterministic `reprogate_promotion_epoch_ms` function is registered on every private connection. Its insertion trigger binds the epoch columns to the exact canonical UTC timestamps in the record, including negative epochs, extended years, milliseconds, and supported Date endpoints. Invalid or normalized timestamps yield NULL and reject. Reopening also installs this trigger on an already-created journal table without rewriting or deleting consumption.

Raw external connections cannot insert journal rows without the function. On Node 22, `trusted_schema=OFF` also causes insertion to reject because the custom function cannot be marked SQLITE_INNOCUOUS. This is a compatibility restriction, not a bypass. Host-owned schema/function configuration is a trusted assumption.

Only `prepared` may be inserted into the attempt table. Updates, deletes, replacements, and insertion of terminal states are rejected by SQL guards. Terminal states are recorded in separate insert-only outcome rows, described below; there is no generic state setter.

`revoke` checks for attempts and updates approval status under the same writer lock. Any attempt, including a resolved one, has permanently consumed its approval, so revocation is refused. SQL also blocks raw revocation of linked approvals. Strict journal corruption rejects revocation; malformed evidence cannot manufacture completion or quiescence.

## Final gate: admission, compare-and-swap and outcomes

`promoteGitPromotionAttempt` runs only for a prepared attempt whose fence is held by its exact persisted owner. Each step's checks and results:

1. **Precheck, outside the SQLite lock.** It verifies the installed candidate objects, rederives plan authority (which re-observes the V2 workspace: source HEAD and tree, cleanliness, the destination ref, and every registered worktree), authenticates the linked signed review under current trust, and checks the admission deadline. A rejection throws and records nothing. Nothing was dispatched, so the attempt can be retried, for example after a moved destination is restored.
2. **Admission, under `BEGIN IMMEDIATE` and the fence.** The same checks run again. A rejection now records a `failed` outcome and releases the fence; the approval stays consumed. Otherwise the gate commits an **admission** record with `synchronous=FULL`. `admittedAt` is the authorization check time.
3. **Dispatch.** In a new transaction the gate runs `update-ref --no-deref <destination> <candidate> <expected-old>` through the hardened runner, which disables hooks, then reads back the destination, source HEAD and branch, and the worktree list.
   - A zero exit with exact readback records `confirmed` and releases the fence.
   - Any other result records `indeterminate` and **retains** the fence: a nonzero exit (`dispatch_uncertain`, which includes a lost compare-and-swap, since the runner does not distinguish it), or a readback that is not exact (`readback_mismatch`).
   - A destination already at the candidate without a successful dispatch by this attempt is never confirmed.
   - If recording the outcome fails, the attempt stays admitted with no outcome and the fence stays held.

Dispatch only ever follows a durable admission. A missing admission therefore proves that this library never dispatched the attempt, and an admitted attempt can never be promoted a second time.

Effects of a confirmed promotion: the destination ref moves to the candidate commit, and Git appends a reflog entry `reprogate promotion <attemptId>`. Source HEAD, index, worktree and other refs are not written. Expiry is the deadline for admission; Git's compare-and-swap does not evaluate the clock, signature or ledger.

## Recovery and status

`recoverGitPromotionAttempt` requires the plain acknowledgement `{ childrenQuiescent: true }`. The trusted host makes it only after stopping or reaping every process that might still be promoting the attempt; the acknowledgement is a host contract, not proof. Recovery:

- resolves an admitted attempt without an outcome as `indeterminate` (`interrupted`);
- resolves a prepared attempt that was never admitted as `failed` (`abandoned`);
- leaves any existing outcome unchanged;
- records the current destination OID only as an observation;
- releases the fence only if the attempt's own persisted owner still holds it.

Recovery never retries the write, rolls back or overwrites refs, clears consumption, or turns an uncertain outcome into `confirmed`.

`getGitPromotionStatus` returns the strict canonical readback of the attempt with its optional admission and outcome, from one SQL snapshot. It is idempotent, so a confirmed promotion whose response was lost still reads back as `confirmed`. It is not authorization or recovery.

Admissions and outcomes are separate insert-only tables keyed by attempt ID, so the immutable intent row and its guards are unchanged. SQL triggers reject:

- updates, deletes and `INSERT OR REPLACE`;
- an admission that does not bind its attempt's authority, review, expected old OID and candidate, or that arrives after an outcome;
- a `failed` outcome after an admission, and any other outcome without one;
- a `confirmed` outcome that does not observe the candidate.

The [admission](../schemas/git-promotion-admission.schema.json) and [outcome](../schemas/git-promotion-outcome.schema.json) schemas describe the records. The ledger is trusted host state: a raw SQL writer with access to it can insert a consistent but false outcome, so ledger access belongs to the host, like the rest of the journal.

## Physical identity, durability, and compatibility

Durable reservation requires an absolute disk ledger matching the exact concrete fence owner. SQLite opens the lossless canonical physical filename before creating any WAL or schema. A new ordinary leaf resolves beneath its canonical existing parent; a dangling alias fails closed. This keeps the live WAL namespace shared by canonical readers and alias callers. Identity is pinned by device/inode at connection initialization and checked again before and during the reservation transaction. The connection's filename comes from SQLite's `CAST(file AS BLOB)` projection of `pragma_database_list`; decoding a TEXT result can replace invalid bytes with U+FFFD and identify a different existing file. Native realpath likewise returns bytes, and fatal UTF-8 validation precedes filename lookup and inode pinning. Invalid physical filenames reject rather than normalize to a Unicode twin. A genuine U+FFFD filename, valid symlinks, and canonical aliases remain supported. Invalid caller/physical filenames reject before opening SQLite; failures after opening close the private connection before journal schema/WAL setup.

The connection enables foreign keys, uses WAL, and requires `synchronous=FULL` at reservation checks. Consumption shares the approval/review ledger; there is no separate production database. In-memory and relative-path constructors retain legacy grant, matching, review, and revocation behavior for valid paths, but cannot reserve durable promotion. Version 1 proposals, unsigned/legacy approvals, authenticated denials, and revoked grants do not acquire promotion authority.

The host must own configuration, ledger/schema access, plan storage, trust configuration, key isolation, and the clock. One canonical Git common-directory/approval-ledger pair must map to one configured fence across cooperating hosts/processes. The fence is not an OS sandbox. Same-user hostile filesystem/database writers, a compromised host, alternate fence configuration, disabled durability, and filesystem/SQLite failures are outside a claim of atomic Git promotion. POSIX ownership/mode checks and Windows ACL deployment requirements remain those of the [host fence](../src/git-promotion-host-control.ts); FULL does not establish a cross-system atomic commit or a replica lease.

The independent [promotion plan](plans/journaled-git-promotion.md) remains a design document; this page describes the implemented reservation, final gate and recovery.
