# Compact action.run results: seventh Phase 4 slice

Status: proposed implementation. The façade measurement in #32 found that `action.run` makes small results larger: 100 bytes of downstream output became 1032 bytes. A large result also carried its bounded text about 2.3 times. This slice removes that overhead and re-measures with the same harness. The receipt, the executor and the evidence stay unchanged.

## Causes (measured on fixture v2)

- **The bounded downstream text is sent twice.** It appears once inside a pretty-printed, JSON-escaped text block that mirrors the whole result, and once again in `structuredContent.content`.
- **Every run summary carries two 71-character digests** (`receiptDigest` and `resultDigest`) that an agent rarely uses.
- **Every façade text block is pretty-printed** (`JSON.stringify(value, null, 2)`), adding indentation to every result.

## Deliverable

- **`action.run` returns:**
  - **`structuredContent`:** a compact summary, `{ detail: "compact", executionId, outcome, truncated, redactions, omittedItems, content }`, where `content` is the redacted, bounded downstream text.
  - **`content`:** first, the summary's JSON without `content`; then the same bounded text as plain, unescaped text items. Some hosts show the model only `structuredContent` and others only text, so both carry the output. The text side is no longer a JSON-escaped copy of everything.
- **`action.run` with `detail: "full"`** adds `receiptDigest` and `resultDigest`. Operators can always read the full receipt from the execution record by `executionId`.
- **All façade tool results** mirror their `structuredContent` as compact JSON text instead of pretty-printed JSON.
- **Output schema:** `actionRunOutputSchema` is a single object with optional digests. That costs less in every tool list than a compact/full union would.
- Review change: the first version dropped the bounded text from `structuredContent`, which hides the output from hosts that read only `structuredContent`. Restoring it costs bytes, which the re-measurement reports. The façade tool list grew by 134 bytes; tool list plus finding a tool still fell by 242 bytes per session.

## Compatibility

`action.run` and its schema have not been released yet (#29), but this is still a change. `structuredContent.content` still holds the bounded downstream text. The digests moved behind `detail: "full"`, and the text items after the first are now plain text. The CHANGELOG records both. Text blocks of every façade tool become compact JSON with the same data.

## Verification

- A real MCP client checks:
  - the summary in `structuredContent` and as the first text block;
  - the downstream text present once per channel (text and `structuredContent`), redacted and bounded as before;
  - `detail: "full"` digests that match the stored receipt;
  - both summaries validating against the output schema in both protocol eras.
- `bench facade` re-run. The published numbers change and the fixture version is bumped. The small result's overhead must fall substantially. Any regression, such as a larger tool list, must be reported with its cause.
- The existing mediation, held-approval-independent and façade tests are updated for the new shape.
