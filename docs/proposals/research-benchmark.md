# Research measurement: eleventh Phase 4 slice

Status: proposed implementation. The Phase 4 exit criteria ask for a ">95% reduction on external research (distilled snippets vs. raw HTML)". `fetch_distilled` (#34) and `resolve_stuck_error` (#35) claim no reduction until it is measured. This slice adds a deterministic, re-runnable measurement and publishes its numbers with their limits.

## Deliverable

- **`reprogate bench research [--json]`** runs a fixed fixture of HTML pages through the real research server, with an in-memory MCP client and an injected page fetcher, so no network is used.
  - **Measured:** the UTF-8 bytes a host receives from each tool call: its text content, `structuredContent` and `isError`, as in the façade measurement.
  - **Baselines:**
    - **raw HTML:** the page as a plain fetch tool would return it. This is the roadmap's baseline.
    - **page text:** every visible text node outside `head`, `script`, `style` and `template`, with whitespace collapsed, like a naive HTML-to-text tool. Navigation, footers and comments stay in. This baseline is stricter: chrome that inflates raw HTML cannot inflate it.
  - **Answer check:** each fixture page names one answer sentence that a useful result must contain. A row whose result drops it is marked, so a reduction cannot come from discarding the answer.
  - Every call must succeed; a failed call stops the run instead of being measured.
- **Fixture v1** (`src/research/benchmark.ts`), generated deterministically in code. No third-party pages are vendored. There are five pages modeled on common research targets:
  1. an API reference page;
  2. a Q&A thread;
  3. a tutorial blog post;
  4. an issue tracker thread;
  5. a small, minimally marked-up page, where little can be saved.
  - `resolve_stuck_error` is measured once, over three of these pages, against the sum of their baselines.
- **`reprogate bench research --html <file> --query <text> [--json]`** measures one locally saved page the same way, so operators can check real pages without the harness fetching anything.
- **Docs:** a measurement section in `docs/RESEARCH.md` with the published numbers, how they were produced, and what they do not show. A test fails if the published numbers drift from the harness. CHANGELOG is updated too.

## Honesty constraints

- The fixture pages are synthetic. Their size and markup are modeled on common page types, but real pages vary widely. The docs say so, and they separate fixture numbers from any manual run on real pages.
- Results are measured in bytes, and tokens are estimated at 4 bytes per token. Host tokenizers differ.
- The median across fixture rows is reported against both baselines. The answer check is reported next to it.
- `fetch_distilled` currently sends its text in both `content` and `structuredContent`. Both are counted. If that duplication matters, it is reported as a finding, not hidden.

## Verification

- Unit tests:
  - the report is deterministic across runs;
  - every fixture answer is kept;
  - the page-text baseline excludes scripts and styles but keeps navigation text;
  - a failed call is refused rather than measured;
  - `--html` measures a local file and rejects missing arguments.
- The published-numbers test compares the tables in `docs/RESEARCH.md` with the harness.
- The CLI prints the same JSON as the library.
