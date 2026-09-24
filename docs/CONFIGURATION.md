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

## Filesystem observation

The observer hashes regular-file contents and records file type, mode, and size. It does not retain file contents, and it records but never follows symlinks inside an observed root. Entry and byte limits fail closed.

The current observer does not observe network, process, or credential effects. Configured mode remains a reference enforcement path, not a sandbox. Run one ReproGate process per SQLite database; multi-process leases and asymmetric receipt signing remain future work.
