# Rarity-weighted passage ranking: Phase 4 slice

Status: proposed implementation. The research measurement in #37 found that ranking is lexical. On the Node.js `net` page, the query "socket setKeepAlive initialDelay" kept the `initialDelay` passages, but it also spent part of the budget on a 1042-character paragraph about Unix domain sockets that matches only "socket".

## Cause

`score()` in `src/research/distill.ts` gives each query term the same weight: 10 points per distinct term matched, plus one per hit, up to five hits per term.

- On that page, "socket" appears in 313 of 1048 blocks, while `setkeepalive` and `initialdelay` appear in 13 and 14.
- A long block hitting "socket" five times scores 15. A short passage that names `initialDelay` once scores 11.
- Table-of-contents lines such as `socket.ref()` also match "socket". Headings repeat their contents entries word for word, apart from a trailing permalink character (`#`, `¶`).

## Deliverable

`selectRelevant` changes as follows. Distillation, budgets and the output format stay the same.

- **Weight terms by rarity on the page.** Each matched term contributes `idf × (10 + hits)`, with hits still capped at 5 and `idf = ln(1 + (N − df + 0.5) / (df + 0.5))` over the page's N blocks. Matching code still gets a small bonus. A term in most blocks weighs little, and a term in a handful of blocks dominates.
- **Demote blocks that match only common terms in `fetch_distilled`.** A term is common on the page when its weight is less than half that of the rarest query term found there. Blocks whose matched terms are all common rank after every other match. They fill in only when the other matches use less than half the budget. When everything else is thin, recall wins. - **Keep equal term weights in `resolve_stuck_error`.** It passes `rarity: false`, which restores the previous scoring (10 per distinct term plus hits) with no demotion. The error term is common by construction on a page about that error. Rarity would rank comments that hit "read" only as a substring (in "already") above a fix that just names the error, and the fixture's resolver row showed no gain from rarity anyway.
- **Keep one copy of repeated text blocks.** Blocks are repeats when their text matches apart from a trailing `#` or `¶`. The copy kept is the one ending in a permalink character, which is the section heading wherever its contents entry sits; otherwise the first copy is kept. Code blocks are never treated as repeats.
- **Bound the work.** A query keeps its first 64 distinct terms. Per-block hits are stored sparsely (only the terms a block contains), and document frequency is counted in the same pass.

## Measurement

- **Fixture** (`bench research`, fixture v1): the median reduction is 98.1% against raw HTML (unchanged) and 65.1% against page text (65.5% before). All 6 answers are still kept.
  - The Q&A row's selection changed slightly: 3600 text bytes, up from 3545.
  - On the Q&A and issue rows, the answer passages alone use less than half the budget, so filler blocks that match only common terms still fill in.
- **Saved real pages from #37** (`--html`):

| Page and query                                    | Measured B before | After | What changed                                                               |
| ------------------------------------------------- | ----------------: | ----: | -------------------------------------------------------------------------- |
| Node.js `net`, "socket setKeepAlive initialDelay" |              7590 |  4736 | only keep-alive passages remain; section headings replace contents entries |
| MDN AbortController, "abort fetch request signal" |              2082 |  2082 | unchanged                                                                  |
| Python asyncio, "gather return_exceptions"        |              7654 |  7654 | unchanged                                                                  |
| Docker startup order, "depends_on condition …"    |              2773 |  2773 | unchanged                                                                  |

The gain is narrow. It removes padding when the distinctive passages already fill at least half the budget, and it removes repeated headings. It does not reduce filler on thin results.

## Verification

- Unit tests:
  - under budget pressure, a short rare-term passage beats a long common-term block;
  - common-only blocks are left out when the rest fills half the budget;
  - repeats keep the section heading, and code blocks are never treated as repeats;
  - common-only blocks fill in on an MDN-style page where "method" matches only a heading;
  - the same holds on an issue thread where the error term is in every block and "read" only in the title, and on a four-block page;
  - at a resolver-sized share, weighted ranking loses a fix that names only the error and equal weights keep it; through the real `resolve_stuck_error` tool the fix is kept;
  - on a Sphinx-ordered page, the heading is kept over the later contents entry, and other repeats keep their first copy;
  - the no-match fallback is unchanged;
  - 200,000 tiny blocks with a 400-term query finish well within the limit.
- `bench research` keeps 6/6 answers. The published numbers are updated, and the real pages were re-measured and read by hand.

## Review

- **First draft (rejected): a cutoff at a quarter of the best block's score.** It dropped the fix code on the issue-tracker fixture, whose best block echoes the error message.
- **Second draft, HIGH (fixed): dropping common-only blocks outright.**
  - One incidental rare hit hid the answer:
    - on the real MDN page, "AbortController abort method" returned only "Instance methods";
    - on an issue thread, "read ECONNRESET" returned only the title;
    - on a four-block page, the fix was dropped.
  - Fix: such blocks are now demoted and fill in when the rest is thin.
- **Second draft, HIGH (fixed): memory and CPU on many-block pages.** Dense per-block count arrays took 1950 ms and 439 MB for 233,000 blocks and 170 terms, against 211 ms and 120 MB before. Fix: sparse hits and a 64-term cap bring this to about 120 ms and 185 MB.
- **Second draft, MEDIUM (fixed): overclaiming docs.** The docs now state the remaining limits: substring matching, thin results that still carry filler, and leftover chrome that holds a unique term. The MDN page no longer changes.
- **Second draft, LOW (fixed): repeats kept the contents entry.** They now keep the section heading. The tests now cover budget pressure, small pages and the repeat choice.
- **Round 2, HIGH (fixed): the backfill threshold on the resolver path.** Each page gets about 1100 characters there. Substring hits ("read" in "already" and "thread") could fill half of that, so the fix, which mentions only the common error term, was dropped. Fix: the resolver turns demotion off, and a test reproduces the case at that share.
- **Round 2, MEDIUM (fixed): Sphinx keeps its contents after the article.** "Keep the later copy" therefore kept the sidebar entry over the real `Awaitables¶` heading. Fix: the copy ending in a permalink character wins, otherwise the first.
- **Round 2, LOW (fixed): the speed test did not catch dense counts.** It now uses 400 terms, which fails on the dense draft.
- **Round 3, MEDIUM (fixed): rarity weighting alone still lost resolver fixes.** With five comments hitting "already", weighted ranking lost a twice-named fix at 265 of 311 budgets between 500 and 3600; flat ranking lost it at none. Fix: the resolver uses `rarity: false`. A unit test pins both behaviours at 1200 characters.
- **Round 3, LOW (fixed): no test of the resolver option.** A tool-level `resolve_stuck_error` test fails without `rarity: false`.
- **Not fixed: unique terms in leftover chrome.** On the Docker page, the query "service_healthy method" ranks a leftover inline script first, because "method" occurs only there. A density rule (hits per character) was tried, but it made the Node.js and Python results worse. The limit is documented instead.
- **Caught by an existing test:** the first repeat check used a quadratic regex. The hostile-input test caught it, and the check now uses `endsWith` and `trimEnd`.
