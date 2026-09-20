# Phased implementation plan

The phases are ordered to retire product and security risk before adding platform breadth. Estimates are solo-developer full-time-equivalent ranges, not release promises.

## Phase 1 — action-contract kernel (implemented)

**Goal:** prove the core objects and invariants without executing untrusted code.

Scope:

- deterministic canonical JSON and SHA-256 digests;
- Action Envelope v1 with trusted-vs-asserted provenance markers;
- deterministic effect-based policy decisions and explanations;
- single-use HMAC capability tokens bound to the exact action/envelope/scopes/expiry;
- tamper-evident decision evidence chain;
- plan-only MCP server with `catalog.search`, `action.plan`, and `policy.explain`;
- JSON Schema, threat model, architecture decision, and unit tests.

Exit criteria:

- all tests pass on Node 20+;
- changes to arguments, schema, policy, authority, or bound context produce a different action identifier;
- expired, under-scoped, tampered, and replayed capabilities fail;
- the MCP process starts without writing protocol data to stdout outside MCP framing;
- no Phase 1 documentation implies that actions are safely executed.

## Phase 2 — enforce one real downstream MCP call (2–3 weeks)

**Goal:** prove the differentiator end to end with one stdio backend and one write-shaped demo tool.

Scope:

- downstream MCP v2 client and schema discovery;
- operator acceptance and pinning of a schema digest;
- `action.execute` with an out-of-band approval CLI/API;
- SQLite plans, atomic token consumption, and write-ahead evidence;
- signed Execution Receipt v1 containing result and observed-effect digests;
- deterministic transcript replay by integrating an existing recorder where practical;
- crash/restart recovery and a malicious TOCTOU/schema-mutation test fixture.

Exit criteria:

- changed arguments/schema/policy/workspace make the prior approval unusable;
- two concurrent attempts cannot consume one approval twice;
- an independent CLI verifies the exported receipt;
- a restart between pre-write evidence and completion produces a recoverable `indeterminate` record.

## Phase 3 — coding-specific verification (2–4 weeks)

**Goal:** connect authorization to facts developers care about after a coding action.

Scope:

- gateway-observed Git commit/tree/dirty-diff identity;
- before/after changed-file manifest and patch digest;
- verifier plug-ins for test commands, changed-file boundaries, secret scans, and user-defined scripts;
- final states: `verified`, `failed`, `drifted`, and `indeterminate`;
- cross-client demo with at least two MCP hosts.

Exit criteria:

- a receipt proves whether effects stayed within approved paths;
- verifier output is content-addressed and linked to the action;
- the same receipt verifier works across both tested hosts.

## Phase 4 — hardened enforcement and lineage (3–5 weeks)

**Goal:** enforce effects rather than only compare them after execution.

Scope:

- rootless container executor adapter;
- filesystem and network allowlists enforced outside the model process;
- opaque secret handles and just-in-time injection;
- capability/data-lineage model informed by ChainCaps;
- poisoned-context, permission-laundering, symlink escape, SSRF, and resource-exhaustion corpus.

Exit criteria:

- maintained attack fixtures are blocked or require explicit bounded approval;
- benign-fixture false denial rate is measured and documented;
- security claims clearly name the enforcement layer and tested platforms.

## Phase 5 — integrations and team mode (3–6 weeks)

**Goal:** make the contract portable without turning the project into a gateway platform.

Scope:

- stable SDK and receipt-verifier packages;
- adapters for ToolHive or another established gateway;
- modern Streamable HTTP and remote authorization;
- optional centralized policy and redacted receipt metadata;
- OTel export and compatibility matrix.

Exit criteria:

- local operation remains fully functional without a hosted service;
- raw prompts, source, arguments, and results remain local by default;
- at least one external gateway can emit or verify the action contract.

## Deferred until demand exists

- Kubernetes operator and server lifecycle management;
- a general MCP registry;
- model routing and multi-agent orchestration;
- a web dashboard;
- custom sandbox technology;
- a hosted multi-tenant evidence lake.
