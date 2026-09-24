# Product and engineering improvements

This is the maintained improvement backlog for ReproGate. Items are ordered by the security or adoption risk they retire, not by feature novelty. Completed work stays visible so design claims can be traced to code and tests.

## P0 — prove safe-enough execution semantics

- [x] Persist action plans without persisting raw arguments.
- [x] Atomically combine one-use capability consumption with a write-ahead execution record.
- [x] Re-read and compare the downstream tool schema immediately before dispatch.
- [x] Validate supplied arguments against the pinned schema.
- [x] Mark interrupted or ambiguous calls `indeterminate` instead of inferring an outcome.
- [x] Produce a signed Execution Receipt v1 and an independent verification function/CLI.
- [x] Exercise a real downstream MCP stdio process in integration tests.
- [x] Add a production configuration format and start the execution-enabled MCP façade only when every backend, observer, database, and secret is explicitly configured.
- [x] Bind and verify the downstream server artifact digest, not only its advertised schema.
- [ ] Replace shared-secret receipt signatures with an asymmetric signing provider and documented key rotation.
- [ ] Add process ownership/lease metadata so recovery can distinguish a crashed worker from a still-running replica.

## P1 — make observed effects meaningful for developers

- [ ] Extend the implemented symlink-safe filesystem manifest observer with Git commit, tree, dirty diff, and changed-path identity.
- [ ] Compare approved filesystem/network authority with actual effects and emit `verified`, `failed`, `drifted`, or `indeterminate`.
- [ ] Add verifier plug-ins for test commands, secret scanning, path boundaries, and user-defined checks.
- [ ] Store content-addressed verifier outputs while redacting arguments, source, prompts, and secrets by default.
- [ ] Export a portable receipt bundle that can be verified without a live ReproGate process.

## P1 — strengthen the authorization boundary

- [ ] Extract authenticated principal identity from a supported transport instead of trusting caller metadata.
- [ ] Add approval reason, approver identity, and policy version to capability claims.
- [ ] Support bounded approval revocation and signing-key rotation.
- [ ] Define multi-replica database support after SQLite semantics are proven locally.
- [ ] Add maintained abuse fixtures for schema mutation, replay races, symlink escape, SSRF, permission laundering, and response loss.

## P2 — adoption and interoperability

- [ ] Publish stable contract and verifier packages separately from the MCP façade.
- [ ] Test at least two MCP hosts and one established gateway adapter.
- [ ] Add Streamable HTTP only after transport authentication and deployment guidance exist.
- [ ] Export OpenTelemetry spans that reference digests but exclude sensitive payloads.
- [ ] Maintain a compatibility matrix for Node, MCP protocol era, hosts, and backends.

## Product validation and kill criteria

Measure whether exact-action receipts solve a problem teams will adopt:

- time required to review and approve an action;
- percentage of approvals invalidated by legitimate drift versus malicious/unsafe drift;
- replay/schema-mutation attacks blocked by the contract;
- receipt verification success across independent clients;
- sensitive payload bytes retained by default (target: zero).

Reconsider or narrow the product if teams will not integrate the contract without a full gateway replacement, if false invalidation makes approvals unusable, or if existing gateway receipt formats become portable and cover the same exact-action invariant.

## Explicit non-goals for now

- a general MCP registry;
- model routing or multi-agent orchestration;
- a custom sandbox runtime;
- a Kubernetes operator;
- a hosted multi-tenant evidence lake;
- a dashboard before the receipt format has external users.
