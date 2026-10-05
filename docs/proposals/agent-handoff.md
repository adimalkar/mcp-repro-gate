# Native agent handoff: first Phase 4 slice

Status: proposed implementation. This proposal follows the updated Phase 4 roadmap. Its token reduction targets and cross-host continuity claims remain unmeasured.

## Deliverable

Add opt-in `handoff_status` and `handoff_update` MCP tools, a versioned handoff configuration/record contract, a durable context table in `SqliteExecutionStore`, and a bounded projection at the host-configured workspace's `.agent/handoff.md`. Ship CLI configuration, schemas, compatibility documentation, and real MCP/SQLite/filesystem tests together.

The default server keeps its current surface. A host explicitly enables this local context channel. The tools record advisory context; they do not issue capabilities, approve actions, alter plans or receipts, dispatch tools, apply patches, or promote Git refs.

## Context and provenance

- Context contains the active agent, goal, work completed, declared touched paths, blockers, next steps, and optional references to persisted action IDs. Caller context is explicitly asserted, not authenticated operator identity or observed workspace evidence.
- Plan references are resolved through the same private execution-store connection. Capture only action/envelope identifiers and conservative execution summaries, never capability tokens, raw arguments, private keys, or receipts containing secrets.
- Leave the existing working tree and uncommitted changes in place. Do not automatically collect source, Git diff contents, environment variables, command output, or signing material. This slice does not promise restoration of files deleted outside the tool or a complete observed Git witness.
- Preserve the preceding handoff document in bounded private local history before replacing it, including manually authored sections. Default tool output contains revision/digests, state, and counts. Context retrieval is explicit and bounded.

## Host configuration and public contract

- A separate strict configuration pins an absolute workspace root and dedicated SQLite path. Update authority is an explicit host option; it is never chosen in model arguments. Permit use of the configured runtime's store only when the database binding matches.
- Model inputs contain notes, optional action references, an update UUID for idempotent retries, and expected context/document revisions. No model-provided filesystem or database target is accepted.
- Bound record/document bytes and every collection/string before effects. Strictly snapshot accepted values and reject unknown fields, unsupported prototypes, accessors, sparse arrays, invalid identifiers, and noncanonical timestamps.
- Return typed results with conservative MCP annotations. Maintain compatible result text as well as `structuredContent`. Error codes are stable and do not echo file contents, SQL, or sensitive paths.

## Persistence, concurrency, and projection

- Persist canonical immutable snapshots and their digests in the existing SQLite execution-store connection using an additive table. Bind references to actual persisted plans without changing execution or approval semantics.
- Use optimistic revision checks under SQLite writer serialization. Two clients with the same expected revision cannot silently overwrite one another. Reusing an update UUID requires identical owned context and references; it cannot mutate an existing snapshot.
- SQLite is the durable context source. A reserved record can survive a failed Markdown projection. Status distinguishes missing, synchronized, pending, drifted, and unavailable context honestly.
- SQLite and Markdown are not a distributed atomic transaction. An explicit identical retry may reconcile an unchanged base or already matching projection; external drift must fail closed and preserve both the durable snapshot and actual file. Context equality is a current observation, not evidence of historical execution or Git success.
- Bound waits and synchronous document I/O. Serialize cooperative projections so an older revision cannot overwrite a newer one. Keep interrupted or ambiguous outcomes inspectable; do not silently clear pending records or treat a failed call as proof of rollback.
- Write a private exclusive temporary file, check descriptor/path and parent identities, flush it, and replace the fixed Markdown projection atomically. Reject symlinks, hard-link destinations, lossy path aliases, unsafe database/sidecars, and changed path identities. Do not repair unsafe permissions or follow an arbitrary target. State the residual limitation against hostile same-user filesystem writers.

## Verification

- Real MCP clients discover the tools only when configured and exercise strict inputs, output schemas, compact status, explicit context retrieval, read-only configuration, and errors.
- Real SQLite verifies restart durability, plan reference binding, immutable/idempotent history, two-process revision conflicts, and isolation from plans/capabilities/executions.
- Filesystem tests cover existing manual documents, non-ASCII paths, missing documents, drift, aliases, hard links, bounded content, unsafe paths/permissions, and projection/commit failure boundaries. Verify unrelated files and uncommitted workspace content remain unchanged.
- Cross-process and crash fixtures run compiled workers with bounded waits and owned-child reaping. Use deterministic clocks where timestamp edges matter.
- Run formatting, lint, type checking, the full suite, audit, package check, then independent specification and separate security reviews. Require actual supported-platform CI on the published head.

## Subsequent Phase 4 slices

Graph proxying, distilled web research, error-resolution policy, schema-on-demand discovery, host mediation, and two-host token/completion benchmarks follow separately. Tool descriptions can encourage use; deterministic retry enforcement requires host-side state and gates. No measured savings or cross-host benchmark is claimed by this slice.
