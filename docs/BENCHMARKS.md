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

The harness runs four fixed operations through a real in-memory MCP client against a ReproGate server, using a published synthetic catalog of 14 code-graph-shaped tools (`src/benchmark.ts`, fixture v1). For each operation it reports the UTF-8 bytes of everything the host receives for one call: the text content, `structuredContent` and `isError`. It sets that against a stated baseline:

| Operation      | Measured                              | Baseline                                                           | Measured B | Baseline B | Reduction |
| -------------- | ------------------------------------- | ------------------------------------------------------------------ | ---------: | ---------: | --------: |
| discovery      | `catalog.search` (limit 3)            | every downstream tool definition (name, description, input schema) |        420 |       4954 |     91.5% |
| schema         | `catalog.describe`, one tool          | every downstream tool definition                                   |       1677 |       4954 |     66.1% |
| planning       | `action.plan`, compact default        | `action.plan` with `detail: "full"` (the default before #27)       |        852 |       3114 |     72.6% |
| execution view | `action.run` with `maxTextBytes` 4096 | the unredacted downstream result                                   |      10168 |      51660 |     80.3% |

**Median reduction: 76.5% on this fixture.** The exit criterion's target is 25%.

### What these numbers do and do not show

- **Bytes, not tokens.** Hosts tokenize differently, so the harness reports bytes. Host token counts belong to the two-host runs below.
- **This fixture only.** The catalog and the downstream result are synthetic. The discovery and schema savings grow with catalog size; the planning saving is close to constant per call.
- **Execution is simulated.** No backend process is spawned. The downstream result is a fixed object, so the execution row measures the façade's own bounding, not a real tool's output.
- **Text and `structuredContent` are both counted.** ReproGate puts the same data in both, as MCP compatibility suggests. That is why the execution view is about twice its 4096-byte text limit. A host that shows the model only one of them sees roughly half the measured bytes.
- **One call per operation.** Multi-call workflows, completion rate and call counts are not measured here.
- **Code discovery versus grep, and research versus raw HTML,** are not measured. The roadmap's >90% and >95% targets for those need the two-host runs, and a research tool that doesn't exist yet.

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
