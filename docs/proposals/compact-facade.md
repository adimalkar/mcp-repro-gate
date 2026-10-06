# Compact agent façade: second Phase 4 slice

Status: proposed implementation. This proposal follows the Phase 4 roadmap items for schema-on-demand discovery, compact typed results, and output schemas with conservative annotations. It claims no measured token savings: the roadmap benchmark across two hosts is still a separate slice.

## Deliverable

- `catalog.describe` returns one catalog entry's description, effects, declared authority, input schema, and `schemaDigest`. The digest equals the `tool.schemaDigest` a plan for that tool binds. `catalog.search` keeps returning names, descriptions, and effects only, so discovery stays small.
- `action.plan` returns a compact typed summary by default:
  - `actionId`, `envelopeDigest`, `toolRef`
  - `decision`, plus stable `reasonCodes` (the policy rule IDs, such as `default:network_write`)
  - `expiresAt`
  - a `nextStep` enum

  Callers that need the previous full response pass `detail: "full"`.

- `action.inspect` returns the complete persisted plan (envelope, envelope digest, policy decision) for one `actionId`. Full evidence stays available on demand without appearing in every planning result.
- Every façade tool declares an `outputSchema` and truthful annotations:
  - `catalog.*`, `policy.explain` and `action.inspect`: read-only, idempotent, closed-world.
  - `action.plan`: not read-only, because it persists a plan; not destructive; closed-world.
  - `action.execute`: the conservative defaults (possibly destructive, open-world).
- Results keep an MCP `text` block mirroring `structuredContent`, so hosts that ignore structured output see the same data.

## Next step contract

`nextStep` is derived only from the policy decision and the server's configuration. It is guidance, never authority:

| Condition                                | `nextStep`                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Decision `deny`                          | `stop`                                                                                                                         |
| Executor configured, decision not `deny` | `await_capability` (an out-of-band capability is still required; the model never receives approval authority from this result) |
| No executor configured                   | `plan_only`                                                                                                                    |

## Compatibility

The default `action.plan` result changes from the full plan to the compact summary. This is a breaking change for clients that read `envelope` or `policy` from the default result. Those clients migrate by passing `detail: "full"` or calling `action.inspect`. The package is pre-1.0 (`0.0.0`), and no persisted data or capability/receipt semantics change. Unknown tool references, unknown action IDs and invalid inputs keep returning `isError` results.

## Out of scope

Execution-result compaction and downstream output redaction belong to the host-mediation slice. Graph proxying, web research tools and benchmarks follow separately.

## Verification

- A real MCP client lists the tools and checks their `outputSchema` and annotations, then calls `catalog.describe`, compact and full `action.plan`, `action.inspect`, and `policy.explain`. All structured results validate against the declared schemas.
- `schemaDigest` from `catalog.describe` equals the bound `envelope.tool.schemaDigest` of a plan for the same tool.
- `nextStep` covers deny, the executor-configured path, and plan-only. The compact result contains no envelope fields beyond the listed summary.
- The configured runtime path (`serve --config`) still lists and executes as before.
