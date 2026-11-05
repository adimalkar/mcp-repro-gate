# Resilient multi-agent handoff

Status: proposed plan; slices 1 and 2 implemented (see Implementation notes). It extends the opt-in handoff tools ([HANDOFF.md](../HANDOFF.md), [first slice](agent-handoff.md)) so that context survives the two situations where it fails today:

- many agents working at once on one task, such as a parent with 20 subagents;
- an agent that stops abruptly because of a rate limit, crash, closed laptop or context compaction, before it writes the handoff.

The handoff stays advisory. Nothing in this plan issues capabilities, approves actions, changes plans or receipts, or claims a Git effect happened.

## Why the current design fails

| Situation                                                   | What happens today                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20 subagents update the handoff                             | One document and one revision counter: every update is a compare-and-swap on the whole document. Concurrent writers get `revision_conflict` and retry; with 20 writers most attempts fail.        |
| Long task with many steps                                   | Lists are capped at 16 entries and the document at 96 KiB. One document cannot describe 20 streams, and subagent detail floods the parent's summary.                                              |
| Agent hits its rate limit                                   | The handoff is written at the end of work. An agent that runs out of quota never writes it, and the next agent sees a stale document that looks complete. Nothing records that a session stopped. |
| Context is compacted                                        | The agent forgets what it already recorded. It either repeats work or rewrites the handoff from a partial memory.                                                                                 |
| `handoff.md` edited by hand, or pulled from another machine | The document no longer matches the stored projection, so the state is `drifted` and updates fail closed. The tools offer no way to accept the new document.                                       |
| Work spread over several worktrees                          | Each worktree is its own workspace root, so an agent in one worktree cannot see the handoff of the task it belongs to.                                                                            |
| Two agents both call themselves `claude-code`               | `activeAgent` is a free-text label, so their entries are indistinguishable.                                                                                                                       |
| An agent pastes a token into a note                         | The note is projected into `handoff.md`, which may be committed and synced.                                                                                                                       |

## Design principles

1. **Never depend on an agent's last words.** Whatever a session leaves behind must be enough to resume from, even if it stopped mid-step.
2. **Writers append, the server summarizes.** Agents add small notes to their own lane; they never edit the shared document. Appends do not conflict.
3. **Observed and asserted stay separate.** Facts ReproGate reads itself (Git state, session liveness, plan and execution records) are labelled `observed`. What agents say is `asserted`. A resuming agent sees both, side by side. This applies ReproGate's core idea to handoff and is what other handoff and memory tools don't offer.
4. **Host-side signals that need no model quota.** Client hooks and process lifecycle events record interruptions without a model call.
5. **Bounded and cheap.** Every read, note and projection is bounded in bytes, entries and time; the resume brief has a token budget.

## Slices

Each slice is one PR with its own tests, docs, independent review and CHANGELOG entry. Nothing is merged without the user's approval.

### Slice 1: sessions, leases and observed recovery (the rate-limit fix)

**Sessions.** A new `handoff_sessions` table records each agent session:

- a server-issued `sessionId` (UUID v4); the agent name is a label, not an identity;
- `kind` (`agent` or `subagent`), optional `parentSessionId`, optional one-line `task`;
- `startedAt`, `lastSeenAt`, the Git HEAD at start, and an end state: `active`, `ended`, `interrupted` or `abandoned`, with an end reason.

**Tools:**

- `handoff_join` registers a session and returns its `sessionId`, the lease length and a bounded **resume brief** (below).
- `handoff_note` appends one short note (`progress`, `blocker`, `decision`, `next`) to the session's lane. It never conflicts and renews the lease.
- `handoff_end` closes a session normally, optionally with a final summary.
- `handoff_update` and `handoff_status` keep working unchanged for existing clients.

**Liveness without cooperation:**

- Any handoff call carrying a `sessionId` renews its lease.
- A stdio MCP server process serves one client. When its input closes, the server ends every session that connection opened and has not ended, with reason `disconnected`. No model call is needed.
- A session whose lease lapses is shown as `quiet`, then `interrupted` after a grace period. A later call from it makes it `active` again. This avoids marking a long model turn as dead.

