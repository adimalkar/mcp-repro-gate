# Benchmarks

The Phase 3 measurements cover approval usability in Git. The Phase 4 sections cover façade response size and the manual protocol for measuring performance in two hosts.

## Phase 3 Git approval usability

Run the same fixtures used in CI:

```sh
npm run build --silent
node --test dist/tests/git-promotion-benign.test.js
```

Each case starts with a fresh Git repository, a clean source worktree, a separate destination branch at the source commit, a persisted action plan, an Ed25519 operator review, and a SQLite approval ledger, then applies one change after review. Every change is ordinary work that does not touch the approved patch. It is tried in two windows, before reservation and between reservation and promotion, with the same result in both unless the table says otherwise. The changes expected to promote are applied together in each window, which keeps the suite fast; each also promoted alone, in both windows, when this table was recorded. The suite checks the destination ref and whether the journal wrote a reservation or admission. For refused changes, it undoes the change and retries with the same approval.

| Change after review                           | Observed result | Operator action                                    |
| --------------------------------------------- | --------------- | -------------------------------------------------- |
| No change (control)                           | Promoted        | Proceed                                            |
| Unrelated branch moves                        | Promoted        | Proceed                                            |
| Release tag added                             | Promoted        | Proceed                                            |
| Unrelated linked worktree added               | Promoted        | Proceed                                            |
| Ignored local runtime file added              | Promoted        | Proceed                                            |
| Local Git author name updated                 | Promoted        | Proceed                                            |
| Fetch updates a remote-tracking branch        | Promoted        | Proceed                                            |
| Default garbage collection                    | Promoted        | Proceed                                            |
| Refs packed                                   | Promoted        | Proceed                                            |
| Local draft stashed                           | Promoted        | Proceed                                            |
| Tracked file touched without a content change | Promoted        | Proceed                                            |
| Local Git hook added                          | Promoted        | Proceed                                            |
| Catalog tool description reworded             | Promoted        | Proceed                                            |
| Second operator trusted                       | Promoted        | Proceed                                            |
| Tracked scratch edit                          | Refused         | Restore a clean source worktree                    |
| Untracked scratch note                        | Refused         | Restore a clean source worktree                    |
| Destination checked out for inspection        | Refused         | Free the destination branch                        |
| Source worktree switched to a new branch      | Refused         | Switch back                                        |
| Agent commits more work on the source branch  | Refused         | Move the new commit to another branch              |
| A teammate's commit lands on the destination  | Refused         | Get a new plan and approval on the new base        |
| Both bound branches advance to the same tree  | Refused         | Get a new plan and approval to keep the new base   |
| Policy adds a rule for a different tool       | Refused         | Get a new plan and approval to keep the new policy |
| Unreachable objects pruned (`gc --prune=now`) | Promoted        | Proceed                                            |

- **Refused: 8 of 22 benign changes.** 14 of 22 kept the approval usable and promoted the exact reviewed candidate, in both windows. The first measurement refused 9: see pruning below.
- **What each refusal costs.** 5 of the 8 clear when the operator tidies the repository, and the same approval then promotes. 3 of the 8 need a new plan and approval to keep the change. The contract binds the exact base and the whole policy digest, so it refuses even a commit with an identical tree or a rule for another tool. The fixtures also undo these three to show that the refusal did not spend the approval; undoing a teammate's commit is not advice.
- **Pruning lost the approval until it was fixed.** Nothing refers to the candidate commit until promotion, so in the first measurement `git gc --prune=now` deleted it. Before reservation it could be prepared again; after reservation the approval was bound to the deleted commit and was spent. The candidate's pack now carries a Git keep file until the attempt is resolved. The fixture runs `gc --prune=now`, `repack -a -d` and `prune` in both windows, with a control commit that they must delete.
- **No refusal moved the destination.** Before reservation, refusals wrote no attempt. Afterwards, they left the attempt `prepared` with no admission or outcome.

The 22 synthetic changes were chosen to cover the contract, so 8 of 22 is not a rate that a team would see: that depends on how often each change happens. They do not cover denials after admission, moved repositories, or submodules. The fixtures use the host promotion APIs and exercise no MCP client. See [Promoting a reviewed Git change](GIT_PROMOTION.md) for operator guidance.

## Façade measurement

```sh
npm run build
node dist/src/cli.js bench facade          # table
node dist/src/cli.js bench facade --json   # machine-readable report
```

The harness runs fixed operations through a real in-memory MCP client against a ReproGate server, using a published synthetic catalog of 14 code-graph-shaped tools (`src/benchmark.ts`, fixture v3). It counts UTF-8 bytes of what a host receives. For tool calls, that is the text content, `structuredContent` and `isError`, on both the measured and the baseline side. Every call must succeed; a failed call stops the run instead of being measured.

