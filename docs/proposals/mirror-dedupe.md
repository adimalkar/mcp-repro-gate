# Skip duplicated structured mirrors in mediated results: Phase 4 slice

Status: proposed implementation. The research measurement in #37 found that duplicated text is the largest remaining cost of `fetch_distilled` and `resolve_stuck_error`. That finding counted both channels a host receives directly. Behind the gateway the duplication is worse: `action.run` builds its view from the downstream text items **and** the JSON of the downstream `structuredContent`. So a research result's distilled text is shown twice inside one `maxTextBytes` budget, and the second copy is JSON-escaped.

## Cause

`HostMediator.bound` adds `JSON.stringify(structuredContent)` after the text items without checking what the text items already carry. There are two common cases:

- **A full mirror.** The MCP specification asks a tool that returns `structuredContent` to also return its serialized JSON as text. Many servers do, often pretty-printed, so the view holds the same data twice.
- **A field mirror.** A tool sends readable text as content and the same string as one `structuredContent` field, next to some metadata. The research tools do this with `text`.

Dropping the text from one channel in the research server was rejected: #33's review established that some hosts show the model only text and others only `structuredContent`. The fix belongs where the duplication happens, in the mediated view.

## Deliverable

When building the view, `bound` compares `structuredContent` with the downstream text items:

- **Skip a full mirror.** If a text item that parses as JSON holds the same value as `structuredContent` (compared through `JSON.stringify` after parsing, so pretty-printing does not matter), nothing is appended.
- **Omit mirrored fields.** Otherwise, if `structuredContent` is an object, top-level string fields whose value equals a text item exactly are left out of the appended JSON. If no fields are left, nothing is appended.
- Everything else is unchanged: redaction, the byte bound, the stop-at-first-cut rule, `omittedItems`, and the receipt's `resultDigest`, which still covers the complete downstream result.

Nothing visible is lost. Every omitted value is already shown, verbatim, in an earlier text item under the same bound, and `structuredContent` was always appended last.

## Compatibility

The model-visible text of `action.run` changes for downstream tools that mirror. Hosts parsing that text as "text items, then structured JSON" may see one item fewer or an object without the mirrored fields. `action.run` has not been released yet (#29). The CHANGELOG records the change.

## Verification

- Unit tests on `bound`:
  - a compact and a pretty-printed full mirror both produce one item;
  - a research-shaped result keeps its metadata and drops only `text`;
  - a non-mirroring `structuredContent` is appended unchanged;
  - near misses (different value, nested string, array) are still appended;
  - redaction counts and truncation are unchanged.
- An end-to-end `action.run` through the stdio fixture shows a mirrored result once.
- The research-shaped unit test checks that the view at the default research budget is at most about half its former size.
