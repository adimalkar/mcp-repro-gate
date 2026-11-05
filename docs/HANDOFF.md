# Native agent handoff

ReproGate can keep advisory session context for a single host-configured workspace. It provides that context to any MCP client through `handoff_status` and `handoff_update`. Durable revisions live in SQLite. A bounded, readable copy is written to `<workspace>/.agent/handoff.md` using the shared protocol headings, so agents that read the file directly keep working.

This context is **caller-asserted**. It never issues capabilities, approves actions, changes plans or receipts, dispatches tools, or proves that a Git effect happened.

## Host configuration

The host enables the tools, not the model. Create a private file (mode `0600` on POSIX) holding Handoff Configuration v1:

```json
{
  "configVersion": 1,
  "workspaceRoot": "/absolute/path/to/workspace",
  "databasePath": "/absolute/private/dir/context.sqlite",
  "allowUpdates": true
}
```

- `workspaceRoot` must be an existing directory that group and others cannot write to. The projection always goes to `.agent/handoff.md` inside it. If `.agent/` already exists, it must be a directory with mode `0700` owned by the current user, and an existing `handoff.md` must be a single-link file owned by the current user that group and others cannot write to. Its read bits may stay, because the private directory already keeps others out: a sync or an editor that replaces the file does not lock you out, and the next update replaces it with a `0600` file. The service and the MCP tools never repair permissions. If `.agent/` predates ReproGate, run `reprogate handoff adopt --repair-permissions` once, or tighten it yourself (see [Keeping a handoff file by hand](#keeping-a-handoff-file-by-hand)).
- `databasePath` needs a parent directory with mode `0700`, owned by the current user. The file is created with mode `0600` before SQLite opens it, and existing database, WAL, SHM and journal files must already be private, single-link regular files. The path is resolved to its physical location before opening, so every connection shares one WAL namespace. The database must be outside `.agent/` (compared case-insensitively on macOS and Windows).
- When `allowUpdates` is `false`, only `handoff_status` is registered, and no `.agent` files are created.
- `scope` is `"workspace"` (the default) or `"repository"`; see [Sharing one handoff across worktrees](#sharing-one-handoff-across-worktrees).

Serve the tools:

```sh
reprogate serve --handoff-config /absolute/private/dir/handoff.json
reprogate serve --config /absolute/runtime.json --handoff-config /absolute/private/dir/handoff.json
```

If the handoff `databasePath` and the runtime configuration's `databasePath` name the same physical file (aliases such as macOS `/var` → `/private/var` are resolved), the handoff tools share the runtime's execution-store connection, and `actionIds` resolve against the plans that server records. `serve` creates that file privately (mode `0600`) before the runtime opens it, so its parent directory must meet the private-directory rule above, and an existing runtime database must already be mode `0600`. Otherwise the handoff store opens its own database, and plan references resolve only against plans recorded in that database, so in practice they are rejected as `unknown_plan`.

## Tools

`handoff_status` takes `{ "handoffVersion": 1, "includeContext"?: boolean }`. By default it returns only the state, revision, update ID, digests and counts. Pass `includeContext: true` to get the stored context and plan references.

| State          | Meaning                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing`      | No revision recorded for this workspace; `documentDigest` is set if a file is already there, and it can be imported with `handoff_adopt`                                                        |
| `synchronized` | The latest revision was projected, and the document still matches it                                                                                                                            |
| `pending`      | The latest revision is durable, but its projection has not completed; the document still equals the base it was written against, or already equals the projection without a recorded projection |
| `drifted`      | The document differs from both the projection and the expected base, for example after a manual edit                                                                                            |
| `unavailable`  | A path, permission, identity or integrity check failed. If only the document is unusable, the revision and any requested brief are still returned                                               |

`handoff_update` takes:

```json
{
  "handoffVersion": 1,
  "updateId": "<random UUID v4>",
  "expectedRevision": 0,
  "expectedDocumentDigest": null,
  "context": {
    "activeAgent": "claude-code",
    "goal": "…",
    "completed": ["…"],
    "touchedFiles": ["src/example.ts"],
    "blockers": [],
    "nextSteps": ["…"]
  },
  "actionIds": []
}
```

Take `expectedRevision` and `expectedDocumentDigest` from `handoff_status` (`revision` and `documentDigest`). The update commits only if no other client has recorded a newer revision and the document still matches. Each update archives the previous document to `.agent/handoff-history/` before replacing it, including any manually written content. History keeps the newest 32 archives written through the current database, so a manual document is eventually pruned; copy it elsewhere if you need it permanently. Archives written through another or replaced database are never pruned, and pruning never removes the archive written by the same update. If a crash truncates an archive before it is flushed, an identical retry reports `unavailable`; retry with a new `updateId` instead. A live service binds the directory modes it first observed, so after changing `.agent` or workspace permissions, restart the server. To retry after an ambiguous failure, send the identical request with the same `updateId`. A retry never overwrites a newer revision. Reusing an `updateId` with different content fails with `update_conflict`.

All limits are checked before any effect: 64 KiB of context, 16 entries per list, 32 declared paths, 16 plan references, and a 96 KiB rendered document. A document already on disk can be larger, up to 1 MiB; past that, `handoff_status` reports `unavailable`. Terminal control characters and bidirectional-override characters are rejected; tab, LF and CR are allowed. Caller text is escaped in the projection, so it cannot add headings, list items, link syntax or HTML. Renderers that auto-link bare URLs may still show a written URL as a link.

Errors from the handoff service return `isError` with only a stable code: `invalid_input`, `revision_conflict`, `document_conflict`, `not_drifted`, `update_conflict`, `unknown_plan`, `read_only`, `drifted` or `unavailable`. They never include file contents, SQL or host paths. Input that fails the advertised schema is rejected earlier by the MCP SDK, whose message names the failing field and constraint but does not echo the submitted value.

The contracts are published as JSON Schema in [`schemas/handoff-config.schema.json`](../schemas/handoff-config.schema.json) and [`schemas/handoff.schema.json`](../schemas/handoff.schema.json) (`$defs/update`, `$defs/adopt`, `$defs/statusInput`, `$defs/status`, and the persisted record at the root). The implementation additionally enforces UTF-8 byte limits and rejects accessors, proxies and sparse arrays.

## Keeping a handoff file by hand

A document changed outside ReproGate, or kept by hand before ReproGate was set up, does not have to stay `drifted` or be overwritten. `handoff_adopt` records the file as it is now as a new revision:

```json
{
  "handoffVersion": 1,
  "updateId": "<random UUID v4>",
  "expectedRevision": 3,
  "expectedDocumentDigest": "sha256:…",
  "agent": "claude-code"
}
```

Take `expectedRevision` and `expectedDocumentDigest` from `handoff_status` after reading the file, so an edit made after you read it is refused with `document_conflict` instead of being accepted unseen. `agent` is optional; without it, the name comes from the document's `Last Active Agent` line. Retry with the same `updateId` after an ambiguous failure.

- **Nothing is written to the file.** The revision is recorded as already projected, with provenance `adopted_document`. The next `handoff_update` archives the adopted document like any other, then replaces it with the rendered projection.
- **Only a document that differs from the recorded state can be adopted.** A document that already matches the latest revision, or that is the base of a projection still in flight, returns `not_drifted`, so an adoption never discards a revision that has not reached the file yet. A deleted document has nothing to adopt: the next `handoff_update`, with `expectedDocumentDigest: null`, writes it again.
- **The first adoption is the import.** With no revision recorded, `expectedRevision` is 0 and the file becomes revision 1. This also applies after [switching `scope`](#sharing-one-handoff-across-worktrees), which starts a new history.
- **Briefs say when to do this.** `handoff.document` in a brief is `none`, `untracked`, `synchronized`, `pending`, `drifted`, `deleted` or `unavailable`, and the text form of a brief opens with what to do when the file is untracked, drifted or deleted, or warns that it could not be read. In repository scope, `handoff.documentWorktree` names the worktree that holds it. `.agent/sessions.md` says the same.

Only the digest and a short extract are stored, not the document. So a brief has something to show, the goal and lists are read from the shared-protocol headings, with or without numbers: `Active Goal / Task`, `Where We Left Off`, `Implementation Problems & Blockers` and `Immediate Next Steps`. A `Status` line above the sections leads the goal, since files kept by hand often say there where things stand. The extract keeps 2 KiB of goal and 16 items of 512 bytes per list. Redaction runs on the whole document, so a credential spanning lines is caught, and again on each value after its Markdown escapes are undone; control characters are replaced, and the file itself is left as it is. A code fence that never closes hides nothing, and a wrapped line stays part of its list item. A wrapped line stays part of its list item. A document with none of these headings is still adopted, and the goal then points to the file.

Adopted text is caller-asserted like any other handoff context, and its source is a file, which anyone able to write to `.agent` could have changed. Read a document you did not write before adopting it, for example one that arrived in a repository you cloned: it reaches later agents through briefs.

The same steps are available to a person, and they need no model call:

```sh
reprogate handoff adopt --config /absolute/private/dir/handoff.json
```

This shows the state, the digest and what would be recorded, and changes nothing. To record it, run it again with `--digest sha256:…`; add `--agent <name>` to name the author.

A workspace that kept plain files usually has a `.agent/` that others can read, which the service refuses at startup. `brief` and `hook` then say which paths are the problem, and offer this command only when it can fix them. Add `--repair-permissions` to make `.agent/`, `handoff.md`, `sessions.md` and `handoff-history/` private first:

```sh
reprogate handoff adopt --config /absolute/private/dir/handoff.json --repair-permissions
```

It changes only those paths and archives with ReproGate's name shape, and leaves anything else in `.agent/` alone. If any of them is a symlink, a hard link or owned by someone else, it stops before changing anything.

## Sharing one handoff across worktrees

By default each workspace root has its own history, so every Git worktree needs its own configuration, and agents in different worktrees of one task cannot see each other. With `"scope": "repository"`, one configuration covers every worktree of a repository:

```json
{
  "configVersion": 1,
  "workspaceRoot": "/absolute/path/to/main/worktree",
  "databasePath": "/absolute/private/dir/context.sqlite",
  "allowUpdates": true,
  "scope": "repository"
}
```

- **One history.** Revisions, sessions and notes are keyed by the repository's Git common directory instead of the workspace root, so removing a worktree loses nothing. If it was the worktree `workspaceRoot` names, hooks and startup report `unavailable` until the configuration names another one; the document that was in it goes with it, and the history stays.
- **One document.** `.agent/handoff.md` and `.agent/sessions.md` stay in `workspaceRoot`, whichever worktree an update came from. Worktrees do not get their own copies, so an agent elsewhere reads the brief, not the file.
- **Sessions record their worktree.** Hooks are accepted from any worktree of the repository, and an MCP server or CLI command uses the worktree it runs in. `worktree` in a session view and `worktree` in the Git observation give its directory name, never a host path.
- **Git state is per worktree.** A brief reads the Git state of the worktree it was asked from. Commits since an earlier session count only sessions of that worktree, since a range across branches means nothing. A session resumed in another worktree moves there and starts from that worktree's head, even if it crashed without reporting an end. A merge in progress in another worktree does not appear in the Git section; look at that session instead.

The repository is resolved at startup and for each hook event from another directory, by running Git. If `workspaceRoot` is not in a repository, or Git cannot read it, startup fails instead of quietly keeping a per-workspace history. Hooks from a directory in another repository, even one nested inside a worktree, or from one that no longer exists, are ignored.

Switching `scope` starts a new history, and the old one stays in the database. The document stays on disk, so it can be imported with `handoff_adopt`. Moving a repository also starts a new history, just as moving a workspace does.

## Sessions: many agents, abrupt stops

A single handoff document fails in two common situations: many agents working at once, and an agent that stops before writing it, because of a rate limit, a crash, a closed terminal or context compaction. Sessions cover both. Each agent or subagent gets its own session. Agents add short notes to their own session, and ReproGate records lifecycle events itself, so the next agent learns what happened even if the previous one never wrote a word.

### What is observed and what is asserted

| Source                                            | Provenance        | Examples                                                       |
| ------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| Session lifecycle from MCP calls and client hooks | `observed`        | started, last seen, stopped on `rate_limit`, ended, subagent   |
| Workspace Git state, read when a brief is built   | `observed`        | branch, divergence, merge or rebase in progress, changed paths |
| Notes, summaries, the handoff document            | `caller_asserted` | "half of the migration is done", "decided to use WAL"          |

"Observed" means ReproGate saw the event or read the state itself. It does not mean the agent's work is correct, and a session ID does not authenticate an agent.

### Session states

| State         | Meaning                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`      | Seen within the lease (default 300 seconds)                                                                                                                       |
| `idle`        | The client reported that its turn finished; the session is waiting for input                                                                                      |
| `quiet`       | Silent for longer than the lease, but within the grace period (default 600 seconds)                                                                               |
| `interrupted` | Silent for longer than lease plus grace, with no reported end; it probably stopped without handing off                                                            |
| `failed`      | The client reported that the turn stopped on an error such as `rate_limit`, `overloaded` or `billing_error`, and the session did not complete normally afterwards |
| `ended`       | Ended normally (`completed`), by its client (`client_ended`), as a finished subagent, or because its MCP connection closed (`disconnected`)                       |

Only `failed`, `idle` and `ended` are facts reported by a client or the server. `quiet` and `interrupted` are inferred from silence, so a long model turn can look quiet; any later call from the session makes it `active` again. Lease and grace lengths are set in the configuration's optional `sessions` block.

### Tools

When `allowUpdates` is true, three more tools are registered, and the server's MCP instructions tell clients when to use them:

- `handoff_join { handoffVersion, agent, kind?, parentSessionId?, task?, briefBytes? }` starts a session and returns its `sessionId` with a resume brief.
- `handoff_note { handoffVersion, sessionId, kind, text }` appends one note: `progress`, `blocker`, `decision`, `next` or `result`. Notes go to the agent's own session, so concurrent agents never conflict, unlike whole-document updates.
- `handoff_end { handoffVersion, sessionId, summary? }` ends the session; the summary is stored as a `result` note.

`handoff_status { handoffVersion: 1, brief: true, briefBytes? }` adds a brief to the status. A brief lists the sessions that need attention first (failed, interrupted, quiet), recent blocker and decision notes, the goal and next steps from the latest handoff revision, and the Git state observed now. It always fits `briefBytes` (default 8 KiB; at least 1 KiB). Dropped sessions, notes and paths are counted, and `truncated` is true when anything else was removed or cut short. Under extreme pressure only the skeleton remains: counts and the Git summary, with no free text.

When the MCP connection closes, the server ends the sessions joined through it as `disconnected`.

### Client hooks: recording without a model call

`reprogate handoff hook --config <handoff.json>` reads a Claude Code hook payload on standard input and records the event. It needs no model quota, so it still runs after a rate limit. It ignores payloads whose `cwd` is outside the configured workspace, so it can be configured for every project. It never blocks the client. Claude Code treats exit code 2 as "block", so the command never uses it: a payload it cannot read, or one from another project, exits 0, and any other failure, including a mistyped command line, exits 1 with a short code on standard error, which Claude Code shows without blocking. A payload from another project returns before the database is opened.

| Claude Code event  | Recorded                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`     | Starts or resumes the session; prints the brief and the session ID as `additionalContext`, so the agent starts with it                                                           |
| `UserPromptSubmit` | Activity, with the turn open; reopens an ended session. The prompt is not stored                                                                                                 |
| `Stop`             | The turn finished: `idle`                                                                                                                                                        |
| `StopFailure`      | The turn stopped on the reported error: `failed`. Only a new prompt or note clears it; it stays `failed` if the client then ends the session, because the work may be unfinished |
| `SubagentStart`    | Starts, or reopens, a subagent session under its parent; gives the subagent its session ID and the goal only, not the whole brief                                                |
| `SubagentStop`     | Ends the subagent session. Claude Code's internal agents (prompt suggestions, `/btw`) never send `SubagentStart`, so their stops are ignored                                     |
| `PreCompact`       | Activity                                                                                                                                                                         |
| `SessionEnd`       | Ends the session with the client's reason; it reads no Git state, so it fits the default 1.5 second budget                                                                       |

Add the hooks to the project's or user's Claude Code settings (adjust the paths):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "reprogate handoff hook --config /absolute/private/dir/handoff.json"
          }
        ]
      }
    ]
  }
}
```

Codex has lifecycle hooks with the same payload fields (`session_id`, `cwd`, `hook_event_name`, `agent_id`, `last_assistant_message`). Configure the same events with `--client codex`, so its sessions are labelled as Codex. Codex also reports `Interrupt` when the user stops a turn, recorded as `idle`. It has no `StopFailure`, so a Codex turn that stops on an error reads as `quiet`, then `interrupted`.

Older Codex versions only offer the turn-completion `notify` program, which receives the notification as its last argument:

```toml
notify = ["reprogate", "handoff", "hook", "--config", "/absolute/private/dir/handoff.json", "--client", "codex"]
```

Each completed turn then marks the thread's session `idle`; a notification never reopens a session that already ended. That channel reports no errors or session ends, so a Codex session that stops mid-turn reads as `idle` after its last finished turn, and the observed Git state shows what changed since.

`reprogate handoff brief --config <handoff.json> [--json] [--bytes <n>]` prints the brief for any agent or person: text limited to `n` characters (default 9000), or JSON limited to `n` bytes.

### Messages from the model

By default nothing the model writes is collected automatically. With `"sessions": { "captureMessages": true }`, the last reply of each turn (`Stop`, Codex notifications) and each subagent's final reply (`SubagentStop`) are stored, up to 1 KiB, after redaction. They help the next agent see what a session said last, but they are model output, so they may contain anything the model saw.

### Subagents, lanes and the sessions file

**Rollups.** In a brief, a subagent that needs attention (`failed`, `interrupted` or `quiet`) is listed on its own. Any other subagent, at any depth, is folded into the `subagents` counts of its nearest listed ancestor, so each session is listed or counted exactly once. With 20 healthy subagents the brief shows one parent line, such as `subagents: 19 active, 1 ended`. When a listed session is dropped to fit the budget, `omittedSessions` counts the subagents folded into it too.

**Lanes.** `handoff_status { handoffVersion: 1, sessionId, briefBytes? }` adds `lane`: that session in full, with its newest notes (up to 64) and every direct subagent, ordered for attention and each with counts of its own descendants, within `briefBytes`. `omittedNotes` counts notes dropped by the per-session cap or the budget, `omittedSubagents` counts subagents dropped for the budget, and `truncated` is set when text was cut. An unknown session returns `unknown_session`.

**`.agent/sessions.md`.** Agents that read files instead of calling tools get a generated file beside `handoff.md`. It holds the brief without Git state, since reading Git on every event would cost too much. Every line of it is indented as a code block, so note text cannot render as headings, links or HTML. It is rewritten, never merged, and its header says when it was generated; states in it are as of that time.

- Session starts and ends, failures, joins and subagent starts and stops rewrite it at once. Notes and turn events rewrite it at most once per `projectionIntervalSeconds` (default 5); in between, `handoff_status` reports `sessionsFile: "pending"`. A long-running server writes the pending change after the interval. A one-shot hook command leaves it for the next event, so the file may lag behind turn events. Every event, including a coalesced one, takes a new claim. A write is renamed into place only if no later claim exists, and in the same database transaction that marks the file current (the directory is flushed to disk after that transaction, so a slow disk never holds the database lock), so writes land in order and an overtaken write is redone from fresh state (at most three times). The file is reported `written` only when it holds the newest claimed state; a writer that crashes mid-write leaves it `pending`.
- It is written like `handoff.md`: a private temporary file, then an atomic rename. An existing `sessions.md` that is a symlink, a hard link or writable by others is refused, never followed; read bits left by a sync do not matter, because the file is replaced by a private one. A failed write never loses the event, because the database is the record; status then reports `sessionsFile: "unavailable"` until a write succeeds. Temporary files abandoned by a crashed writer are removed by the next write once they are five minutes old.
- `"sessions": { "projectFile": false }` turns it off (`sessionsFile: "disabled"`), and read-only configurations never write it.

### Redaction and bounds

Notes, summaries, tasks and captured messages pass through a redactor for well-known credential shapes before they are stored: private-key blocks, GitHub, GitLab, Slack, AWS, Google, OpenAI-style, Stripe and npm tokens, JWTs, ReproGate capability tokens, `Bearer`/`Basic` credentials and passwords in URLs. The number of redactions is returned. An agent label that looks like a credential is refused over MCP and replaced when it comes from a hook. This is a backstop for accidental pastes, not a secret scanner.

Each session keeps its newest 64 notes and a total count. A workspace keeps its newest 256 sessions, dropping sessions that ended without a reported failure first; a session seen in the last minute, and the parent of a session being started, are never dropped. Captured replies are cut to 16 KiB before redaction, so redaction stays fast on large payloads. Hook payloads over 1 MiB are ignored.

### Git observation

With `observeGit` (on by default), ReproGate reads the workspace's Git state through its hardened runner each time it builds a brief: `git status --porcelain=v2` without optional locks, so it never takes the index lock from an agent working at the same time. It also checks for a merge, rebase, cherry-pick, revert or bisect in progress, and lists up to 10 commits since the oldest unfinished agent session started (failed, interrupted, quiet or active; idle sessions never age, so they do not count), or else since the newest other session started, so work by an agent that stopped mid-task shows up whoever joined later. It leaves `.agent` itself out of the changes, so handoff files never read as uncommitted work. It records no file contents or diffs. Each Git call has a time and output bound. A workspace that is not a repository, contains submodules, or uses unsupported line-ending configuration reads as `unavailable`.

## Limits

- SQLite and the Markdown file are not one atomic transaction. A revision can be durable while its projection is `pending`. The status reports this honestly. External drift fails closed and keeps both the stored snapshot and the actual file.
- An adopted revision records a file's digest and a best-effort extract of it. It does not check that the file's claims are true, or who wrote it.
- Agent identity, completed work and touched paths are declarations. Nothing collects source, diffs, environment variables or command output automatically; model replies are collected only with `captureMessages`.
- Session states other than `failed`, `idle` and `ended` are inferred from silence. Hooks must be configured for client events to be recorded; without them, only MCP calls are seen.
- Identity and permission checks narrow, but cannot remove, races with a hostile writer running as the same user.
