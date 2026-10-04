# Git promotion foundations

## Status and scope

These are library foundations for journaled, operator-reviewed Git ref promotion. They do **not** implement protected-ref promotion, approval consumption for promotion, final authorization/CAS, conservative promotion recovery, or a promotion CLI. Existing `git-review` commands remain the V1 review workflow; no default MCP promotion, signing or approval tool is added.

The development modules are `src/git-change-proposal.ts`, `src/git-change-stage.ts`, `src/git-promotion-objects.ts` and `src/git-promotion-host-control.ts`. The object-preparation and host-control modules are not yet exposed as stable package entrypoints through the package export map. They are intended for explicit trusted-host integration in the subsequent promotion slice, not invocation by an agent as approval authority.

The implemented pieces are:

- explicit V2 Git intent/proposal/workspace and review-request compatibility;
- isolated staging and exact candidate-object materialization;
- a persistent cooperative repository ownership fence;
- bounded reads that reject observable metadata changes during reads.

The subsequent [prepared promotion journal](GIT_PROMOTION_JOURNAL.md) implements durable one-use intent reservation. Final ref transition and host CLI/config integration remain follow-up work. Neither a candidate commit, ownership record nor prepared intent grants dispatch authority.

## Requirements

Use Node.js 22.13 or newer and Git 2.45 or newer for these Git workflows. The controlled runner requires Git's `--no-lazy-fetch` option; older Git fails closed rather than falling back to implicit object fetching.

The host owns the Git executable, repository/configuration, plan and approval databases, trust policy, clock, signing-key isolation and resource budgets. Version and filesystem checks are not an OS sandbox.

## Explicit V2 workspace binding

V1 retains its checked-out-destination witness and constructors/defaults. A legacy V1 approval is not retroactively made promotion-compatible.

V2 requires an actual clean worktree root with symbolic source HEAD. Its destination must:

- be a different, existing direct local `refs/heads/` branch;
- point to the same base commit as source HEAD;
- not be checked out in any registered worktree, including linked worktrees.

The witness binds canonical root/common-directory digests, source ref/commit/tree and destination ref/OID. Observations are repeated for consistency. Unknown/mixed contract versions and malformed record/input shapes fail closed. Worktree enumeration preserves path bytes and decodes branch identities strictly; the host ownership layer rejects physical paths it cannot represent losslessly.

`GitOperatorReviewV1`, its signature domain, `StagedGitChangeV1` and `GitChangeApprovalV1` remain unchanged. Exact versioned proposal/action/effect digests bind the V2 witness transitively. The V2 review request uses `requestVersion: 2`; this is library compatibility, not a new CLI promotion command.

## Exact candidate objects are not authorization

Object preparation reuses the same private patch-staging interpretation as review. It constructs a bounded raw commit with the exact staged tree, one expected-old parent and fixed host identity/message metadata incorporating a fresh attempt UUID and host timestamp. It does not accept arbitrary caller author or commit-message fields.

A candidate-only pack excludes the base closure and is imported into the local object store with strict Git plumbing. Readback verifies the exact raw commit, tree, parent, changed-path manifest, binary diff and effect binding rather than trusting only an asserted digest or existing object hash.

Each controlled Git command has a 15-second timeout and a bounded output buffer, at most 16 MiB. Oversized packs or outputs reject rather than truncate. These limits do not bound clone disk usage or the total time of a workflow containing multiple commands; the host needs a separate scratch/storage budget.

Permitted preparation effects include temporary clones and new object/pack files in the repository, including unreachable objects after a failure. Preparation does not move protected refs or write `HEAD`, the protected index or worktree. Existing review staging does not install candidate objects into the protected repository.

The controlled runner suppresses configured execution callbacks, replacement-object interpretation, automatic maintenance and unintended transports/lazy fetching. This is a concrete Git execution policy, not process or network syscall confinement. Raw patch/diff content may contain secrets: displaying an exact escaped diff is not secret scanning.

## Persistent cooperative ownership

`createGitPromotionHostControl` captures host-owned `repositoryPath`, `approvalDatabasePath`, `fencePath` and optional `statePaths`. Its concrete methods are:

- `query()`: `available`, `held` with a detached frozen owner, or `held-invalid`; unsafe host-location drift can also throw;
- `acquire(attemptId)`: acquire an exclusive persistent directory latch for a fresh host UUIDv4;
- `release(owner, { childrenQuiescent: true })`: require the exact persisted owner/token/attempt/bindings and explicit trusted-host quiescence acknowledgement.

The owner record is bounded to 16 KiB and contains only its version, token, attempt ID, canonical common directory, approval database/fence paths and creation time. It contains no PID, signing key, patch or process diagnostics.

A worker crash, missing/partial owner write, malformed record or uncertain acquisition leaves the latch held. There is no PID/age/timeout stealing, automatic repair or force-unlock API. An ambiguous release can leave an invalid empty latch; failure is not proof that ownership is safely reusable.

The current physical common-directory identity and all protected-root separation checks are reapplied throughout operations and relevant observation/write/flush boundaries. The fence must stay outside workspaces, effective/common Git metadata, registered worktrees and protected ledger/state/sidecar locations. Physical paths are resolved byte-preservingly and decoded fatally, never silently substituted with a replacement-character twin. Ordinary HEAD advancement or dirty/untracked content is not by itself a fence-release gate; final proposal/workspace authorization belongs to the later promotion operation.

Every cooperating promotion, revocation, checkout/worktree, configuration, plan and key writer must use the same canonical common-directory/ledger/fence mapping. Noncooperating processes, other mappings and compromised same-user actors are outside this protocol's exclusion guarantee.

## Host storage and quiescence responsibilities

On POSIX, host fence/ledger/state parents and directory targets require current-user private mode `0700`; owner, ledger/state and present sidecar files require regular, single-link mode `0600`. Relevant directory identities are pinned and rechecked. The controller rejects unsafe host inputs; it does not chmod, repair or replace them. Missing ledger file leaves may be represented, but the fence does not open or create the database.

Windows deployments must provide equivalent private current-user ACLs. Unix mode bits do not establish that policy on Windows. Portable Windows directory fsync is not provided, and filesystem/device power-loss guarantees are not implied by successful file/POSIX-directory flushes.

The quiescence boolean is a trusted-host assertion, not evidence that no child exists. Before release, the host must establish that every possible dispatched writer has completed or has been stopped and reaped. A dead parent PID or released SQLite lock does not establish this: an orphan Git child can remain live. The later journal/recovery layer must handle that uncertainty explicitly; this foundation does not automate recovery.

An agent sharing the host's filesystem credentials may still access host records or signing material. Private modes and signatures do not replace deployment-level agent/operator separation.

## Observable read consistency

Bounded regular-file reads use one descriptor, verify safety and size before/after EOF, compare stable metadata and observed byte length, and close/clear intermediate buffers on failure. Fence owner checks also compare final path observations and both release inspections. Atime is excluded because legitimate reads may update it.

These checks reject observable truncation, same-size replacement and permission/identity drift. They do not reserve the filesystem or detect changes hidden by the filesystem's metadata granularity, nor changes after the final observation. Conflicting or uncertain owner observations must not authorize successful release.

## Remaining promotion gates

A complete promotion builds on the [durable prepared-only journal](GIT_PROMOTION_JOURNAL.md) and still needs fresh authenticated admission under persistent ownership and a shared SQLite write lock, expected-old direct-ref CAS, ownership-aware revocation and conservative quiescent recovery. Git ref movement and SQLite completion are not one distributed atomic transaction. No portable signed promotion receipt or proof of human presence/inspection is delivered by these foundations.
