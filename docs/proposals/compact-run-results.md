# Compact action.run results: seventh Phase 4 slice

Status: proposed implementation. The façade measurement in #32 found that `action.run` makes small results larger: 100 bytes of downstream output became 1032 bytes. A large result also carried its bounded text about 2.3 times. This slice removes that overhead and re-measures with the same harness. The receipt, the executor and the evidence stay unchanged.

## Causes (measured on fixture v2)

- **The bounded downstream text is sent twice.** It appears once inside a pretty-printed, JSON-escaped text block that mirrors the whole result, and once again in `structuredContent.content`.
- **Every run summary carries two 71-character digests** (`receiptDigest` and `resultDigest`) that an agent rarely uses.
- **Every façade text block is pretty-printed** (`JSON.stringify(value, null, 2)`), adding indentation to every result.

## Deliverable

- **`action.run` returns:**
  - **`structuredContent`:** a compact summary, `{ detail: "compact", executionId, outcome, truncated, redactions, omittedItems }`.
  - **`content`:** first, a text block holding exactly that summary as compact JSON, which is the MCP compatibility mirror; then the redacted, bounded downstream text items, each sent once as plain text.
- **`action.run` with `detail: "full"`** adds `receiptDigest` and `resultDigest` to the summary. Operators can always read the full receipt from the execution record by `executionId`.
- **All façade tool results** mirror their `structuredContent` as compact JSON text instead of pretty-printed JSON.
- **Output schemas:** `actionRunOutputSchema` becomes a discriminated union on `detail`. No other output schema changes.

## Compatibility

`action.run` and its schema have not been released yet (#29), but this is still a change. Clients that read the downstream text from `structuredContent.content` must read the `content` items after the first. Clients that need digests pass `detail: "full"`. The CHANGELOG records both. Text blocks of every façade tool become compact JSON with the same data.

## Verification

- A real MCP client checks:
  - the summary in `structuredContent` and as the first text block;
  - the downstream text present once, redacted and bounded as before;
  - `detail: "full"` digests that match the stored receipt;
  - both summaries validating against the output schema in both protocol eras.
- `bench facade` re-run. The published numbers change and the fixture version is bumped. The small result's overhead must fall substantially, and nothing regresses in planning or discovery.
- The existing mediation, held-approval-independent and façade tests are updated for the new shape.
