# Compact graph views

Status: proposed implementation. Follows mirror deduplication (#38) and the
measured discovery findings (#40); implementation is stacked on #38.

## Problem

The published code-discovery run found that exact-name graph search returns
more bytes than focused grep. Search/snippet replies include fingerprints,
token streams and many diagnostic fields. Mirror deduplication removes the
second copy but still shows all of that metadata.

## Contract

Add optional host configuration under mediation.result.graphViews:

    [
      { "serverRef": "graph", "toolName": "search_graph", "view": "search" },
      { "serverRef": "graph", "toolName": "get_code_snippet", "view": "snippet" }
    ]

At most 64 unique server/tool identities, all present in the operator's catalog.
No suffix matching or automatic discovery. Unconfigured tools keep their
existing view. No agent-facing tool schema or execution authority changes.

The search view retains total, has_more, and every result's name, qualified
name, label, file path and available line count. The snippet view retains name,
qualified name, label, file path, start/end lines and the complete source.
Each projected payload contains a graph_search_v1 or graph_snippet_v1 view
marker, making intentional diagnostic-field omission explicit.

Project only a recognized successful graph response with one JSON text item,
optionally mirrored exactly in structuredContent. Reject unknown payload/row
fields rather than hide possible future warnings. Errors, non-mirrored text,
non-text items, malformed data and replies above a fixed 64 Ki-character
aggregate processing window fall back to the existing bounded view.

Before removing fields, check the complete original text and structured JSON
for host redaction matches. Any match keeps the original view, preserving
cross-field host patterns and redaction counts. Projected text still passes
through the existing redaction and UTF-8 byte bound. Pagination, results and
source are never intentionally dropped; byte truncation remains explicit.

The executor signs the original resultDigest before projection. There is no
new raw-result retention or retrieval endpoint: receipts retain digests as
before, not raw source. Removing this configuration restores normal views on
subsequent runs; the executor API still returns the original downstream result.

## Verification

- Configuration/schema agreement, unknown tools and duplicate identities.
- Search pagination, complete snippet source, text-only and mirrored results,
  unchanged unconfigured tools, and immutable downstream result objects.
- Safe fallbacks for errors, extra notices/fields/content, malformed replies,
  size limits, secret/token echoes and cross-field host patterns.
- A real executor/store/MCP action.run integration verifies the signed digest
  against the full original result while the model receives a compact view.
- Replay #40's six actual graph replies through the old/new mediated views,
  preserve all answer/source checks, and publish measured bytes plus raw views.
  Do not infer host-token or two-host results from this replay.

The default remains unchanged. This is a presentation feature for exact-name
lookup/read workflows, not a general replacement for graph diagnostics.
