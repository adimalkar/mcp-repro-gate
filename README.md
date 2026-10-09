# ReproGate

[![CI](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/codeql.yml/badge.svg)](https://github.com/adimalkar/mcp-repro-gate/actions/workflows/codeql.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/adimalkar/mcp-repro-gate?variant=verified)](https://m8ven.ai/mcp/adimalkar/mcp-repro-gate)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

ReproGate is an action-contract layer for MCP tool execution. Its intended contract binds a policy decision or human approval to the exact tool, schema, arguments, authority, policy, and observed workspace state, then makes that binding available to an execution receipt. The current configured path does not yet enforce all of those fields at a durable write boundary.

The goal is narrower than “another MCP gateway”: make a tool action independently inspectable and make approval invalid as soon as the proposed action changes.

## Current status: Phase 2 reference path and Phase 3 prepared Git promotion journal

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
- load a strict execution configuration with environment-referenced secrets;
- bind and verify a downstream artifact before process spawn;
- hash bounded filesystem manifests without retaining file contents.
- bind a proposed patch digest to a read-only, clean Git worktree witness and exact path list.
- stage a Git patch in a disposable index and record a host-side, revocable approval of its reviewed effect.
- bind that approval to a persisted exact-action Git intent, current catalog, policy, and repository configuration.
- authenticate operator-key decisions about an exact staged Git effect and atomically record linked approval evidence or a durable denial.
- bind explicit V2 intents to a distinct unchecked-out destination without reinterpreting V1 approvals;
- prepare exact candidate commit objects without moving protected refs, HEAD, index or worktree;
- retain a cooperative host ownership fence across worker death, with exact-owner quiescent release.
- permanently reserve one linked signed Git approval as immutable prepared intent in the existing SQLite ledger, with guarded raw revocation.

Execution is deliberately disabled in the default server and requires explicit executor wiring. The configured path is not a sandbox or a production authorization boundary. Git review authenticates a configured signing key and exact decision, not human presence or inspection. The host owns configuration, databases and key isolation; protected-ref promotion is not implemented. See the [Git change contract and limits](docs/GIT_CHANGE_PROPOSAL.md).

## Try it

Requirements: Node.js 22.13 or newer; Git workflows require Git 2.45 or newer. CI tests the maintained Node.js 22 and 24 release lines on Linux, macOS, and Windows.

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
  node dist/src/cli.js approve --config /absolute/path/reprogate.json '<action-id>'

REPROGATE_RECEIPT_SECRET='<at-least-32-byte-secret>' \
  node dist/src/cli.js verify-receipt --config /absolute/path/reprogate.json ./receipt.json
```

Do not treat these HMAC keys or filesystem observation as OS-level enforcement. See the threat model before enabling `action.execute`.

The separate host-only `git-review` CLI prepares an exact staged-effect request, signs an explicit operator-key decision, imports linked evidence, checks current authorization, and revokes ledger approval. Signing reads a protected key file only after staging and displays the full safely escaped diff; no default MCP approval tool is added. See the [operator review guide](docs/GIT_OPERATOR_REVIEW.md) for configuration, commands, limits and deployment separation.

The [Git promotion foundations](docs/GIT_PROMOTION_FOUNDATIONS.md) provide exact candidate objects and a cooperative ownership fence. Candidate preparation permits object/scratch writes and possible unreachable objects. The fence requires private host storage, cooperative writers and trusted-host child quiescence; it is not an OS sandbox. The [prepared promotion journal](docs/GIT_PROMOTION_JOURNAL.md) permanently consumes an exact linked signed approval in the existing SQLite ledger and guards raw revocation. Prepared records and status reads grant no dispatch authority. Final authenticated ref CAS, terminal evidence, conservative recovery and promotion CLI/config integration remain follow-up work.

The default server exposes exactly five tools, each with an output schema and conservative annotations:

- `catalog.search`: names, descriptions and effects only
- `catalog.describe`: one tool's input schema and the `schemaDigest` a plan binds
- `action.plan`: a compact summary (`actionId`, `decision`, `reasonCodes`, `nextStep`) by default; pass `detail: "full"` for the full envelope
- `action.inspect`: the complete persisted plan for one `actionId`
- `policy.explain`

When an executor is explicitly supplied, the server also registers `action.execute`. With an opt-in `mediation` configuration, it also registers `action.run`, which runs policy-`allow` read-only plans using a host-issued capability and returns redacted, bounded output. The CLI does this only after `serve --config <absolute-path>` successfully validates Runtime Configuration v1. See the [configuration guide](docs/CONFIGURATION.md). The included default catalog remains a deterministic, plan-only demo fixture.

A host can also opt in to the advisory `handoff_status` and `handoff_update` tools with `serve --handoff-config <absolute-path>`. They keep durable, caller-asserted session context for one configured workspace and project it to `.agent/handoff.md`. They never authorize actions. See the [handoff guide](docs/HANDOFF.md).

`reprogate research-server` is an optional backend that fetches a public page and returns its most relevant passages within an estimated token budget, with server-side request forgery protections. You configure it like any other backend, so fetches are planned and receipted. See [research](docs/RESEARCH.md).

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
                        execution receipt
```

Arguments are hashed and not stored raw in decision evidence. Tool schemas and effects come from an operator-controlled catalog, not from model-provided metadata. Workspace identity is reserved for gateway-observed values; the agent cannot label its own context as observed.

## Why this wedge

MCP gateways, policy engines, audit proxies, replay tools, and provenance systems already exist. ReproGate is designed to integrate with those systems, not rebuild all of them. Its differentiator is the portable contract spanning pre-execution authority and post-execution verification.

See [idea validation](docs/VALIDATION.md), the [phased roadmap](docs/ROADMAP.md), the [improvement backlog](docs/IMPROVEMENTS.md), and the [threat model](docs/THREAT_MODEL.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security vulnerabilities should be reported privately according to [SECURITY.md](SECURITY.md), never in a public issue.

## License

Apache-2.0.
