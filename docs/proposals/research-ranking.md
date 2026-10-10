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
- **Drop weak matches.** Blocks scoring below a quarter of the best block are not selected. A block that matches only a common term no longer fills leftover budget, so results get smaller rather than padded. If no block matches, the existing fallback (all blocks, in page order) is unchanged.
- **Drop exact repeats.** A block whose text, minus a trailing `#` or `¶`, equals an earlier selected block is skipped.

Standard BM25 length normalisation was tried and rejected. It favours the very short table-of-contents lines.

## Measurement (manual prototype, saved pages from #37)

| Page and query                                    | Selected chars before | After | What changed                    |
| ------------------------------------------------- | --------------------: | ----: | ------------------------------- |
| Node.js `net`, "socket setKeepAlive initialDelay" |                 ~3600 |  2134 | only keep-alive passages remain |
| MDN AbortController, "abort fetch request signal" |                   831 |   693 | five heading lines dropped      |
| Python asyncio, "gather return_exceptions"        |                  3464 |  3464 | unchanged                       |
| Docker startup order, "depends_on condition …"    |                  1110 |  1110 | unchanged                       |

## Verification

- Unit tests:
  - a long block with one common term ranks below a short block with a rare term;
  - weak matches are dropped;
  - repeats differing only by a permalink character are dropped;
  - the no-match fallback is unchanged.
- `bench research` keeps 6/6 answers. Its published numbers are updated, and any change is explained.
- The saved real pages are re-measured with `--html`, and docs/RESEARCH.md drops or rewrites the "Ranking is lexical" caveat.
