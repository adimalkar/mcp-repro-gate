# Compact graph views: replay measurement

Compact graph views shrink what the model sees from a mediated graph lookup. Replaying the six recorded graph replies from the code-discovery run (#40), the median reduction is **78.5%** for location queries (`search_graph`) and **58.4%** for location plus implementation reading (`search_graph` plus `get_code_snippet`). The baseline is the existing mediated view, after mirror deduplication. These are bytes, not host tokens.

## What is measured

- **Input:** the six actual codebase-memory-mcp 0.9.0 replies recorded in `docs/benchmarks/code-discovery-v1.json` at commit `e4c9600`. The input fixture pins that file by digest (`docs/benchmarks/graph-views-input-v1.json`). Nothing is fetched or launched.
- **Before:** `HostMediator.bound()` without a graph view, which is today's mediated view with mirror deduplication and the default `maxTextBytes` of 16384. The bytes counted are the JSON-serialized bounded content.
- **After:** the same call with the `search` or `snippet` view configured.
- **Checks:** every task must still name the expected file. The snippet's source must match the pinned Git source byte for byte, newlines included, and must contain the expected implementation fragment. A failed check stops the run.

Reproduce, with no graph binary needed:

```sh
npm run bench:graph-views
```

[The report](benchmarks/graph-views-v1.json) contains every before and after view.

## Results

| Function                             | Locate before B | After B | Reduction | Locate + read before B | After B | Reduction |
| ------------------------------------ | --------------: | ------: | --------: | ---------------------: | ------: | --------: |
| `canonicalJson`                      |           1,561 |     348 |     77.7% |                  5,113 |   2,680 |     47.6% |
| `evaluatePolicy`                     |           1,590 |     334 |     79.0% |                  4,241 |   1,722 |     59.4% |
| `issueCapabilityToken`               |           1,748 |     366 |     79.1% |                  4,320 |   1,549 |     64.1% |
| `verifyExecutionReceipt`             |           1,595 |     352 |     77.9% |                  4,346 |   1,853 |     57.4% |
| `deriveGitApprovalAuthorityFromPlan` |           1,943 |     394 |     79.7% |                  7,778 |   4,674 |     39.9% |
| `loadGitReviewConfigSnapshot`        |           1,689 |     382 |     77.4% |                  4,219 |   1,598 |     62.1% |

Location queries shrink most: each search row drops its fingerprint, token stream and about 20 diagnostic fields. Snippets keep their complete source, which is most of their size.

## Against the grep baseline, for context only

The code-discovery run (#40) compared the graph's complete MCP payloads with focused `rg` output, plus complete reads of the matched files for the implementation task. Neither comparison passed the roadmap's >90% target: implementation reading measured 74.3% at the median, and location was worse than grep. The table below puts the compact view's bytes next to #40's grep bytes:

| Function                             | Compact locate B | Grep B | Reduction | Compact locate + read B | Grep + full files B | Reduction |
| ------------------------------------ | ---------------: | -----: | --------: | ----------------------: | ------------------: | --------: |
| `canonicalJson`                      |              348 |  2,623 |     86.7% |                   2,680 |             133,811 |     98.0% |
| `evaluatePolicy`                     |              334 |    610 |     45.2% |                   1,722 |              30,986 |     94.4% |
| `issueCapabilityToken`               |              366 |    339 |     -8.0% |                   1,549 |              25,592 |     93.9% |
| `verifyExecutionReceipt`             |              352 |    222 |    -58.6% |                   1,853 |              12,317 |     85.0% |
| `deriveGitApprovalAuthorityFromPlan` |              394 |  1,358 |     71.0% |                   4,674 |              59,282 |     92.1% |
| `loadGitReviewConfigSnapshot`        |              382 |    413 |      7.5% |                   1,598 |              43,226 |     96.3% |

Medians: **26.4%** for location and **94.2%** for implementation reading.

This does **not** show that the roadmap criterion is met:

- **Different accounting.** #40 counted complete MCP payloads. This table counts one copy of the bounded view and leaves out the `action.run` summary. A host that shows the model both text content and `structuredContent` receives roughly twice the view, plus the summary on every call.
- **A narrow baseline.** It reads complete matched files. An agent that narrows its grep or reads only selected lines would use far fewer bytes.
- **A narrow fixture.** It covers six exact-name lookups on one repository, not exploration or call-graph tasks.
- **No host tokens.** Host token counts and task completion need the two-host runs.

Location queries still often cost more than grep, whose output for a unique name is a single line.
