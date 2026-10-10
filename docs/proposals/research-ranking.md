# Rarity-weighted passage ranking: Phase 4 slice

Status: proposed implementation. The research measurement in #37 found that ranking is lexical. On the Node.js `net` page, the query "socket setKeepAlive initialDelay" kept the `initialDelay` passages, but it also spent part of the budget on a 1042-character paragraph about Unix domain sockets that matches only "socket".

## Cause

`score()` in `src/research/distill.ts` gives each query term the same weight: 10 points per distinct term matched, plus one per hit, up to five hits per term.

- On that page, "socket" appears in 313 of 1048 blocks, while `setkeepalive` and `initialdelay` appear in 13 and 14.
- A long block hitting "socket" five times scores 15. A short passage that names `initialDelay` once scores 11.
- Table-of-contents lines such as `socket.ref()` also match "socket". Headings repeat their contents entries word for word, apart from a trailing permalink character (`#`, `¶`).

## Deliverable

`selectRelevant` changes in three ways. Distillation, budgets and output format stay the same.

- **Weight terms by rarity on the page.** Each matched term contributes `idf × (10 + hits)`, with hits still capped at 5 and `idf = ln(1 + (N − df + 0.5) / (df + 0.5))` over the page's N blocks. Matching code still gets a small bonus. A term in most blocks weighs little, and a term in a handful of blocks dominates.
- **Drop blocks that match only common terms.** A term is common on the page when its weight is less than half the weight of the rarest query term found there. A block whose matched terms are all common, such as a paragraph that only says "socket" on a socket API page, is not selected. So results get smaller rather than padded. When every matched term is equally common, nothing is dropped. If no block matches, the existing fallback (the opening blocks, in page order) is unchanged.
- **Drop exact repeats.** A block whose text, minus a trailing `#` or `¶`, equals an earlier selected block is skipped.

Two alternatives were tried and rejected:

- **Standard BM25 length normalisation** favours the very short table-of-contents lines.
- **A cutoff at a quarter of the best block's score** dropped the fix code on the issue-tracker fixture. The best block there is the one that echoes the whole error message, so solution blocks matching only one or two terms fell below the cutoff. Long error queries, which `resolve_stuck_error` sends, make this worse.

## Measurement

Fixture (`bench research`, fixture v1): the median reduction rose from 98.1% to 99.5% against raw HTML, and from 65.5% to 91.9% against page text. All 6 answers are still kept. The Q&A and issue-tracker rows shrink most, because filler blocks that matched only common terms are no longer selected.

Saved real pages from #37, measured with `--html`:

| Page and query                                    | Measured B before | After | What changed                    |
| ------------------------------------------------- | ----------------: | ----: | ------------------------------- |
| Node.js `net`, "socket setKeepAlive initialDelay" |              7590 |  4730 | only keep-alive passages remain |
| MDN AbortController, "abort fetch request signal" |              2082 |  1786 | heading lines dropped           |
| Python asyncio, "gather return_exceptions"        |              7654 |  7654 | unchanged                       |
| Docker startup order, "depends_on condition …"    |              2773 |  2773 | unchanged                       |

## Verification

- Unit tests:
  - a long block with one common term ranks below a short block with a rare term;
  - weak matches are dropped;
  - repeats differing only by a permalink character are dropped;
  - the no-match fallback is unchanged.
- `bench research` keeps 6/6 answers. Its published numbers are updated, and any change is explained.
- The existing hostile-input test caught a quadratic regex in the first version of the repeat check (`/\s*[#¶]$/` on a 1 MB whitespace block). The check now uses `endsWith` and `trimEnd`.
- The saved real pages are re-measured with `--html`, and docs/RESEARCH.md drops or rewrites the "Ranking is lexical" caveat.
