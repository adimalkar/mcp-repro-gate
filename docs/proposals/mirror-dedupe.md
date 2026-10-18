# Skip duplicated structured mirrors in mediated results: Phase 4 slice

Status: proposed implementation. The research measurement in #37 found that duplicated text is the largest remaining cost of `fetch_distilled` and `resolve_stuck_error`. That finding counted both channels a host receives directly. Behind the gateway the duplication is worse: `action.run` builds its view from the downstream text items **and** the JSON of the downstream `structuredContent`. So a research result's distilled text is shown twice inside one `maxTextBytes` budget, and the second copy is JSON-escaped.

## Cause

`HostMediator.bound` adds `JSON.stringify(structuredContent)` after the text items without checking what the text items already carry. There are two common cases:

- **A full mirror.** The MCP specification asks a tool that returns `structuredContent` to also return its serialized JSON as text. Many servers do, often pretty-printed, so the view holds the same data twice.
- **A field mirror.** A tool sends readable text as content and the same string as one `structuredContent` field, next to some metadata. The research tools do this with `text`.

Dropping the text from one channel in the research server was rejected: #33's review established that some hosts show the model only text and others only `structuredContent`. The fix belongs where the duplication happens, in the mediated view.

## Deliverable

When building the view, `bound` compares `structuredContent` with the downstream text items:

- **Skip a full mirror.** Nothing is appended if a text item is the same JSON as `structuredContent`. The test re-serialises the text item after parsing it, so pretty-printing and other JSON-equivalent spellings match; a different key order does not.
- **Mark mirrored fields.** Otherwise, if `structuredContent` is an object, a top-level string field whose value equals a text item is replaced by the marker `"[text item N]"`, where N is the first equal item. Field names and order are kept. Values no longer than the marker, including empty strings, are kept as they are.
- **Keep everything else whole.** The structured JSON is appended unchanged when:
  - redacting it would find anything (token shapes, secret fragments or host patterns), because removing text could break a host pattern that spans fields, and skipping a copy would lower the redaction count;
  - it is longer than `maxTextBytes` plus the redaction slack. It would be cut, and only a prefix of it shown.
- **Build it only when it can be shown.** The comparison runs only after every text item has been shown whole with budget left over, since the structured JSON comes last. A cut view does no extra work, and each compared item is within the bound's window.
- Redaction, the byte bound, the stop-at-first-cut rule, `omittedItems` and the receipt's `resultDigest` are unchanged. `resultDigest` still covers the complete downstream result.

What the model loses is a second copy. Every removed value is shown in an earlier text item under the same bound, and a marker names that item. `structuredContent` was always appended last.

- **Changed results:** `truncated` can be `false` where the duplicate used to overflow the bound, and more of the result fits.
- **Unchanged counts:** whenever deduplication applies, the structured copy had no redactions, so `redactions` stays the same.

## Compatibility

The model-visible text of `action.run` changes for downstream tools that mirror. Hosts that parse it as "text items, then structured JSON" may get one item fewer, or an object with marker values. `action.run` has not been released yet (#29). The CHANGELOG records the change.

## Verification

- Unit tests on `bound`:
  - compact and pretty-printed full mirrors, first or later in the text items, produce no structured copy;
  - a research-shaped result keeps its metadata and marks only `text`, and its view at the default research budget is at most about half its former size;
  - markers name the first equal item, duplicate fields share it, short and empty values are kept, and a `__proto__` key survives;
  - near misses (a different value, a nested string, an array, `{}`, non-JSON text) are appended whole;
  - a host pattern spanning fields still redacts, and a `\u`-escaped secret mirror keeps its redaction count;
  - an item longer than the bound leaves the structured JSON alone;
  - `truncated` can become `false` while `redactions` is unchanged.
- An end-to-end `action.run` through the stdio fixture shows a self-mirroring result once.

## Review

- **High (fixed): redaction.** Removing fields could break a host pattern match spanning fields, such as a PEM block, and expose the parts left in place. Fix: deduplication now applies only when redacting the structured JSON finds nothing.
- **Medium (fixed): the redaction count.** Skipping a copy could hide that count. The gate above fixes this as well.
- **Medium (fixed): parsing cost.** Every JSON-looking text item was parsed in full before the bound applied. Fix: the comparison now runs only after the text items are shown whole.
- **Medium (fixed, round 2): field lookup.** Each field searched every text item, so a result with many tiny text items could block the event loop for seconds. Fix: one map from text to its first item number.
- **Accepted (round 2):** host patterns are checked on the whole structured JSON, while the old view checked the part that fit. Only end-anchored, `\b` or lookahead patterns can differ, and only at a cut point that already moved with the bound. A downstream value that is literally `"[text item 2]"` looks like a marker, but it gains nothing a matching text item would not.
- **Medium (fixed): field names.** Deleted fields lost their names. Fields now keep their names and point to the text item with a marker.
- **Low (fixed): claims and tests.** The docs claimed unchanged truncation, and the tests did not check redaction counts. Both are corrected.
