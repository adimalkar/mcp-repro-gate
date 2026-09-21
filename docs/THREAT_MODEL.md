# Phase 1 and early Phase 2 threat model

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
- the default server does not expose `action.execute` unless an executor is supplied.

## Known gaps before execution is production-safe

- SQLite is durable locally but has no replica lease/ownership protocol;
- the approval CLI proves out-of-band issuance but has no authenticated approver identity or review UI;
- no transport-authenticated principal extraction;
- downstream schema negotiation exists, but artifact identity is not yet verified;
- no process, filesystem, network, secret, or sandbox enforcement;
- effect observation is an interface; no gateway-observed repository implementation exists yet;
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
