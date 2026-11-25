# Benchmarks

The Phase 3 measurements cover approval usability in Git. The Phase 4 sections cover façade response size and the manual protocol for measuring performance in two hosts.

## Phase 3 Git approval usability

Run the same fixtures used in CI:

```sh
npm run build --silent
node --test dist/tests/git-promotion-benign.test.js
```

Each case starts with a fresh Git repository, a clean source worktree, a separate destination branch at the source commit, a persisted action plan, an Ed25519 operator review, and a SQLite approval ledger, then applies one change after review. Every change is ordinary work that does not touch the approved patch. It is tried in two windows, before reservation and between reservation and promotion, with the same result in both unless the table says otherwise. The changes expected to promote are applied together in each window, which keeps the suite fast; each also promoted alone, in both windows, when this table was recorded. The suite checks the destination ref and whether the journal wrote a reservation or admission. For refused changes, it undoes the change and retries with the same approval.

| Change after review                                   | Observed result | Operator action                                             |
| ----------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| No change (control)                                   | Promoted        | Proceed                                                     |
| Unrelated branch moves                                | Promoted        | Proceed                                                     |
| Release tag added                                     | Promoted        | Proceed                                                     |
| Unrelated linked worktree added                       | Promoted        | Proceed                                                     |
| Ignored local runtime file added                      | Promoted        | Proceed                                                     |
| Local Git author name updated                         | Promoted        | Proceed                                                     |
| Fetch updates a remote-tracking branch                | Promoted        | Proceed                                                     |
| Default garbage collection                            | Promoted        | Proceed                                                     |
| Refs packed                                           | Promoted        | Proceed                                                     |
| Local draft stashed                                   | Promoted        | Proceed                                                     |
| Tracked file touched without a content change         | Promoted        | Proceed                                                     |
| Local Git hook added                                  | Promoted        | Proceed                                                     |
| Catalog tool description reworded                     | Promoted        | Proceed                                                     |
| Second operator trusted                               | Promoted        | Proceed                                                     |
| Tracked scratch edit                                  | Refused         | Restore a clean source worktree                             |
| Untracked scratch note                                | Refused         | Restore a clean source worktree                             |
| Destination checked out for inspection                | Refused         | Free the destination branch                                 |
| Source worktree switched to a new branch              | Refused         | Switch back                                                 |
| Agent commits more work on the source branch          | Refused         | Move the new commit to another branch                       |
| A teammate's commit lands on the destination          | Refused         | Get a new plan and approval on the new base                 |
| Both bound branches advance to the same tree          | Refused         | Get a new plan and approval to keep the new base            |
| Policy adds a rule for a different tool               | Refused         | Get a new plan and approval to keep the new policy          |
| Unreachable objects pruned (`gc --prune=now`), before | Refused         | Prepare the candidate again and use the same approval       |
| Unreachable objects pruned (`gc --prune=now`), after  | Refused         | Recover the attempt; the approval is lost, so get a new one |

- **Refused: 9 of 22 benign changes.** 13 of 22 kept the approval usable and promoted the exact reviewed candidate, in both windows. The two pruning rows are one change.
- **What each refusal costs.** 5 of the 9 clear when the operator tidies the repository, and the same approval then promotes. 3 of the 9 need a new plan and approval to keep the change. The contract binds the exact base and the whole policy digest, so it refuses even a commit with an identical tree or a rule for another tool. The fixtures also undo these three to show that the refusal did not spend the approval; undoing a teammate's commit is not advice.
- **One change can lose the approval.** Nothing refers to the candidate commit until promotion, so `git gc --prune=now` deletes it. Before reservation, the candidate can be prepared again. After reservation, a new candidate is a different commit and the approval is already bound to the old one: recovery ends the attempt, and the approval refuses any other. `git-review promote` reserves and promotes in one command, so this needs an attempt left `prepared` for `resume`. Default `git gc` keeps recent unreachable objects and is safe.
- **No refusal moved the destination.** Before reservation, refusals wrote no attempt. Afterwards, they left the attempt `prepared` with no admission or outcome.

The 22 synthetic changes were chosen to cover the contract, so 9 of 22 is not a rate that a team would see: that depends on how often each change happens. They do not cover denials after admission, moved repositories, or submodules. The fixtures use the host promotion APIs and exercise no MCP client. See [Promoting a reviewed Git change](GIT_PROMOTION.md) for operator guidance.

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
