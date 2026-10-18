# Changelog

All notable changes will be documented in this file. The project follows [Semantic Versioning](https://semver.org/) once its first public version is released.

## Unreleased

### Added

- Optional code-discovery byte benchmark over pinned source, with graph-versus-grep comparisons, answer checks, isolated graph state, and a published local transcript.
- `reprogate research-server`: a stdio research backend with `fetch_distilled`. It checks addresses at connect time to block private-network fetches, re-checks redirects, limits size, time and content type, distills HTML into the passages relevant to the query, and enforces an estimated token budget. ReproGate configures it like any other `network_read` backend.
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
- `reprogate bench facade`: a deterministic measurement of agent-visible bytes on a published fixture. It covers context cost and break-even catalog size, plus tool results for planning, and for truncated and small execution results. It comes with a manual two-host benchmark protocol.
- Schema-on-demand `catalog.describe` and full-evidence `action.inspect` MCP tools; output schemas and conservative annotations on every façade tool.
- Opt-in host-held approvals: `approve --hold`/`--revoke-held` record signed, single-use approvals for exact plans, so `action.run` can execute `approval_required` plans without the model handling a capability token.
- Host-side `reprogate catalog import` (catalog entries from a configured backend's live tool list, with operator-declared effects and review warnings), `reprogate artifact digest`, and a code graph proxy guide for codebase-memory-mcp.
- Opt-in two-strike gate for mediated runs (`mediation.strikes`): after consecutive failures of one tool, `action.run` refuses it with `resolve_required` until a configured resolver tool succeeds. Failed results report `strikes`, and the `action.run` description states the rule.
- Opt-in host-mediated execution: `mediation` runtime configuration and the `action.run` tool for allow-decided read-effect plans, with host-issued one-use capabilities (`host-mediated:` capability IDs) and redacted, bounded model-visible results.

### Fixed

- `@modelcontextprotocol/client` is now a runtime dependency. The configured stdio downstream connector already imported it at runtime, so production installs without dev dependencies could not start configured backends.

### Changed

- `action.run` no longer repeats downstream data the text items already carry. A `structuredContent` that a text item mirrors as JSON is not appended, and top-level string fields equal to a text item become `"[text item N]"` markers. Structured content that redaction would touch, or that the bound would cut, is kept whole. `truncated` can now be `false` for results whose duplicate used to overflow the bound. The receipt still covers the complete downstream result.
- `action.run` returns a compact summary (`detail`, `executionId`, `outcome`, `truncated`, `redactions`, `omittedItems`) with the bounded downstream text in `structuredContent.content`. Its text content is the summary's JSON followed by the same text as plain, unescaped items, so text-only and structured-only hosts both see it. Receipt and result digests need `detail: "full"`. All other façade text mirrors are compact JSON.
- **Breaking:** `action.plan` returns a compact summary (`actionId`, `envelopeDigest`, `toolRef`, `decision`, `reasonCodes`, `expiresAt`, `nextStep`) by default. Pass `detail: "full"` or call `action.inspect` for the previous envelope and policy fields.
- Façade error results other than `action.execute` carry a compact text block without `structuredContent`. `policy.explain` and `action.inspect` accept only `sha256:` action IDs, and tool references are capped at 256 characters.