### Context cost

A host first loads tool definitions, then spends calls finding a tool:

| Item                               | Bytes |
| ---------------------------------- | ----: |
| façade tool list                   |  9990 |
| direct tool list                   |  4964 |
| finding a tool (search + describe) |  2122 |
| average downstream tool definition |   355 |
| break-even catalog size (tools)    |    35 |

- **Façade tool list:** ReproGate's own `tools/list`, including output schemas.
- **Direct tool list:** every downstream definition, as a host would see by proxying the tools directly.
- **Finding a tool:** one `catalog.search` with three hits plus one `catalog.describe`.

The façade's own tool list is about twice the 14 downstream definitions it replaces. So on this fixture, discovery through the façade costs more context than loading the tools directly. It breaks even at about 35 downstream tools when an agent looks up one tool per session. Each further tool looked up adds another `catalog.describe` and raises the break-even. The façade's cost per lookup stays flat as the catalog grows, while a direct list keeps growing.

### Tool results

| Tool result             | Measured                               | Baseline                            | Measured B | Baseline B | Reduction | Truncated |
| ----------------------- | -------------------------------------- | ----------------------------------- | ---------: | ---------: | --------: | --------- |
| planning                | `action.plan`, compact default         | `action.plan` with `detail: "full"` |        800 |       2752 |     70.9% | no        |
| execution, large result | `action.run`, default 16384-byte limit | the unredacted downstream result    |      35420 |      51660 |     31.4% | yes       |
| execution, small result | `action.run`, default limit            | the unredacted downstream result    |        568 |        100 |   -468.0% | no        |

**Median tool-result reduction on this fixture: 31.4%.** With three rows, the median is the middle row: the truncated large result. This is a fixture check, not an exit-criterion result. The roadmap criterion concerns host tokens across real tasks, which only the two-host runs below can measure.

### What these numbers do and do not show

- **Bytes, not tokens.** Hosts tokenize differently. Host token counts belong to the two-host runs.
- **Truncation is not a free saving.** The large-result row is smaller only because `action.run` cuts the downstream text at the limit: the agent sees about 16 KiB of a much larger result and loses the rest. The `truncated` column marks it.
- **Small results still get larger.** `action.run` adds a compact summary (execution ID, outcome, flags), and carries the bounded text both as plain text content and in `structuredContent`. For a small result, that overhead still outweighs the downstream text.
- **Planning** saves a roughly constant amount per call. The full baseline is today's `detail: "full"` output. It carries the envelope and policy the pre-#27 default returned, plus `detail` and `nextStep`.
- **Text and `structuredContent` are both counted.** Hosts differ: some show the model only text content, others only `structuredContent`, so every façade tool puts its data in both. Most mirror `structuredContent` as compact JSON text. `action.run` sends the summary's JSON, then the bounded downstream text unescaped. A host that shows the model only one of the two sees about half of what is measured.
- **This fixture only.** The catalog and results are synthetic, and execution is simulated: no backend process is spawned.
- **Not measured here:** multi-call workflows, call counts, completion rate, and the roadmap's code-discovery-versus-grep and research-versus-HTML comparisons.

### History

- **v2 to v3:** compact `action.run` summaries (digests opt-in), downstream text sent unescaped instead of inside a JSON-escaped mirror, and compact JSON text mirrors.
  - Small result: from 1032 to 568 bytes.
  - Large result: from 38064 to 35420 bytes (reduction from 26.3% to 31.4%).
  - Finding a tool: from 2498 to 2122 bytes.
  - Planning: from 852 to 800 bytes. Its reduction fell from 72.6% to 70.9%, because the full baseline also shrank with compact JSON.
  - Façade tool list: grew from 9856 to 9990 bytes. The `detail` input, the optional digest fields and the bounded text in the `action.run` output schema account for the increase. Tool list plus finding a tool fell from 12354 to 12112 bytes per session, and break-even stayed at 35 tools.

## Two-host code discovery pilot

The runner launches Codex CLI and Claude Code against the same two graph tools, through ReproGate and through a direct MCP connection. It uses the public source revision pinned by the [discovery benchmark](CODE_DISCOVERY_BENCHMARK.md). The current fixtures find the definitions of `canonicalJson`, `evaluatePolicy`, and `verifyExecutionReceipt`. Each run starts in a fresh session with an empty workspace, and the graph server uses a private index and settings.

```sh
mkdir -p .agent/benchmark-runs
npm run bench:two-host -- \
  /absolute/path/to/codebase-memory-mcp \
  .agent/benchmark-runs/two-host.json gpt-6.2-sol sonnet
```

