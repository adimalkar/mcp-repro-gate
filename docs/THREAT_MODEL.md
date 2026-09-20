# Phase 1 threat model

## Security statement

Phase 1 is a semantics prototype. It plans and binds actions but never forwards or executes a downstream tool call. Its capability token implementation demonstrates exact-action binding; the in-memory replay store is not durable enough for production writes.

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

## Known gaps before execution is safe

- no durable/transactional token-use store across crashes or replicas;
- no out-of-band human approval interface;
- no transport-authenticated principal extraction;
- no live downstream schema negotiation or artifact verification;
- no JSON Schema validation of downstream arguments;
- no process, filesystem, network, secret, or sandbox enforcement;
- no gateway-observed repository state yet;
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
