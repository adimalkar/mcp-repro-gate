# Idea validation — 2026-09-07

## Verdict

The problem is real, but the original category is crowded. Do not launch ReproGate as “a local-first MCP security gateway with audit and replay.” That description is no longer differentiated.

Proceed with a narrower thesis:

> ReproGate defines and enforces a portable action contract: exact-action authorization before execution and a verifier-bound receipt after execution.

This is a conditional **go**. The project earns continued investment only if the Phase 2 demo proves that a capability accepted for one proposed action fails after any material input, schema, policy, authority, or workspace change, and that the final receipt can be independently verified.

## What the current ecosystem already covers

| Existing project/category                                                                                                                    | Overlap with the original proposal                                                                                        | Consequence                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Stacklok ToolHive](https://github.com/stacklok/toolhive)                                                                                    | Local/cluster runtimes, per-request authorization, audit, isolation, registry, OTel, tool filtering, semantic tool search | Do not compete on gateway breadth, lifecycle management, or token reduction |
| [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/MCP-SECURITY-GATEWAY-1.0.md) | Security-gateway design, request/response scanning, signing, replay protection, schema drift, audit                       | Do not claim signing, drift detection, or a security gateway as novel       |
| [`mcp-audit`](https://github.com/P4ST4S/mcp-audit)                                                                                           | Transparent MCP proxy, signed audit trails, redaction, policy, rate limiting                                              | “Flight recorder” is insufficient differentiation                           |
| [`mcprec`](https://github.com/erphq/mcprec) and [`mcp-recorder`](https://github.com/devhelmhq/mcp-recorder)                                  | Deterministic record/replay and live verification of MCP transcripts                                                      | Do not make offline replay the primary wedge                                |
| [AgentProvenance](https://github.com/ByteYellow/AgentProvenance)                                                                             | Local-first evidence graphs spanning tool calls and runtime file/process/network telemetry                                | Do not claim generic provenance as unique                                   |
| [ChainCaps](https://github.com/Jxcup/chaincaps-code)                                                                                         | Monotonic capability lineage and one-shot declassification bound to sinks                                                 | Treat compositional lineage as prior art and an integration/research basis  |
| [Agent Rewind](https://github.com/moholo-founder/agent-rewind)                                                                               | MCP interception, journal, snapshots, policy gate, kill switch, rewind                                                    | Do not position rollback or a timeline UI as the core novelty               |

## Remaining gap worth testing

The opportunity is a small, vendor-neutral contract that joins facts usually stored in separate systems:

1. an operator-trusted tool/schema identity;
2. a digest of exact arguments without retaining raw sensitive values;
3. requested authority and predicted effects;
4. gateway-observed workspace/environment identity;
5. the exact policy revision and decision;
6. a single-use approval capability;
7. observed effects, verifier outcomes, and result digests in a receipt.

The first target user is not every agent user. It is an MCP/tool developer or platform engineer who needs approval and CI evidence to survive across agent hosts.

## Product improvements to the original report

- **Narrow the product:** contract/specification plus reference enforcement proxy, not an all-in-one agent control plane.
- **Start with one vertical slice:** avoid a twelve-package monorepo before runtime boundaries are proven.
- **Separate asserted and observed context:** host/model/workspace facts supplied by a caller cannot be treated as trusted evidence.
- **Keep approval out of the model-facing tool surface:** an agent must not mint its own authorization token.
- **Use trusted catalog metadata:** tool annotations assist discovery but cannot define their own authority.
- **Define canonicalization explicitly:** digest interoperability fails if different implementations serialize JSON differently.
- **Use a durable atomic replay store before real writes:** an in-memory consumed-token set is only a Phase 1 proof.
- **Make receipts verifiable, not merely logged:** Phase 2 should sign/export a receipt that another process can check.
- **Defer generic search, dashboards, OTel, Kubernetes, and hosted mode:** established projects are already stronger there.
- **Measure security properties:** tamper cases blocked, replay blocked, crash recovery, false approvals, and receipt verification matter more than stars.

## Kill criteria

Stop or reposition the project if Phase 2 cannot demonstrate at least two of these against existing tools:

- exact-action approval remains portable across two MCP clients;
- receipt verification works without trusting the running gateway process;
- observed repository effects can be matched to the approved envelope;
- a concrete time-of-check/time-of-use mutation is blocked;
- integration requires materially less work than adopting a full gateway platform.
