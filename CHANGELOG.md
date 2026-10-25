# Changelog

All notable changes will be documented in this file. The project follows [Semantic Versioning](https://semver.org/) once its first public version is released.

## Unreleased

### Added

- Portable Git promotion evidence: `git-review export-evidence` writes a host-signed (Ed25519), content-addressed bundle for a resolved attempt, and `git-review verify-evidence` checks it offline against public keys, with optional effect checks against a trusted clone or patch. Version 2 configurations accept `evidence.signingKeyPath`. Git Promotion Evidence v1 JSON Schema.
- `reprogate git-review promote`, `resume`, `status` and `recover --confirm-quiescent`: host-only commands that drive the final Git promotion gate with Git Review Configuration v2 (`destinationMode: "uncheckout_destination"`, `ownership.fencePath`) and its JSON Schema. Existing review commands accept version 2 proposals under a version 2 configuration. `releaseUnreservedGitPromotionFence` releases a fence whose attempt was never reserved. See `docs/GIT_PROMOTION.md`.
- Final Git promotion gate (library, host-only): `promoteGitPromotionAttempt` rechecks a prepared attempt under its fence and the ledger lock, commits a durable admission, then runs an expected-old `update-ref`. Exact readback records `confirmed`; a rejection at the gate records `failed`; anything uncertain after admission records `indeterminate` and keeps the fence. `recoverGitPromotionAttempt` resolves interrupted attempts after a host quiescence acknowledgement, and `getGitPromotionStatus` reads back the attempt, admission and outcome. Insert-only admission and outcome tables, SQL guards, and JSON Schemas.
- Optional code-discovery byte benchmark over pinned source, with graph-versus-grep comparisons, answer checks, isolated graph state, and a published local transcript.
- `reprogate bench research [--html <file> --query <text>] [--json]`: a deterministic research measurement (fixture v1, synthetic pages) through a real MCP client, against raw HTML and page-text baselines, with an answer check per page. Published in `docs/RESEARCH.md` with a manual run on four real pages.
- Research search: `--search-endpoint` (SearXNG-compatible JSON, with an optional `--search-endpoint-private` exemption for that origin only) enables `web_search` and `resolve_stuck_error`. The endpoint's origin is fixed by its template (`{query}` only after the host). These clean error text into a query with best-effort secret redaction, read the top results under the same fetch protections, and return the relevant passages and code with sources within one estimated budget.
- `reprogate research-server`: a stdio research backend with `fetch_distilled`. It checks addresses at connect time to block private-network fetches, re-checks redirects, limits size, time and content type, distills HTML into the passages relevant to the query, and enforces an estimated token budget. ReproGate configures it like any other `network_read` backend.
- Opt-in compact graph search/snippet views selected by exact host-configured server/tool identities, preserving pagination, locations, complete source and the original signed result digest; offline replay of six recorded graph tasks.
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

- `action.plan` and `ReproGateKernel.plan` reject arguments that fail the catalog tool's input schema, with the executor's validator settings. Previously such a plan could be persisted, explained and approved, then refused at execution. Error messages name schema paths, never argument values.
- New plan and approval SQLite databases are created owner-only (`0600`), and so are their sidecars. `git-review import` used to create a world-readable ledger that `git-review promote` then refused. Fence permission errors now name the offending path and the required modes.
- `reprogate help`, `--help` and `-h` print usage on stdout and exit 0 instead of exiting as a usage error.
- The façade benchmark planned `graph.list_routes` without its required `method` argument; the published numbers are unchanged.
- `@modelcontextprotocol/client` is now a runtime dependency. The configured stdio downstream connector already imported it at runtime, so production installs without dev dependencies could not start configured backends.

### Changed

- `parseGitReviewConfig`, `loadGitReviewConfig` and config snapshots now return `GitReviewConfig` (version 1 or 2). Version 1 configurations behave as before and cannot promote.
- `action.run` no longer repeats downstream data the text items already carry. A `structuredContent` that a text item mirrors as JSON is not appended, and top-level string fields equal to a text item become `"[text item N]"` markers. Structured content that redaction would touch, or that the bound would cut, is kept whole. `truncated` can now be `false` for results whose duplicate used to overflow the bound. The receipt still covers the complete downstream result.
- `action.run` returns a compact summary (`detail`, `executionId`, `outcome`, `truncated`, `redactions`, `omittedItems`) with the bounded downstream text in `structuredContent.content`. Its text content is the summary's JSON followed by the same text as plain, unescaped items, so text-only and structured-only hosts both see it. Receipt and result digests need `detail: "full"`. All other façade text mirrors are compact JSON.
- `fetch_distilled` weights query terms by their rarity on the page. Blocks that match only common terms rank last and fill in only when the other matches use less than half the budget. `resolve_stuck_error` keeps equal term weights. Both keep repeated text blocks once, preferring a copy with a permalink character (the section heading), and a query keeps its first 64 distinct terms.
- **Breaking:** `action.plan` returns a compact summary (`actionId`, `envelopeDigest`, `toolRef`, `decision`, `reasonCodes`, `expiresAt`, `nextStep`) by default. Pass `detail: "full"` or call `action.inspect` for the previous envelope and policy fields.
- Façade error results other than `action.execute` carry a compact text block without `structuredContent`. `policy.explain` and `action.inspect` accept only `sha256:` action IDs, and tool references are capped at 256 characters.
