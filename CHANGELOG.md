# Changelog

All notable changes will be documented in this file. The project follows [Semantic Versioning](https://semver.org/) once its first public version is released.

## Unreleased

### Added

- Phase 1 action-contract kernel.
- Plan-only MCP façade with catalog search and policy explanation.
- Exact-action capability tokens and tamper-evident decision evidence.
- Cross-platform CI, CodeQL, dependency review, Dependabot, and attested GitHub release automation.
- Early Phase 2 execution boundary with a real stdio downstream MCP client.
- SQLite-backed durable plans, atomic approval consumption, and write-ahead execution records.
- Live schema pin checks, JSON Schema argument validation, and indeterminate crash recovery.
- Signed Execution Receipt v1 schema, verification API, and CLI verification command.
- Maintained product and engineering improvement backlog.
- Strict Runtime Configuration v1 with explicit execution-enabled startup.
- Pre-spawn downstream artifact digest verification.
- Bounded, symlink-safe filesystem manifest observation.
- Configuration-aware approval issuance and receipt verification.
- Opt-in native agent handoff: host-configured `handoff_status`/`handoff_update` MCP tools, `serve --handoff-config`, Handoff Configuration v1 and Handoff v1 JSON Schemas, immutable SQLite snapshots with optimistic concurrency, and a bounded shared-protocol `.agent/handoff.md` projection with private history.
- Schema-on-demand `catalog.describe` and full-evidence `action.inspect` MCP tools; output schemas and conservative annotations on every façade tool.
- Opt-in host-mediated execution: `mediation` runtime configuration and the `action.run` tool for allow-decided read-effect plans, with host-issued one-use capabilities (`host-mediated:` capability IDs) and redacted, bounded model-visible results.

### Changed

- `action.run` no longer repeats downstream data the text items already carry: a `structuredContent` that a text item mirrors as JSON is not appended, and top-level string fields equal to a text item are left out of the appended JSON. The receipt still covers the complete downstream result.
- **Breaking:** `action.plan` returns a compact summary (`actionId`, `envelopeDigest`, `toolRef`, `decision`, `reasonCodes`, `expiresAt`, `nextStep`) by default. Pass `detail: "full"` or call `action.inspect` for the previous envelope and policy fields.
- Façade error results other than `action.execute` carry a compact text block without `structuredContent`. `policy.explain` and `action.inspect` accept only `sha256:` action IDs, and tool references are capped at 256 characters.
