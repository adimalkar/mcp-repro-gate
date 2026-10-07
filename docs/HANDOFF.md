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

## Limits

- SQLite and the Markdown file are not one atomic transaction. A revision can be durable while its projection is `pending`. The status reports this honestly. External drift fails closed and keeps both the stored snapshot and the actual file.
- Agent identity, completed work and touched paths are declarations. Nothing collects source, diffs, environment variables or command output automatically.
- Identity and permission checks narrow, but cannot remove, races with a hostile writer running as the same user.
