# Runtime configuration

ReproGate keeps the default `serve` command plan-only. Execution is exposed only when `serve --config` loads a complete Runtime Configuration v1 and all referenced secrets are present.

Validate the document against [`schemas/runtime-config.schema.json`](../schemas/runtime-config.schema.json). Runtime validation also enforces relationships JSON Schema cannot express:

- database, backend command, working directory, artifact, configuration, and observer roots use absolute paths;
- every catalog `serverRef` has exactly one configured backend and no backend is unused;
- every tool binds the same artifact digest as its backend;
- every tool filesystem root is covered by the configured observer;
- backend commands/artifacts and observer/database parent directories exist with the expected file type;
- capability and receipt secrets come from different environment values and contain at least 32 bytes.

## Minimal shape

```json
{
  "configVersion": 1,
  "databasePath": "/absolute/state/reprogate.sqlite",
  "catalog": [
    {
      "toolRef": "publisher.publish",
      "serverRef": "publisher",
      "toolName": "publish",
      "description": "Publish approved content",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": { "content": { "type": "string" } },
        "required": ["content"]
      },
      "effects": ["local_write", "network_write"],
      "scopes": ["publisher:write"],
      "filesystemRoots": ["/absolute/workspace"],
      "artifactDigest": "sha256:REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS"
    }
  ],
  "policy": {
    "version": 1,
    "defaults": {
      "local_read": "allow",
      "local_write": "approval_required",
      "process_exec": "approval_required",
      "network_read": "approval_required",
      "network_write": "deny",
      "credential_use": "deny",
      "destructive": "deny"
    },
    "rules": [
      {
        "id": "approved-publisher",
        "priority": 100,
        "match": {
          "toolRef": "publisher.publish",
          "effect": "network_write"
        },
        "decision": "approval_required",
        "reason": "Publishing requires exact-action approval"
      }
    ]
  },
  "backends": {
    "publisher": {
      "transport": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/publisher.mjs"],
      "cwd": "/absolute/path/to",
      "environment": {
        "inherit": "safe",
        "from": { "PUBLISHER_TOKEN": "HOST_PUBLISHER_TOKEN" }
      },
      "artifact": {
        "path": "/absolute/path/to/publisher.mjs",
        "digest": "sha256:REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS"
      }
    }
  },
  "observer": {
    "kind": "filesystem_manifest",
    "roots": ["/absolute/workspace"],
    "maxEntries": 10000,
    "maxBytes": 134217728
  },
  "secrets": {
    "capabilitySecretEnv": "REPROGATE_CAPABILITY_SECRET",
    "receiptSecretEnv": "REPROGATE_RECEIPT_SECRET",
    "receiptKeyId": "local-receipt-key-1"
  }
}
```

Secret values never belong in this file. `environment.from` maps a child-process variable to the name of an existing host variable. `inherit: "safe"` copies only a small cross-platform process environment allowlist; it does not forward variables such as `NODE_OPTIONS` or arbitrary credentials.

The artifact path identifies the file being authorized. For an interpreter command such as Node.js, point it at the executed script rather than the interpreter. ReproGate hashes that file at configured startup and again immediately before starting the backend; drift rejects startup or execution before capability consumption. This check does not eliminate a hostile same-host filesystem race; immutable/read-only deployment artifacts remain the operator's responsibility.

## Run the configured server

```bash
npm run build
REPROGATE_CAPABILITY_SECRET='<at-least-32-byte-secret>' \
REPROGATE_RECEIPT_SECRET='<a-different-at-least-32-byte-secret>' \
HOST_PUBLISHER_TOKEN='<backend-secret>' \
node dist/src/cli.js serve --config /absolute/path/reprogate.json
```

Issue approval and verify a receipt using the same configuration:

```bash
node dist/src/cli.js approve --config /absolute/path/reprogate.json '<action-id>'
node dist/src/cli.js verify-receipt --config /absolute/path/reprogate.json ./receipt.json
```

## Host-mediated execution

Most actions need a person to approve them out of band, and the model passes the resulting capability token to `action.execute`. For read-only tools that your policy already decides `allow`, add an optional `mediation` section instead:

```json
"mediation": {
  "effects": ["local_read"],
  "maxRunsPerPlan": 1,
  "result": {
    "maxTextBytes": 16384,
    "redactPatterns": ["[Bb]earer [A-Za-z0-9._~+/-]+=*"]
  }
}
```

This registers `action.run { actionId, arguments }`. The server runs a plan only when all of these hold:

