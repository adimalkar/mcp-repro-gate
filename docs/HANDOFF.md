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

- `workspaceRoot` must be an existing directory that group and others cannot write to. The projection always goes to `.agent/handoff.md` inside it. If `.agent/` already exists, it must be a directory with mode `0700` owned by the current user, and an existing `handoff.md` must be a `0600` single-link file. Permissions are never repaired automatically, so tighten them yourself first (for example `chmod 700 .agent && chmod 600 .agent/handoff.md`).
- `databasePath` needs a parent directory with mode `0700`, owned by the current user. The file is created with mode `0600` before SQLite opens it, and existing database, WAL, SHM and journal files must already be private, single-link regular files. The path is resolved to its physical location before opening, so every connection shares one WAL namespace. The database must be outside `.agent/` (compared case-insensitively on macOS and Windows).
- When `allowUpdates` is `false`, only `handoff_status` is registered, and no `.agent` files are created.

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
| `missing`      | No revision recorded for this workspace                                                                                                                                                         |
| `synchronized` | The latest revision was projected, and the document still matches it                                                                                                                            |
| `pending`      | The latest revision is durable, but its projection has not completed; the document still equals the base it was written against, or already equals the projection without a recorded projection |
| `drifted`      | The document differs from both the projection and the expected base, for example after a manual edit                                                                                            |
| `unavailable`  | A path, permission, identity or integrity check failed                                                                                                                                          |

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

All limits are checked before any effect: 64 KiB of context, 16 entries per list, 32 declared paths, 16 plan references, and a 96 KiB rendered document. Terminal control characters and bidirectional-override characters are rejected; tab, LF and CR are allowed. Caller text is escaped in the projection, so it cannot add headings, list items, link syntax or HTML. Renderers that auto-link bare URLs may still show a written URL as a link.

Errors from the handoff service return `isError` with only a stable code: `invalid_input`, `revision_conflict`, `document_conflict`, `update_conflict`, `unknown_plan`, `read_only`, `drifted` or `unavailable`. They never include file contents, SQL or host paths. Input that fails the advertised schema is rejected earlier by the MCP SDK, whose message names the failing field and constraint but does not echo the submitted value.

The contracts are published as JSON Schema in [`schemas/handoff-config.schema.json`](../schemas/handoff-config.schema.json) and [`schemas/handoff.schema.json`](../schemas/handoff.schema.json) (`$defs/update`, `$defs/statusInput`, `$defs/status`, and the persisted record at the root). The implementation additionally enforces UTF-8 byte limits and rejects accessors, proxies and sparse arrays.

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

### Redaction and bounds

Notes, summaries, tasks and captured messages pass through a redactor for well-known credential shapes before they are stored: private-key blocks, GitHub, GitLab, Slack, AWS, Google, OpenAI-style, Stripe and npm tokens, JWTs, ReproGate capability tokens, `Bearer`/`Basic` credentials and passwords in URLs. The number of redactions is returned. An agent label that looks like a credential is refused over MCP and replaced when it comes from a hook. This is a backstop for accidental pastes, not a secret scanner.

Each session keeps its newest 64 notes and a total count. A workspace keeps its newest 256 sessions, dropping sessions that ended without a reported failure first; a session seen in the last minute, and the parent of a session being started, are never dropped. Captured replies are cut to 16 KiB before redaction, so redaction stays fast on large payloads. Hook payloads over 1 MiB are ignored.

### Git observation

With `observeGit` (on by default), ReproGate reads the workspace's Git state through its hardened runner each time it builds a brief: `git status --porcelain=v2` without optional locks, so it never takes the index lock from an agent working at the same time. It also checks for a merge, rebase, cherry-pick, revert or bisect in progress, and lists up to 10 commits since the oldest unfinished agent session started (failed, interrupted, quiet or active; idle sessions never age, so they do not count), or else since the newest other session started, so work by an agent that stopped mid-task shows up whoever joined later. It records no file contents or diffs. Each Git call has a time and output bound. A workspace that is not a repository, contains submodules, or uses unsupported line-ending configuration reads as `unavailable`.

## Limits

- SQLite and the Markdown file are not one atomic transaction. A revision can be durable while its projection is `pending`. The status reports this honestly. External drift fails closed and keeps both the stored snapshot and the actual file.
- Agent identity, completed work and touched paths are declarations. Nothing collects source, diffs, environment variables or command output automatically; model replies are collected only with `captureMessages`.
- Session states other than `failed`, `idle` and `ended` are inferred from silence. Hooks must be configured for client events to be recorded; without them, only MCP calls are seen.
- Identity and permission checks narrow, but cannot remove, races with a hostile writer running as the same user.
