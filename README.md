# ReproGate

[![CI](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/codeql.yml/badge.svg)](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/codeql.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/adimalkar/mcp-repro-gate?variant=verified)](https://m8ven.ai/mcp/adimalkar/mcp-repro-gate)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

ReproGate is an action-contract layer for MCP tool execution. It binds a policy decision or human approval to the exact tool, schema, arguments, authority, policy, and observed workspace state, then makes that binding available to an execution receipt.

The goal is narrower than “another MCP gateway”: make a tool action independently inspectable and make approval invalid as soon as the proposed action changes.

## Current status: Phase 2 vertical slice

This repository contains the action-contract kernel, a plan-only MCP server by default, and the first opt-in Phase 2 execution boundary. It can:

- discover tools through a small stable façade;
- build deterministic, digest-bound action envelopes from an operator-controlled catalog;
- return explainable `allow`, `approval_required`, or `deny` decisions;
- issue and validate one-use capability tokens bound to an exact envelope;
- create tamper-evident, hash-chained decision records.
- persist plans and atomically consume approvals in SQLite;
- re-check a live downstream MCP schema before one stdio call;
- recover interrupted calls as `indeterminate`;
- emit and independently verify signed Execution Receipt v1 records.

Execution is deliberately disabled in the default server and requires explicit executor wiring. The current slice is not a sandbox or a production authorization boundary: artifact verification, authenticated principals, concrete effect observation, and external enforcement are still pending.

## Try it

Requirements: Node.js 22.13 or newer. CI tests the maintained Node.js 22 and 24 release lines on Linux, macOS, and Windows.

```bash
npm install
npm run check
npm run demo
```

Run the MCP server over stdio:

```bash
npm run build
node dist/src/cli.js serve
```

The Phase 2 APIs are exported for explicit application wiring:

- `SqliteExecutionStore` for durable plans, one-use approvals, and execution state;
- `StdioMcpConnector` for configured downstream processes;
- `ReproGateExecutor` for the fail-closed execution sequence;
- `signExecutionReceipt` and `verifyExecutionReceipt` for receipt handling.

Approval issuance is intentionally out of band and reads its secret from the environment rather than command-line arguments:

```bash
REPROGATE_CAPABILITY_SECRET='<at-least-32-byte-secret>' \
  node dist/src/cli.js approve ./reprogate.sqlite '<action-id>'

REPROGATE_RECEIPT_SECRET='<at-least-32-byte-secret>' \
  node dist/src/cli.js verify-receipt ./receipt.json
```

Do not treat these HMAC keys or the current injected effect observer as a production deployment design. See the threat model before enabling `action.execute`.

The default server exposes exactly three tools:

- `catalog.search`
- `action.plan`
- `policy.explain`

When an executor is explicitly supplied, the server also registers `action.execute`. The included catalog remains a deterministic demo fixture; production configuration is still pending.

## Core invariant

An approval is valid for one exact action, not for a server or tool name in general:

```text
tool identity + schema + arguments + policy + authority + workspace + expiry
                                  │
                                  ▼
                       canonical action digest
                                  │
                     one-use approval capability
                                  │
                                  ▼
                        execution receipt (next)
```

Arguments are hashed and not stored raw in decision evidence. Tool schemas and effects come from an operator-controlled catalog, not from model-provided metadata. Workspace identity is reserved for gateway-observed values; the agent cannot label its own context as observed.

## Why this wedge

MCP gateways, policy engines, audit proxies, replay tools, and provenance systems already exist. ReproGate is designed to integrate with those systems, not rebuild all of them. Its differentiator is the portable contract spanning pre-execution authority and post-execution verification.

See [idea validation](docs/VALIDATION.md), the [phased roadmap](docs/ROADMAP.md), the [improvement backlog](docs/IMPROVEMENTS.md), and the [threat model](docs/THREAT_MODEL.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security vulnerabilities should be reported privately according to [SECURITY.md](SECURITY.md), never in a public issue.

## License

Apache-2.0.