- the plan's policy decision is `allow`;
- every effect in its envelope is listed in `effects`;
- the plan has not expired;
- the live catalog and policy still give this exact envelope an `allow` decision;
- the plan has run fewer than `maxRunsPerPlan` times (default 1, maximum 1000).

The server then issues and consumes a one-use capability itself, so the model never handles a token. Otherwise the call is refused with `not_allowed`, `effect_not_mediated`, `stale_plan`, `expired`, `run_limit` or `unknown_action`, and nothing runs. Different arguments make a different plan, so a run limit of 1 still allows any number of distinct queries.

- `effects` may contain only `local_read` and `network_read`. Write, process, credential and destructive effects always need out-of-band approval through `action.execute`.
- Every executor check still applies: argument digest, live schema pin, artifact digest, JSON Schema validation, the write-ahead execution record and the signed receipt. The receipt's `capabilityId` is `host-mediated:<action digest hex>:<run number>`, so audits can tell mediated runs from approved ones. Because the store accepts each capability ID once, the run limit holds even under concurrent calls.
- The `action.run` result is compact: `executionId`, `outcome`, `receiptDigest`, `resultDigest` and downstream text.
  - Capability-token-shaped strings are always redacted, and so is every fragment of 12 or more characters of the configured capability and receipt secrets, in raw or JSON-escaped form and anywhere in an item. Then `redactPatterns` are applied. Executor and downstream error messages are redacted the same way and cut to 1 KiB. Patterns compile with the `gu` flags; inline flags such as `(?i)` are not supported, and a pattern must not match the empty string.
  - The text is then cut to `maxTextBytes` (default 16384, maximum 262144) on a character boundary. Non-text items are counted in `omittedItems`.
  - The receipt's `resultDigest` still covers the complete, unredacted downstream result.

To expose a backend's tools without copying schemas by hand, run `reprogate catalog import`. [Proxying a code graph](CODE_GRAPH.md) walks through it for codebase-memory-mcp.

### Host-held approvals

Plans that policy decides `approval_required` normally need a capability token, which the model passes to `action.execute`. With `"heldApprovals": true` in `mediation`, an operator can approve a plan on the host instead:

```bash
node dist/src/cli.js approve --config /absolute/path/reprogate.json '<action-id>' --hold
node dist/src/cli.js approve --config /absolute/path/reprogate.json '<action-id>' --revoke-held
```

`--hold` records a held approval for that exact plan and prints its `approvalId`, never a token. `--hold --expires-in <seconds>` (at most 604800) ends the approval before the plan expires. Any other argument is rejected, so a mistyped flag never falls back to printing a token. The approval is signed with the capability secret, so write access to the database alone cannot create or alter one. The model then calls `action.run` with the `actionId`. The plan runs **once**, with capability ID `host-held:<approvalId>` in its receipt, under every executor check. The host-mediation effect allowlist does not apply, because a person approved this exact plan.

A held run is refused with `invalid_approval` if the signature or plan binding fails, `stale_plan` if the live catalog or policy no longer gives the same decision, `expired` once the plan expires, and `approval_consumed` once the approval has been used or revoked. Without a held approval, an `approval_required` plan gets `awaiting_approval`. `--revoke-held` succeeds only while the approval is unused. It consumes the approval's single-use ID as a tombstone in the same transaction, so a run already in progress fails instead of executing. A held approval takes precedence for its plan, even one that policy allows. After that run, the plan returns `approval_consumed` rather than falling back to auto-mediation. With held approvals enabled, `effects` is optional, and `action.run` is annotated as possibly destructive and open-world.

A held approval proves possession of the capability secret on the host, the same trust as `approve`. It does not authenticate an individual approver. Signed approvals are stored in the database, so anyone who can both read and write the store can replay an approved run until it expires. Protect the store, and use `--expires-in` to keep that window short.

Redaction removes only what it can recognise. Fragments shorter than 12 characters, a secret split into pieces across separate items or calls, and other encodings (base64, hex, percent-encoding) are not detected. **A mediated tool must not be able to read the gateway's secret material**, for example the process environment, `/proc/<pid>/environ` or the secret files. Treat downstream output as untrusted even after redaction.

## Filesystem observation

The observer hashes regular-file contents and records file type, mode, and size. It does not retain file contents, and it records but never follows symlinks inside an observed root. Entry and byte limits fail closed.

The current observer does not observe network, process, or credential effects. Configured mode remains a reference enforcement path, not a sandbox. Run one ReproGate process per SQLite database; multi-process leases and asymmetric receipt signing remain future work.
