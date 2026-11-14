# Flight recorder: handoff without summaries of summaries

Status: slices 1 and 2 are implemented (see [Slice 1 in detail](#slice-1-in-detail) and [Slice 2 in detail](#slice-2-in-detail)). Slices 3 to 5 are proposals.

## The problem

Handoff today depends on a model writing a good summary at the right moment. That fails in three ways:

1. **Decay.** Each session starts from a summary and ends with another, so detail is lost at every step.
2. **Timing.** A rate limit can stop the agent before it writes anything.
3. **Cost.** Asking agents to write the full workflow spends the quota the handoff was meant to protect.

## What was measured

All local, on this user's transcripts: 73 transcript files, 579 MB. Only aggregate counts were produced.

| Question                                                                      | Result                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Of the identifiers re-used after a compaction, how many did the summary keep? | Median **22%** (19 compactions in 9 sessions; range 6% to 35%)                                  |
| How much re-reading follows a compaction?                                     | A median 38% of reads re-open a file already read; a median 47 tool calls before the first edit |
| Does a usable record exist when a rate limit hits?                            | Yes: 67 `rate_limit` records sit inside transcripts alongside the surrounding work              |
| Same 19 compactions, a zero-token 8 KB list built from the event log          | Median **80%**; better than the summary in 19 of 19                                             |
| Adding recall when a file is touched                                          | Median 81%: **almost no gain**                                                                  |
| FTS5 over 31,453 events from 46 sessions (552 MB raw)                         | p50 0.02 ms, p95 3.4 ms, max 4.2 ms; built in 2.6 s; 44 MB on disk                              |
| Copies of one file across this repository's worktrees                         | `src/cli.ts`: 29 copies, 14 distinct versions                                                   |

### What this does not show

- **22% against 80% compares identifier coverage, not usefulness.** The metric favours a bare list of names, and it cannot see the reasoning a summary carries. It shows that summaries drop the concrete anchors agents go on to need. It does not show that agents would work better with a list. Only the A/B benchmark in slice 3 can show that.
- Identifiers are a proxy: an agent can re-find one by reading, so "lost" means "had to be found again", not "gone".
- The sample is one user's sessions, mostly on one project. Search ran over one user's data with events cut to 2,000 characters.
- Recall on file touch did not earn its place on this metric. It stays only as a small, later option for decisions and dead ends, which this metric cannot see.

Published work points the same way. In a [planted-facts study](https://arxiv.org/html/2610.20116v1), keeping user messages and assistant prose verbatim, with a lookup tool over the full session file, reached 93% to 99% recall across models, against 52% to 76% for the stock summary. Its author built the winning method, its commitment results were weaker (a frontier model did slightly better with the summary), and its probes removed file tools.

## Design

The idea in one line: **a handoff is a reproducible state rebuilt from evidence, not a story passed from agent to agent.**

### 1. Never summarize a summary

Every brief is generated from the append-only event log by deterministic code. No brief is an input to another brief, so every brief is one step from the evidence, and the fiftieth session reads the same quality of record as the second. A model's summary is optional extra data; nothing depends on it.

### 2. The model writes nothing that matters

Claude Code and Codex already write every step to a transcript on disk, and hooks receive `transcript_path`. ReproGate reads it from a remembered byte offset on lifecycle events, and at `SessionStart` for any session left unfinished, so a killed process needs no hook at all.

This costs no tokens and uses no quota, so a rate limit mid-edit loses nothing that reached the transcript. Half-finished code is on disk, and Git observation already reports it. A model's note adds intent ("why"), never record ("what").

### 3. Facts are anchored to code and checked when read

Each event that touches a file records `path` and Git blob hash. When a brief is built, each anchor is compared with the current tree and marked `current`, `changed` or `gone`. A dead end recorded against a file that has since been rewritten shows as such, instead of misleading the next agent.

This is ReproGate's existing idea applied to memory: approvals are bound to digests so they cannot go stale silently, and memory should work the same way.

### 4. Keep what cannot be re-derived

Code, diffs and test output can be re-read. Intent cannot. So the brief prioritizes, in order:

- what the user asked for, verbatim;
- decisions and constraints, which stay until superseded and never age out;
- failures: the last failing command, its exit code and the tail of its output;
- anchors: files changed, with their state.

### 5. Handoffs can be reproduced and read back

The brief ends with **resume probes**, commands the next agent can run to confirm the state, such as the test that last failed. Borrowed from I-PASS, whose final step is synthesis by the receiver, the next agent records in one note what it believes the state is. ReproGate can check that note against the record. This is cheap, and it catches a wrong understanding before work starts.

### 6. Many agents leave traces, not messages

Agents never coordinate through a document. Each one's work is captured by the recorder, so at the end nothing needs writing. This is stigmergy: coordination through traces in a shared environment. It replaces the `handoff_update` collision found in the load test, where 19 of 20 simultaneous updates failed. The shared revision is written only by the lead agent, if at all.

## `handoff_search`

It is a small retrieval engine, closer to a code search engine than to RAG: no embeddings, no model and no network.

- **Engine.** SQLite FTS5 with BM25, written in C and already inside Node. It met the speed target above with no new dependency. A Rust module would add prebuilt binaries for every platform for no measured gain. Revisit only if a benchmark shows a need.
- **Why no embeddings.** Agents search for identifiers, error codes and paths, where exact matching is strongest, and embeddings would add a model download and slower writes. They can be added later as an option if the benchmark shows missed matches.
- **Tokenizing.** `unicode61` keeping `_`, with camelCase split at index time. The trigram tokenizer was rejected: its index was 474% of the text size, against 59%.
- **Disambiguation.** The term is **entity resolution**. Each file is identified by `repository:path@blob`, not by name. Results are ranked by context: exact blob, then same worktree, same branch, then recency, in the spirit of Aider's personalized ranking and Zoekt's symbol boost. Copies with the same blob are collapsed into one result. When the top results are too close to separate, the response returns them with what differs (worktree, branch, last changed) rather than guessing.
- **Bounds.** A byte budget on every response, with omissions counted, like briefs.

## Storage

- One SQLite file. No new files appear in `.agent`, so nothing needs browsing.
- Measured: about 1 MB per session, 44 MB for 46 sessions, against 552 MB of raw transcripts. Paths are stored once and events reference them.
- A hard cap per repository, 64 MiB by default. Oldest tool output goes first, then old anchors. User requests and decisions go last.
- Transcripts stay the client's. A client may delete them, so anything worth keeping is copied in small, redacted form.

## Where each part comes from

| Part                              | Source                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append-only log, rebuild state    | Event sourcing, and [Apache Mako's](https://instagit.com/apache/maka/how-mako-achieves-crash-recovery.md) session recovery                                                             |
| Keep prose, look up the rest      | [transparent-compact](https://arxiv.org/html/2610.20116v1)                                                                                                                             |
| Automatic capture from hooks      | [claude-mem](https://docs.claude-mem.ai/introduction), though it compresses with a model and this does not                                                                             |
| Binding to Git objects            | [git-ai](https://rywalker.com/research/git-ai), ReproGate's own digest binding                                                                                                         |
| Receiver synthesis                | [I-PASS](https://www.eurekalert.org/news-releases/628556) from medicine: 23% fewer errors in pediatric residencies                                                                     |
| Traces instead of messages        | [Stigmergy](https://multiagent-explorer.vercel.app/patterns/stigmergy-environment-mediated) from ant colonies                                                                          |
| Ranking by working set and symbol | [Aider's repo map](https://www.agentpatterns.ai/context-engineering/repository-map-pattern/), Zoekt                                                                                    |
| Near-duplicate grouping           | [MinHash in codebase-memory-mcp](https://instagit.com/DeusData/codebase-memory-mcp/simhash-near-clone-detection-similar-to-edges-codebase-memory/), if blob grouping proves too coarse |

The combination appears to be new: no model involved in capture, multi-agent, and memory verified against the code when it is read. That rests on the projects searched here, not on an exhaustive survey.

## Risks

- **This changes a stated promise.** The docs say nothing is collected automatically. Capture must be an explicit opt-in (`"capture": "transcript"`), with its contents documented.
- **Stored prompt injection.** Tool output can hold hostile text, such as a fetched page. Raw tool output is never pushed into a brief. It is returned only on request, labelled as data. This needs a threat-model review.
- **Secrets.** Transcripts hold whatever the agent saw. Redaction is a backstop, not a guarantee.
- **Transcripts are not a stable API.** The format can change, and the docs say the file may lag the current turn. The parser must tolerate unknown records and fall back to hooks and Git. `PostToolUse` is the documented alternative, at the cost of a process per tool call.
- **Other clients.** Codex has rollout files in a different format. Clients with no transcript get hooks and Git only.

## Slices

Each stops at a decision, and later slices depend on the results.

1. **Fix collisions and add search over existing notes.** Change the MCP instructions so agents finish with `handoff_end`, and add `handoff_search` with disambiguation fields. Small, and useful alone.
2. **Recorder.** Opt-in transcript reading, the event table, retention and redaction. Claude Code first.
3. **A/B benchmark: the gate.** Real agents resume scripted tasks from a model summary and from the recorder brief, including mid-task kills, measuring task success, tokens to first correct edit and wrong assumptions. If the recorder does not win, slices 4 and 5 stop here. This replaces slice 6 of the multi-agent plan.
4. **Anchors and verification.** Blob anchors, `current`/`changed`/`gone`, and resume probes.
5. **Read-back and Codex.** Receiver synthesis, then the Codex rollout parser.

Slices 4 to 6 of `multi-agent-handoff.md` (claims, decisions, benchmark) should be re-planned after the gate. Decisions and dead ends move into slice 4 here.

## Slice 1 in detail

### Collisions: one writer for the shared summary

The MCP instructions told every agent to finish with `handoff_end` and `handoff_update`. Twenty agents finishing together raced for one revision, and 19 failed. Now:

- `handoff_end` returns `sharedUpdate`: `expected` only for the last top-level agent still running, otherwise `skip`. It is decided inside the write transaction that ends the session, so two agents ending together cannot both be told `expected`. "Running" means `active`: an idle session waiting for its user does not hold the update back. Subagents always get `skip`.
- The instructions say: finish with `handoff_end` and a summary; call `handoff_update` only when `handoff_end` returned `expected`, merging the `result` notes the brief shows; on `revision_conflict`, re-read once and retry once, then stop, since the summary is already recorded.
- Nothing is enforced. `handoff_update` still accepts any caller, as before.

### `handoff_search`

Read-only for callers; registered whenever handoff is configured, like `handoff_status`.

- **Corpus.** Notes, session tasks, and the items of the latest 32 handoff revisions (goal, completed, touched files, blockers, next steps). An item repeated across revisions is indexed once, under the newest revision that holds it.
- **Index.** An FTS5 table in the handoff database. Its tokenizer is `unicode61` with `_` kept in words. A second column holds identifier parts: `parseHandoffConfig` also indexes `parse handoff config`, and `handoff_search` also indexes `handoff search`. The index is a cache. Before each search it is brought up to date with the source tables, so notes written by an older version or removed by pruning are never missed or returned stale; a fingerprint of the sources skips that step when nothing changed. Each hit is joined back to its source row, and a hit whose row is gone or was replaced is dropped.
- **Query.** Free text, never FTS5 syntax: each word becomes a quoted phrase, so `src/cli.ts` and `EPERM` need no escaping, and the parts of a camelCase or snake_case word are also tried. Words are joined with OR and ranked by BM25, so documents matching more words rank first.
- **Ranking in context.** The BM25 score is raised for the caller's own worktree and session (from `sessionId`), and lowered with age. Hits with identical text are collapsed into the best one.
- **Disambiguation.** Path-like words in each hit are returned as `paths`. When a query word names a file (`cli.ts`) and the hits mention more than one path or worktree for it (`src/cli.ts`, `src/handoff-cli.ts`), the response sets `ambiguous` and lists the candidates with their counts, so the agent can ask again with `path`, rather than act on the wrong file. File versions (Git blobs) arrive with anchors in slice 4.
- **Bounds.** `limit` (default 8, at most 20) and `resultBytes` (default 4 KiB, 1 to 16 KiB). Each hit is cut to a window around the match. Omitted hits are counted.
- **Filters.** `kinds` (note kinds, `task`, `revision`), `worktree`, `path`.
- **Provenance.** Every hit is `caller_asserted` text, returned as data.
- `reprogate handoff search --config <path> [--json] <query...>` runs the same search from a shell.

## Slice 2 in detail

The recorder reads Claude Code transcripts from client hooks and keeps a few kinds of structured events. It is off unless the host sets `"sessions": { "captureTranscripts": true }`.

- **When.** On `Stop`, `StopFailure`, `PreCompact` and `SessionEnd` for the main session, and on `SubagentStop` for a subagent's own transcript (`agent_transcript_path`). `SessionStart` also catches up on every transcript left unread, so a session killed before its hooks ran is recorded when the next one starts. Each read starts at the byte offset where the last one stopped and takes only complete lines, at most 8 MiB per transcript per hook. A line longer than that is skipped. No model call is involved, so a rate limit loses nothing that reached the transcript.
- **What is kept.** Only these, each redacted with the same redactor as notes:
  - `request`: what the user typed, verbatim, up to 4 KiB. Client wrappers such as task notifications and local command output are skipped.
  - `reply`: the start of each assistant text block, up to 512 bytes.
  - `command`: each shell command, up to 1 KiB, its outcome (`ok`, `failed` or `interrupted`) and exit code, and for a failure the last 1 KiB of its output.
  - `edit`: each file changed through an edit tool, as a path inside the session's worktree, its outcome, and the Git blob ID of the file's bytes when the transcript was read (no Git filters applied). Paths outside the worktree are not kept.
  - `api_error`: an error the client recorded, such as a rate limit, up to 512 bytes.
- **What is never kept.** Other tool output (file reads, searches, fetched pages), thinking, images and the assistant's tool inputs beyond the command or path. This keeps fetched text out of briefs and limits stored prompt injection.
- **Trust.** The transcript path comes from the hook payload. It must be an absolute `.jsonl` path to a regular file, not a symlink, owned by the current user. A record that is not valid JSON or of an unknown shape is ignored. Records are deduplicated by their ID, so a transcript read twice records nothing twice.
- **Retention.** A byte cap per workspace, 64 MiB by default (`captureBytes`). When it is passed, failure tails go first, then replies, then commands, edits and errors, and user requests last, oldest first in each.
- **Where it shows.** The brief gains `recorded`, built from these events: the newest user requests, the newest failed commands with exit codes and tails, and the files changed most recently with their blob IDs. It is fitted to the brief's budget like everything else, and requests are the last thing dropped. `handoff_search` also searches recorded requests, replies, commands and edits.
- **Not yet.** Codex rollout files (slice 5), checking blob IDs against the current files (slice 4), and capture for clients without hooks.
