# Reference action contracts and Git review threat model

## Security statement

Phase 1 remains a semantics prototype. The early Phase 2 library adds an opt-in, durable execution slice for one configured stdio backend. It is designed to test exact-action enforcement and recovery semantics, but it is not yet a sandbox or a production-safe write boundary.

## Assets

- integrity of an Action Envelope and its decision;
- integrity and confidentiality of approval-signing material;
- one-use semantics of an approval capability;
- integrity of decision evidence;
- accurate distinction between trusted, observed, asserted, and unknown facts.

## Trust boundaries

| Input                                          | Phase 1 trust                 |
| ---------------------------------------------- | ----------------------------- |
| MCP tool arguments                             | Untrusted                     |
| Host identity without transport authentication | Unknown/client-asserted       |
| Tool schema/effects in operator catalog        | Trusted configuration input   |
| Tool-provided annotations                      | Not an authorization source   |
| Workspace fields supplied by an agent          | Never accepted as observed    |
| Capability-signing secret                      | Trusted and out of band       |
| System clock                                   | Trusted for expiry in Phase 1 |
| In-memory consumed-token store                 | Process-local only            |

## Addressed threats

- argument, schema, policy, or authority changes invalidate the action binding;
- token payload tampering invalidates its HMAC;
- expired and under-scoped tokens are rejected;
- a consumed token cannot be reused in one process;
- conflicting same-priority policies fail instead of selecting by accident;
- raw action arguments are excluded from decision evidence.

## Early Phase 2 controls

- plans and execution state can be persisted in SQLite without retaining raw arguments;
- capability consumption and the pre-dispatch execution record share one transaction;
- the live downstream schema is re-hashed and arguments are validated before consumption;
- definite downstream responses produce signed receipts with result/effect digests;
- transport errors, observer failures, and restart recovery become `indeterminate`;
- the default server does not expose `action.execute` unless an executor is supplied;
- configured CLI startup requires complete backend, observer, database, and environment-secret references;
- configured backends bind a file artifact digest into the plan and verify it before process spawn;
- the filesystem observer hashes bounded roots and records, but does not follow, internal symlinks.

## Git operator review identity boundary

Git Operator Review v1 binds an explicit `approve` or `deny` decision to the proposal, derived plan authority, staged-effect digests, a host-owned audience, operator/key identity, and bounded UTC timestamps. Ed25519 signatures cover domain-separated canonical payload bytes. The host's public-key allowlist, not the proposal or client principal, determines enabled identities and exact repository/worktree-root/destination-ref permissions. Key IDs are public SPKI fingerprints, and private keys are not accepted as trust configuration.

Decision-making consumers must use the detached, frozen snapshot returned by `authenticateGitOperatorReview`. The boolean `verifyGitOperatorReview` does not authenticate the identity of its original JavaScript input object. Reading that object again can observe changed values or accessor results that were not signed. An authenticated denial remains a denial; signature validity alone does not authorize a grant.

A valid review proves possession of an authorized signing key and the exact signed decision binding. It does not prove human presence, actual inspection of the diff, repository ownership, or effect confinement. Signature verification alone is neither durable approval issuance nor one-use consumption; a grant workflow must also bind signed evidence to the approval ledger and fresh plan/workspace state.

The authenticated import path snapshots untrusted inputs, validates the review before expensive staging, compares the actual staged effect, and rederives plan authority. It atomically records approval plus signed evidence or a denial tombstone in one SQLite transaction. First accepted decision wins per proposal/database, including across processes and restarts; existing legacy/revoked grants cannot acquire evidence retroactively. Denial is not revocation, and review matching is not a consumption or promotion reservation. Stored evidence includes operator identity, key fingerprint, decision and signature metadata, but no raw patch or private signing material.

The host owns configuration, plan/approval storage, key isolation, and the clock. An agent sharing the operator's filesystem credentials may also be able to read its signing key: deployment must keep signing material and approval write authority outside that agent's access. A compromised host, database, configuration, or key is not repaired by a signature. Public-key removal, disabling, and permission narrowing must be checked again when an approval is matched.

Review staging exposes the exact Git-generated diff for inspection while retaining only its digest and changed-path manifest in the staging contract. Diff content is untrusted source data, not instructions. Raw diff access is not a portable promotion receipt, and neither signing nor checking a review updates a protected Git ref.

## Native handoff context boundary

The opt-in handoff tools store context that is caller-asserted. The host fixes the workspace and database paths; model input cannot name a filesystem or database target. Snapshots are immutable and digest-checked, revisions are serialized by SQLite writers, and plan references are re-verified against the persisted envelope. None of these records grant authority: no capability, approval, plan, receipt or execution state reads them. Projection writes use a private exclusive temporary file, identity checks on the parent directories and target, fsync, and an atomic rename. Symlinked, hard-linked, or overly permissive targets are refused, not repaired. A same-user hostile writer can still race these checks, and the SQLite record and Markdown projection are not one atomic transaction. See [docs/HANDOFF.md](HANDOFF.md).

## Façade evidence exposure

`action.plan` returns a compact summary by default. `action.inspect` and `detail: "full"` return the persisted envelope for any known `actionId`, including its principal, run ID and declared authority (scopes, roots, destinations and secret handle names, never secret values). In a deployment where several sessions share one execution store, any connected model that learns an action ID can read that plan. Treat the store as shared within one trust domain. `catalog.describe` omits secret handle names.

## Known gaps before execution is production-safe

- SQLite is durable locally but has no replica lease/ownership protocol;
- the Phase 2 `approve` CLI proves out-of-band HMAC issuance but does not authenticate an approver; it is distinct from the Git signed-review protocol;
- no transport-authenticated principal extraction;
- artifact identity covers one configured file but cannot eliminate a hostile same-host replacement race;
- no OS-level process, filesystem, network, secret, or sandbox enforcement;
- filesystem effects are content-addressed and Git proposals/staging have bounded witnesses, but atomic Git promotion and network/process/credential observation are not implemented;
- HMAC proves possession of a shared secret, not third-party/non-repudiable authorship;
- a hash chain detects mutation only when an independent checkpoint or signature is retained;
- no protection from a compromised gateway process or signing key.

## Phase 2 required abuse cases

1. Approve `publish({target: A})`, then attempt `publish({target: B})`.
2. Approve a tool, mutate its schema before execution, and attempt the call.
3. Approve at commit/tree X, change protected files, and attempt execution at Y.
4. Race two executions with the same one-use token.
5. Crash after the pre-execution evidence write but before the downstream result.
6. Return a result inconsistent with the observed filesystem effects.
7. Inject an agent-supplied field claiming it was gateway-observed.