**Observed recovery snapshot.** When a session joins, or the host records a checkpoint, ReproGate reads, through the existing hardened Git runner:

- branch, HEAD, detached state, and upstream ahead/behind counts;
- an operation in progress: merge, rebase, cherry-pick, revert or bisect;
- commit count and up to 10 escaped subjects since the previous session's starting HEAD;
- changed, staged, untracked and conflicted file counts and paths (bounded), with no file contents and no diffs;
- linked worktrees with their branches.

It never stages, stashes, resets or edits anything. Each read has a timeout and an entry cap; when a cap or timeout is hit the snapshot says `truncated` or `unavailable` rather than presenting a partial list as complete.

**Host checkpoint CLI:** `reprogate handoff checkpoint --config <handoff.json> --event <event>`.

- Reads the client's hook payload as JSON on stdin (bounded), records the event and an observed snapshot, marks the session, and re-projects the document.
- Events: `stop_failure` (an API error such as a rate limit), `session_end`, `subagent_stop` (its last message becomes the child's asserted result), `pre_compact`, and `manual`.
- Documented hook recipes for Claude Code (`StopFailure`, `SessionEnd`, `SubagentStop`, `PreCompact`) and Codex (its turn-completion notify hook), using only the hook's documented fields. Recipes are opt-in host configuration; nothing is installed automatically.

**Resume brief.** `handoff_join` and `handoff_status { brief: true }` return one bounded object:

- the goal and next steps from the latest revision;
- sessions that ended without a handoff, with their last note and how long ago they stopped;
- open blockers and decisions;
- the observed snapshot and what changed since the last revision;
- a `budgetBytes` input caps the brief; omitted entries are counted, never silently dropped.

**Projection.** Slice 2 adds a generated `.agent/sessions.md` next to `handoff.md`, so agents that only read files see interruptions too. Slice 1 delivers the same facts through the brief, the `SessionStart` hook context and `reprogate handoff brief`.

### Slice 2: lanes, rollups and a sessions file

Redaction, note caps and session caps landed in slice 1. Slice 2 adds:

- **Rollups in the brief.** A subagent that needs attention (failed, interrupted, quiet) is listed one by one, so problems surface. Any other subagent, at any depth, is folded into the `subagents` counts of its nearest listed ancestor. A subagent whose parent is gone is listed as before. With 20 subagents the brief shows one parent line instead of 21 sessions.
- **Lane view.** `handoff_status { sessionId }` returns one session in full: its newest notes (up to 64), and its subagents ordered for attention, within `briefBytes`. Omitted notes and subagents are counted. An unknown session is `unknown_session`.
- **`.agent/sessions.md`.** A generated file beside `handoff.md`, for agents that read files rather than call tools. It holds the brief without Git state (reading Git on every event would cost too much), with every line indented as a code block, so note text can never render as headings or links. It is rewritten, never merged, and says so.
  - **Coalescing.** Lifecycle events (start, end, failure, subagent start and stop, join) rewrite it at once. Notes and turn events rewrite it at most once per `projectionIntervalSeconds` (default 5); a skipped write marks it dirty, and the next event rewrites it, or a long-running server after the interval. Status reads never write. With 20 agents writing notes, the file is written about once every 5 seconds.
  - **Safety.** Written like `handoff.md`: a private temporary file, then an atomic rename. A symlinked, hard-linked or non-private `sessions.md` is refused, not followed. A failed write never loses the event: the database is the record, and `handoff_status` reports the file as `pending` or `unavailable`.
  - **Opt-out.** `sessions.projectFile: false` turns it off; read-only configurations never write it.

Edge cases:

| Edge case                                  | Handling                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 20 subagents noting at once                | One parent rollup line; file writes coalesced                                                                     |
| Two processes writing the file together    | Each writes its own temporary file and renames atomically; the last rename wins and the next event regenerates it |
| A person edits `sessions.md`               | It is overwritten on the next write; the header says it is generated                                              |
| `sessions.md` is a symlink or hard link    | Refused, never followed; status reports `unavailable`                                                             |
| States go stale in the file between events | The file shows when it was generated; the brief and status are live                                               |
| A parent with 100 subagents                | Counts by state, plus only the subagents that need attention                                                      |
| A subagent whose parent was pruned         | Listed on its own                                                                                                 |
| A lane with hundreds of notes              | Newest 64 kept by the ledger, then cut to the byte budget, with counts                                            |
| Disk full or `.agent` permissions wrong    | The event is still recorded; the file stays dirty and status says so                                              |

### Slice 3: drift adoption and repository scope

- `handoff_adopt { expectedDocumentDigest }` accepts a hand-edited or synced `handoff.md` as a new revision with provenance `adopted_document`. It writes no file, so nothing needs archiving yet: the next update archives the adopted document. This makes manual edits and laptop-to-workstation syncs safe instead of a dead end.
- A one-time import of an existing file-based `.agent/handoff.md` as revision 1, so users of the plain protocol keep their history. It is the same operation with `expectedRevision: 0`.
- `reprogate handoff adopt` does the same for a person, without a model call: it shows what would be recorded, and records it given the digest.
- `--repair-permissions` makes an existing `.agent/` private, once, at a person's request. The plain protocol leaves `.agent/` readable, which the service refuses at startup, so import could not work without it.
- An opt-in `scope: "repository"` configuration keys the handoff by the Git common directory instead of the worktree root, so every worktree of one repository shares one task context and lanes record which worktree each session ran in. The default stays per workspace root.

Design decisions:

| Question                                               | Decision                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adopt automatically on drift?                          | No. A silent adoption would remove the compare-and-swap that detects a changed document. Briefs tell the agent instead, and the agent or a person accepts one specific digest.                                                                           |
| Store the adopted document?                            | No, only its digest and a short extract. The file stays the record, and a credential in a hand-written file is not copied into the database wholesale.                                                                                                   |
| Parse the document, or ask the agent to summarize it?  | Parse the shared headings. A person can then import without a model call, which is the case the rate-limit work exists for. The parser is best effort; a document with no known heading still adopts.                                                    |
| Adopt while a projection is pending?                   | Refused with `not_drifted` when the document is that projection's base, so the revision is not discarded. A document that moved on is a real drift and can be adopted.                                                                                   |
| Repair permissions in the service?                     | No. Agents never change permissions. A person asks for it, and it uses no-follow descriptors and refuses links and other owners.                                                                                                                         |
| Keep refusing a `0644` document in a private `.agent`? | No, this relaxes an earlier rule. Syncs and editors that replace the file reset its mode, which made status `unavailable`, a dead end for the agent. The private directory already stops others reading it. Write bits for group or others stay refused. |
| Where do repository-scope files go?                    | One copy, in `workspaceRoot`. Per-worktree copies would each read as drifted after an update from another worktree.                                                                                                                                      |
| What does a brief show of other worktrees' Git state?  | Nothing but their sessions. A brief reads the worktree it was asked from, and commits-since only compares sessions of that worktree.                                                                                                                     |

### Slice 4: task board with claims

- `handoff_task_add`, `handoff_task_claim`, `handoff_task_release`, `handoff_task_done`.
- A claim has an expiry and an optional list of path prefixes. A claim held by an interrupted session expires and is offered back; the old holder gets `claim_lost` on its next call, never a silent overwrite.
- **Checked against Git:** at checkpoints and on `handoff_task_done`, ReproGate compares the observed changed paths with the session's claimed prefixes and reports overlaps between sessions and edits outside the claim. Claims are advisory: this is a warning, not enforcement. Enforcement belongs to the Git promotion gate.
- `handoff_task_done` can reference plan action IDs and Git promotion attempts, so "done" can point to recorded evidence.

### Slice 5: decisions and dead ends

- **Decision log:** "we chose X because Y". Decisions persist across revisions and appear in every brief until superseded, so a new agent does not reopen a settled choice.
- **Dead ends:** "tried X, failed because Y". Duplicates are merged by a normalized key. They are linked to `action.run` failure strikes when the same tool keeps failing.
- `handoff_status { since: <revision> }` returns only what changed, so an agent coming back after compaction reads a delta instead of the whole document.

### Slice 6: kill-and-resume benchmark

The claim "best context switching" needs a measurement, so `bench handoff` runs a scripted task with simulated agents. It kills them at random points: mid-note, mid-projection, mid-rebase, with uncommitted edits. For each kill it measures:

- how much of the ground-truth state the next agent recovers (interrupted sessions, uncommitted paths, operations in progress, open claims);
- the bytes the next agent reads to resume, compared with reading the whole document and history;
- false `interrupted` reports for sessions that were only quiet.

Results are published in `docs/BENCHMARKS.md` with their limits. No claim is made against other tools without a comparable run.

## Edge cases and how each slice handles them

| Edge case                                     | Handling                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limit mid-step, no handoff written       | Lease lapses, session marked `interrupted`; `StopFailure` hook records the reason without a model call; next agent's brief shows it with the observed Git state. |
| Agent alive but thinking for minutes          | `quiet` before `interrupted`; any later call makes it `active` again; claims are offered back only after the grace period.                                       |
| User closes the terminal                      | stdin closes; the server ends the connection's open sessions as `disconnected`.                                                                                  |
| Killed mid-rebase or mid-merge                | Snapshot reports the operation in progress and conflicted paths; the text brief opens with it.                                                                   |
| Uncommitted edits at death                    | Changed paths and counts are listed as observed; nothing is stashed or reset. Files changed after the last note are flagged "unconfirmed since last note".       |
| Half-written file left by a dying agent       | ReproGate cannot know the file is broken; it only flags it as changed after the last note. The doc says so.                                                      |
| 20 subagents writing at once                  | Notes append to separate lanes, no compare-and-swap; projection is coalesced.                                                                                    |
| Every subagent's stop fires a hook            | Each checkpoint is one small insert; projection is coalesced.                                                                                                    |
| Two agents with the same name                 | Server-issued session IDs; names are labels.                                                                                                                     |
| Context compaction                            | `PreCompact` hook checkpoints; after compaction the agent asks for `since` its last revision.                                                                    |
| Manual edit or synced document                | `handoff_adopt` turns it into a revision instead of failing closed forever.                                                                                      |
| Worktrees of one task                         | Opt-in repository scope.                                                                                                                                         |
| Secrets pasted into notes                     | Redacted before storage; count recorded.                                                                                                                         |
| Huge repository                               | Git reads have timeouts and caps; the snapshot reports `truncated`.                                                                                              |
| Not a Git repository                          | Observed Git section is `unavailable`; sessions and notes still work.                                                                                            |
| Hook runs while the server holds the database | SQLite WAL with a bounded busy timeout; hook failures exit 1 (never 2, which Claude Code treats as blocking) with a short code on standard error.                |
| Hook payload format changes                   | The CLI reads only documented fields, bounded, and ignores the rest; an unreadable payload still records a `manual` checkpoint.                                  |
| Clock jumps                                   | Lease checks use the server's clock on one host; a backwards step only delays `interrupted`, it never ends a live session early.                                 |
| Database lost or replaced                     | Existing binding checks report `unavailable`; the projection on disk is left alone and can be adopted.                                                           |

## Edge-case audit of the other features

Before fixing anything in other features, each item below is checked against the code and an existing test. Only confirmed gaps get a fix, each in its own PR with a test that fails first. Items found already handled are recorded as such.

| Feature                   | Edge case to check                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `action.run` strike gate  | Do failure strikes survive a server restart, or does restarting reset the count?                                                    |
| `action.run` output       | Truncation in the middle of a multi-byte character or a JSON structure.                                                             |
| Approvals                 | A held approval that expires while the operator is away: is the error actionable ("re-plan"), and is nothing consumed?              |
| Live schema check         | The downstream server restarts with a changed schema between plan and run: does the agent get a clear "describe again" code?        |
| Research                  | JavaScript-only pages that return almost no text; `429` with `Retry-After`; non-UTF-8 charsets; PDFs; redirects that change origin. |
| Code-graph proxy          | The graph index is older than HEAD: results can name deleted symbols. Can the proxy report index freshness?                         |
| Git staging and promotion | `core.autocrlf` and `.gitattributes` filters, submodules, LFS pointers, case-insensitive filesystems, very large binary patches.    |
| Handoff projection        | `.agent/` on a network or FUSE filesystem where rename is not atomic.                                                               |

## Complementary features found during this review

Ranked by value for the context-switching workflow:

1. **Resume brief with a budget** (slice 1): one bounded call replaces reading the whole document and history.
2. **Observed session state** (slice 1): the main differentiator.
3. **Decisions and dead ends** (slice 5): prevents repeating failed approaches, a common token sink after a switch.
4. **Task board checked against Git** (slice 4).
5. **Delta reads** (slice 5).
6. **Evidence-linked completion** (slice 4): "done" points to plan, receipt or promotion records.
7. **Signed handoff export** (later): reuse the promotion-evidence signing to move a handoff between machines with tamper evidence.
8. **MCP server instructions** (slice 1): the server's `instructions` field tells clients when to join, note and end, so agents follow the protocol without per-project prompts.

## Compatibility

- Configuration: new fields are optional. Version 1 configurations behave as before; slice 1 adds an optional `sessions` block (lease and grace lengths, Git observation on or off).
- Existing tools and records: unchanged. New records use new tables and a version 2 record schema; version 1 records stay readable.
- Projection: `.agent/handoff.md` is unchanged. Its rendering is bound into every stored revision's projected digest, so changing it would make existing revisions unreadable.

## Implementation notes (slice 1)

- **Client hooks are the session registrar.** Claude Code's hook payloads carry the client's session and subagent IDs, and `SessionStart` and `SubagentStart` can inject context. `reprogate handoff hook` therefore starts and resumes sessions, injects the brief and the session ID, and records turns, failures, subagent results and ends, with no model call. MCP `handoff_join` remains for clients without hooks.
- **Turn state separates waiting from dying.** `UserPromptSubmit` opens a turn and `Stop` closes it. A session whose turn closed reads as `idle`, never `interrupted`, however long the user is away. Without hooks the state comes from the lease only.
- **Git state is read when a brief is built, not at the moment of the stop.** The state at resume time is what the next agent needs, and it keeps `SessionEnd` within Claude Code's default 1.5 second hook budget. Each session records the HEAD it started at, for "commits since".
- **Subagents get a short context.** `SubagentStart` gives a subagent its session ID and the goal, not the whole brief, so 20 subagents don't each pay for it.
- **Model output is opt-in.** Captured replies (`captureMessages`) are off by default, which keeps the first slice's rule that nothing is collected automatically.
- **Review fixes:** the first independent review asked for changes. Fixed:
  - the hook never exits 2, and returns before opening the database for other projects;
  - a session that hit a rate limit and then ended stays `failed`, and pruning keeps it longer than sessions that ended normally;
  - briefs enforce every budget, with a skeleton fallback and a `truncated` flag;
  - pruning never deletes the parent of the session being started;
  - resumed subagents and prompted ended sessions reopen; a `Stop` after an end changes nothing;
  - internal agents without `SubagentStart` are ignored;
  - "commits since" uses the oldest unfinished agent session;
  - the import cycle between the contracts is gone;
  - captured text is cut before redaction; credential-shaped labels are refused or replaced;
  - enumerated columns are checked for shape and validated on read, so later values need no table rebuild;
  - Codex's newer lifecycle hooks are supported, with `Interrupt` as `idle`.
- **Deferred to slice 2:** `.agent/sessions.md` (see Projection), per-session views in `handoff_status`, and the parent rollup counts.
- **Edge cases covered by tests:** a rate-limited session reported to the next session; a finished turn reading as `idle`; 20 subagents with distinct sessions and short contexts; `SessionEnd` twice, then a resume; hooks from another project, malformed and oversized payloads; read-only configuration; Codex notifications; eight processes writing notes at once; lane and session caps; brief byte and character budgets; credential redaction, including on hostile input; a merge left in progress, untracked files, commits since the last session and a detached HEAD; a workspace without Git; connection close ending only the sessions it joined.

## Implementation notes (slice 2)

- **Rollups fold only healthy subagents.** A subagent that is failed, interrupted or quiet stays listed beside its parent, so folding never hides a problem.
- **The lane's note count includes notes the ledger already dropped** (beyond its 64 per session), so `omittedNotes` is the full gap between the session's total and what is shown.
- **Coalescing state lives in the database** (`handoff_session_projection`), so separate hook processes and servers share one interval. Every claim, coalesced or not, takes a new generation. A write is renamed into place only inside the transaction that checks its generation is still the latest and marks the file current, so renames land in generation order, an overtaken write is discarded and redone from fresh state (at most three times), and a crash after the rename leaves the file `pending`. A write that fails is recorded, so status says `unavailable` rather than `pending` until a write succeeds.
- **Rollups count each session once.** A healthy subagent folds into its nearest listed ancestor, at any depth; a listed subagent is not counted again. When a listed session is dropped for the budget, the subagents folded into it are counted as omitted too. In a lane, each count covers all of that session's descendants.
- **Abandoned temporary files are swept** by the next write: ours, private, single-link and older than five minutes. An odd entry is skipped without stopping the sweep.
- **Only a long-running server flushes a pending write by timer, and on close.** A hook command exits at once; flushing on its exit would defeat coalescing, so its pending write waits for the next event.
- **`handoff_status` stays read-only:** it reports the file as `pending` but never writes it.
- **Edge cases covered by tests:** attention subagents beside parent counts; lane budgets and counts; unknown lane session; immediate and coalesced writes; Markdown in notes kept inside the code block; the timer flush; a symlinked and a hard-linked file refused with the event still recorded; the file turned off and read-only; a one-shot hook leaving a pending write.

## Implementation notes (slice 3)

- `handoff_snapshots` keeps its schema. An adopted record adds `adoptedDocumentDigest`, and `projected_digest` holds that digest, since there is no render to hash. The record's integrity check uses the same value. A binary from before this slice reads an adopted revision as `unavailable`, so a downgrade fails closed.
- `adoptHandoff` runs under one `BEGIN IMMEDIATE`: it reads the document, inserts the snapshot and inserts the `projected` event. Requests use their own digest domain, so an `updateId` cannot be reused across `handoff_update` and `handoff_adopt`.
- `document()` reads up to 1 MiB (`MAX_ADOPTED_DOCUMENT_BYTES`), because a file kept by hand outgrows the 96 KiB render limit. Archives use the same cap.
- `handoff_sessions` gains a nullable `worktree` column; older databases get it through `ALTER TABLE` at startup, and a process that loses that race carries on. The column holds the physical path, and views show only the directory name.
- `update` now rewrites the sessions file, so its goal is never older than the handoff.
- A one-shot hook shares one repository lookup between its checks. The query joins the runner's metadata reads, so it needs one Git process and no configuration probe: an event from another project costs two, and never opens the database.
- A session moves to a new worktree only on a resumption (`SessionStart`, a prompt or a subagent start), never on a passing event, and this keeps its `failed` state.

## Out of scope

- Authenticating which agent wrote a note. Session IDs separate sessions; they do not prove identity.
- Reading model transcripts. A transcript importer could salvage more context, but it raises privacy and format-stability questions and needs its own proposal.
- Enforcing claims. Enforcement stays with the Git promotion gate.
