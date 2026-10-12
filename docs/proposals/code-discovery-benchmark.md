# Code discovery measurement

Status: proposed implementation. Follows the Phase 4 graph-proxy slice (#30).

## Problem

The roadmap targets >90% less agent-visible output for graph discovery than raw
grep, but no reproducible measurement exists. Comparing a graph snippet with an
entire repository dump would obscure the cost of a focused text search.

## Deliverable

An optional developer benchmark runs an installed `codebase-memory-mcp` and `rg`
against the same immutable snapshot of ReproGate's `src/` tree. Six fixed tasks
locate a named function and read its implementation. The corpus is pinned to
main commit `6eabc20f04f1a0fe9edede5ab36a4338000bd155` and extracted with Git;
uncommitted source is never used. Fixtures contain expected file names and
implementation fragments, independent of the graph's answers.

Report two comparisons separately:

1. Location: exact-name graph search versus `rg -n -w -F` over `src/`.
2. Implementation: graph search plus the selected function snippet versus the
   same rg output plus the complete matched files, each read once per task.

Both are explicit workflows, not claims that full-file reads are necessary.
Negative savings remain visible. Measure UTF-8 response bytes (including MCP
text and structured mirrors), request bytes, call counts, and answer checks;
do not label bytes as host tokens. Report raw transcripts, tool versions,
binary digest, corpus/tree digest, pinned revision, and fixture version for
reproduction. Abort rather than report savings on tool errors, ambiguous or
missing symbols, truncated results, missing answers, or mismatched source.

The graph server uses a fresh temporary working directory and private
`CBM_CACHE_DIR`; disable auto-index, auto-watch, and UI in that private config.
Index only the exported corpus, without persistence, and remove temporary
state after closing the MCP client. Never change the operator's saved config,
existing graph indexes, or `.codebase-memory` artifacts. No network research,
gateway execution, approval, or protected-ref changes are part of the run.

The external graph binary remains optional and is not installed or launched
by CI. Tests cover fixture/source checks and failure handling without requiring
it. Publish a real local run alongside the methodology; the >90% target may
remain unmet. Host tokenization and two-host task evaluation remain separate.
