# Benchmarks

The Phase 4 exit criteria ask for measurements before any claim of savings. This page has two parts:

- an **in-repository façade measurement**, which is deterministic and anyone can re-run;
- a **manual two-host protocol** for the host-level metrics, which can't be measured from inside this repository.

## Façade measurement

```sh
npm run build
node dist/src/cli.js bench facade          # table
node dist/src/cli.js bench facade --json   # machine-readable report
```

The harness runs fixed operations through a real in-memory MCP client against a ReproGate server, using a published synthetic catalog of 14 code-graph-shaped tools (`src/benchmark.ts`, fixture v2). It counts UTF-8 bytes of what a host receives. For tool calls, that is the text content, `structuredContent` and `isError`, on both the measured and the baseline side. Every call must succeed; a failed call stops the run instead of being measured.

### Context cost

A host first loads tool definitions, then spends calls finding a tool:

| Item                               | Bytes |
| ---------------------------------- | ----: |
| façade tool list                   |  9781 |
| direct tool list                   |  4964 |
| finding a tool (search + describe) |  2498 |
| average downstream tool definition |   355 |
| break-even catalog size (tools)    |    35 |

- **Façade tool list:** ReproGate's own `tools/list`, including output schemas.
- **Direct tool list:** every downstream definition, as a host would see by proxying the tools directly.
- **Finding a tool:** one `catalog.search` with three hits plus one `catalog.describe`.

The façade's own tool list is about twice the 14 downstream definitions it replaces. So on this fixture, discovery through the façade costs more context than loading the tools directly. It breaks even at about 35 downstream tools when an agent looks up one tool per session. Each further tool looked up adds another `catalog.describe` (here 1.2–1.7 KB) and raises the break-even. The façade's cost per lookup stays flat as the catalog grows, while a direct list keeps growing.

### Tool results

| Tool result             | Measured                               | Baseline                            | Measured B | Baseline B | Reduction | Truncated |
| ----------------------- | -------------------------------------- | ----------------------------------- | ---------: | ---------: | --------: | --------- |
| planning                | `action.plan`, compact default         | `action.plan` with `detail: "full"` |        852 |       3114 |     72.6% | no        |
| execution, large result | `action.run`, default 16384-byte limit | the unredacted downstream result    |      38064 |      51660 |     26.3% | yes       |
| execution, small result | `action.run`, default limit            | the unredacted downstream result    |       1032 |        100 |   -932.0% | no        |

**Median tool-result reduction on this fixture: 26.3%.** With three rows, the median is the middle row: the truncated large result. This is a fixture check, not an exit-criterion result. The roadmap criterion concerns host tokens across real tasks, which only the two-host runs below can measure.

### What these numbers do and do not show

- **Bytes, not tokens.** Hosts tokenize differently. Host token counts belong to the two-host runs.
- **Truncation is not a free saving.** The large-result row is smaller only because `action.run` cuts the downstream text at the limit: the agent sees about 16 KiB of a much larger result and loses the rest. The `truncated` column marks it.
- **Small results get larger.** `action.run` adds a fixed summary (execution ID, outcome, receipt and result digests, flags), and repeats the bounded text in `structuredContent`. For a small result, that overhead dominates.
- **Planning** saves a roughly constant amount per call. The full baseline is today's `detail: "full"` output. It carries the envelope and policy the pre-#27 default returned, plus `detail` and `nextStep`.
- **Text and `structuredContent` are both counted,** because ReproGate sends the same data in both. A host that shows the model only one of them sees less than measured.
- **This fixture only.** The catalog and results are synthetic, and execution is simulated: no backend process is spawned.
- **Not measured here:** multi-call workflows, call counts, completion rate, and the roadmap's code-discovery-versus-grep and research-versus-HTML comparisons.

## Two-host protocol (manual)

This protocol measures the Phase 4 exit criteria in real hosts. Run it in at least two MCP hosts, such as Claude Code and Codex CLI, with each host's own model settings fixed for the whole run.

**Setup:**

- A runtime configuration with the code graph backend ([CODE_GRAPH.md](CODE_GRAPH.md)), mediation for `local_read`, and held approvals.
- A pinned repository commit to work on.
- The same task list and prompts in every host.

**Tasks** (at least five, each with a scripted pass/fail check):

1. Find where a named function is defined and who calls it.
2. Explain a module's dependencies.
3. Make a one-file code change that needs an approval-required write: plan it, hold the approval, run it.
4. Recover from an injected failure: the first run of a tool returns an error.
5. Resume a task in a second host from `handoff_status` without re-prompting.

**Record per host and task:**

- agent-visible tool-result tokens, from the host's usage report;
- the number of tool calls;
- pass or fail;
- approval time (from `awaiting_approval` to `--hold`);
- whether the agent recovered from the injected failure.

**Comparison:** each task run with the current façade against the same task with direct downstream tools and token-based approval, where the host supports both.

**Record template:**

| Host | Task | Façade tokens | Baseline tokens | Calls | Pass | Approval time | Recovered |
| ---- | ---- | ------------: | --------------: | ----: | ---- | ------------- | --------- |
|      |      |               |                 |       |      |               |           |

An exit criterion counts as met only when the measured medians across hosts and tasks clear it. Publish the raw records next to the summary.