The command requires authenticated local host CLIs and makes 12 live model calls, one per task, host, and connection. Append `1` for a four-call smoke run. Pick a fresh output filename. After graph setup, the runner writes the planned rows to the report, checkpoints each one as `started` before invoking a host and records its final `passed` or `failed` state. If interrupted, subsequent rows remain `unattempted`. Host exits, malformed streams and timeouts are recorded as failed trials with a bounded diagnostic code. The matrix continues through the other trials. An incomplete turn makes the final command exit nonzero. A changed corpus stops the matrix immediately. The report contains host versions, model selectors, the graph binary digest, the pinned source identity, and per-call measurements. Tool arguments, transcripts, and credentials are omitted.

- **Task pass** in benchmark version 2 requires a completed turn, the exact repository-relative path, the complete exported function declaration from the pinned TypeScript source, successful calls to both graph tools, and no shell use. The `exact-function-v2` rubric normalizes CRLF and surrounding whitespace. An omitted line, changed statement or appended definition fails. Compact and full-detail plans both link their action ID to the graph tool used by each execution.
- **MCP bytes** count the JSON result payload of each completed call. The report also counts tool listing bytes separately. A host can request the list more than once. The wire measurement includes both text and structured fields when present.
- **Host usage** shows the whole-turn input, output and cache counts that each CLI reports. The pilot reports `null` for tool-result tokens because it has no per-result tokenizer or accounting from either host. Use successful pairs for byte comparisons and retain failed runs in completion counts.
- The baseline exposes only the same two read-only graph tools. Its relay adds the missing `readOnlyHint` to those two tools for both hosts. Codex otherwise asks for approval before direct calls in a noninteractive trial. The relay enforces the two-tool allowlist, and the hint contributes to the measured tool-list bytes. Write approval, injected failures and session transfer are covered by the broader protocol below.

### Pilot result

All 12 runs passed on November 24, 2026 under the version 1 rubric, which checked the path, function name and one implementation fragment. The runner discarded raw answers, so these historical trials cannot be rescored with version 2. Use the runner at the recorded ReproGate revision to reproduce version 1. See [the run report](benchmarks/two-host-v1.json) for the pinned commit, binary digest, version information, and measurements for each call.

| Host        | Direct pass | Façade pass | Direct calls per task | Façade calls per task | Median direct result bytes | Median façade result bytes | Median paired size ratio |
| ----------- | ----------: | ----------: | --------------------: | --------------------: | -------------------------: | -------------------------: | -----------------------: |
| Codex CLI   |         3/3 |         3/3 |                     2 |                     8 |                      8,241 |                     22,282 |                    2.70× |
| Claude Code |         3/3 |         3/3 |                     2 |                   7–8 |                      8,241 |                     23,202 |                    2.82× |

The paired ratio divides façade bytes by direct bytes for each task in the same host, then takes the median. It excludes tool listings. Across list requests in one run, direct mode returned 3,570 bytes in both hosts. The façade returned 9,990 bytes in Codex CLI and 10,138 in Claude Code.

Whole-turn cost from the same runs, as medians over the three tasks (ratios are the median of each task's paired ratio):

| Host        | Time, direct | Time, façade | Ratio | Input tokens, direct | Input tokens, façade | Ratio | Output tokens, direct | Output tokens, façade | Ratio |
| ----------- | -----------: | -----------: | ----: | -------------------: | -------------------: | ----: | --------------------: | --------------------: | ----: |
| Codex CLI   |       18.7 s |       27.8 s | 1.50× |               84,827 |              133,024 | 1.57× |                   450 |                   646 | 1.42× |
| Claude Code |        6.9 s |       15.7 s | 2.45× |               17,144 |               53,559 | 3.14× |                   681 |                 1,316 | 1.93× |

Input tokens count cached input and are summed over every model request in the turn, so they include each host's own prompt again for every extra call. Most are cache reads. Compare them within a host, not between hosts.

**In this pilot the façade cost more on every measure.** With two downstream tools, catalog discovery, describe and plan calls were 54–60% of the façade's result bytes. The graph results themselves were 1.10–1.14× direct. The Phase 4 target is a 25% reduction in tool-result tokens, which this harness can't count; the bytes it can count moved the other way. The façade ran without the opt-in compact graph views (`mediation.result.graphViews`). A larger catalog, reuse within a session, or those views could change the comparison, and none of them is measured here. The façade surface also includes ReproGate's policy and receipt flow, which the direct surface does not provide.

Limits of this pilot: one run per task, host and surface, so there is no variance estimate. All three tasks are the same kind of lookup, and the prompt names the calls to make. The `sonnet` alias was recorded, not the model it resolved to. Two earlier diagnostic reports (nine runs) are excluded: in both, the direct Codex run was refused approval because the graph tools lacked `readOnlyHint`, which the relay then added. Their other seven runs all passed.

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
