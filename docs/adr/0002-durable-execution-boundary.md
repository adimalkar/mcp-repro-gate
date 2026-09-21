# ADR 0002: durable execution begins with a local stdio vertical slice

- Status: accepted
- Date: 2026-09-20

## Context

Phase 1 could bind and approve an exact action but deliberately could not execute it. The first execution path must prove that approval replay, schema drift, process interruption, and ambiguous downstream outcomes fail closed before adding remote transports or broad backend support.

## Decision

Implement the first Phase 2 slice around one downstream stdio MCP session and a local SQLite write-ahead store:

1. load a persisted plan and verify its envelope;
2. compare the supplied arguments with the approved digest;
3. verify the one-use capability without consuming it;
4. connect to the configured downstream process and compare its live schema digest;
5. validate arguments against that schema;
6. atomically consume the capability and insert a `prepared` execution;
7. dispatch exactly once;
8. persist a signed receipt for a definite result, or mark the execution `indeterminate` when the outcome cannot be known.

Raw arguments and downstream results are not stored in SQLite; only their digests are placed in the receipt. Execution remains disabled unless an executor is explicitly supplied to the MCP server.

## Consequences

- A restart can identify incomplete executions without making unsafe retry assumptions.
- Two workers sharing the database cannot consume the same capability twice.
- A changed live schema cannot reuse an older approval.
- SQLite provides a strong local reference implementation but is not yet a multi-replica deployment design.
- HMAC receipts are independently checkable by a holder of the shared secret, but they do not provide public verification or non-repudiation.
- Filesystem/network isolation, artifact pinning, authenticated principals, and meaningful effect observers remain required before production write claims.
