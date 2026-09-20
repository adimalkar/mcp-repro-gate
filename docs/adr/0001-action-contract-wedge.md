# ADR 0001: build an action-contract kernel before a gateway

- Status: accepted
- Date: 2026-09-07

## Context

The initial research proposed a local-first MCP execution gateway combining policy, audit, replay, schema pinning, tool search, provenance, verification, and later sandboxing. Current projects already implement most of those capabilities individually, and broad platforms such as ToolHive implement several together.

Building the entire proposed surface would create a large integration project whose differentiation is the sum of existing features.

## Decision

ReproGate will first implement a portable action contract with two linked halves:

1. a pre-execution Action Envelope and one-use capability bound to exact inputs and authority;
2. a post-execution Receipt bound to observed effects and independent verifier results.

The first implementation is one TypeScript package with a thin MCP adapter. Package boundaries will be extracted only after Phase 2 proves the runtime seam.

Approval minting is not exposed as a model-callable MCP tool. Caller-provided workspace or identity data is never labeled as observed. Downstream tool metadata cannot grant its own authority.

## Consequences

- Phase 1 is useful as a contract and policy prototype but cannot execute tools.
- Existing gateways, recorders, and provenance systems become potential integration targets.
- The immediate demo is less visually broad but tests a sharper security invariant.
- SQLite, live proxying, receipts, effect observation, and replay are deferred to Phase 2.
