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
- `databasePath` needs a parent directory with mode `0700`, owned by the current user. The file is created with mode `0600` before SQLite opens it, and existing database, WAL, SHM and journal files must already be private, single-link regular files. The path is resolved to its physical location before opening, so every connection shares one WAL namespace. The database cannot sit at the projection or history paths.
- When `allowUpdates` is `false`, only `handoff_status` is registered, and no `.agent` files are created.

Serve the tools:

```sh
reprogate serve --handoff-config /absolute/private/dir/handoff.json
reprogate serve --config /absolute/runtime.json --handoff-config /absolute/private/dir/handoff.json
```

If the handoff `databasePath` matches the runtime configuration's `databasePath` exactly, the handoff tools share the runtime's execution-store connection, and `actionIds` resolve against the plans that server records. Otherwise the handoff store opens its own database, and any plan reference is rejected as `unknown_plan`.

## Tools

`handoff_status` takes `{ "handoffVersion": 1, "includeContext"?: boolean }`. By default it returns only the state, revision, update ID, digests and counts. Pass `includeContext: true` to get the stored context and plan references.

| State          | Meaning                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `missing`      | No revision recorded for this workspace                                                                                         |
| `synchronized` | The latest revision was projected, and the document still matches it                                                            |
| `pending`      | The latest revision is durable, but its projection has not completed; the document still equals the base it was written against |
| `drifted`      | The document differs from both the projection and the expected base, for example after a manual edit                            |
| `unavailable`  | A path, permission, identity or integrity check failed                                                                          |

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

Take `expectedRevision` and `expectedDocumentDigest` from `handoff_status` (`revision` and `documentDigest`). The update commits only if no other client has recorded a newer revision and the document still matches. Each update archives the previous document to `.agent/handoff-history/` before replacing it, including any manually written content. To retry after an ambiguous failure, send the identical request with the same `updateId`. A retry never overwrites a newer revision. Reusing an `updateId` with different content fails with `update_conflict`.

All limits are checked before any effect: 64 KiB of context, 16 entries per list, 32 declared paths, 16 plan references, and a 96 KiB rendered document. Caller text is escaped in the projection, so it cannot add headings, list items, links or HTML.

Errors return `isError` with only a stable code: `invalid_input`, `revision_conflict`, `document_conflict`, `update_conflict`, `unknown_plan`, `read_only`, `drifted` or `unavailable`. They never include file contents, SQL or host paths.

## Limits

- SQLite and the Markdown file are not one atomic transaction. A revision can be durable while its projection is `pending`. The status reports this honestly. External drift fails closed and keeps both the stored snapshot and the actual file.
- Agent identity, completed work and touched paths are declarations. Nothing collects source, diffs, environment variables or command output automatically.
- Identity and permission checks narrow, but cannot remove, races with a hostile writer running as the same user.
