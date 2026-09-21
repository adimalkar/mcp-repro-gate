# ADR 0003: execution requires complete explicit runtime configuration

- Status: accepted
- Date: 2026-09-21

## Context

The first execution slice required application code to construct the store, connector, observer, secrets, and executor. That was testable but left room for partial wiring, unpinned backend artifacts, broad inherited environments, and accidental exposure of `action.execute`.

## Decision

Keep the default server plan-only. Register `action.execute` from the CLI only when a strict Runtime Configuration v1 provides:

- a durable SQLite path;
- a complete catalog and policy;
- one stdio backend for every catalog server reference;
- an artifact path and matching digest bound into every action envelope;
- an explicit filesystem manifest observer and bounded roots;
- distinct capability and receipt secrets referenced by environment-variable name;
- an explicit receipt signing key identifier.

Backend environments are constructed from a small safe allowlist plus explicit host-to-child mappings. Unknown configuration fields, raw secrets, relative security-sensitive paths, missing artifacts, uncovered roots, and unused backends fail startup.

## Consequences

- A normal `reprogate serve` cannot execute tools.
- `reprogate serve --config ...` is reproducible and fails closed before opening the MCP transport.
- Artifact drift is checked at startup and again before capability consumption and process spawn.
- File observations are content-addressed without persisting file contents.
- The configuration is deployable for a single local process, but it is not a sandbox, multi-replica lease design, network observer, or solution to a hostile same-host artifact race.
