# Product and engineering improvements

This is the maintained improvement backlog for ReproGate, aligned with the [phased implementation plan](ROADMAP.md). Items are ordered by the security or adoption risk they retire, not by feature novelty. Completed work stays visible so design claims can be traced to code and tests. A successful downstream call and a pair of filesystem hashes are not, by themselves, proof that all effects stayed in approved scope.

## P0 — deliver the staged authorized-change workflow (Phase 3)

- [x] Add a plan-only Git proposal with a clean-worktree witness, patch digest, exact path syntax, structural schema, and read-only drift tests.
- [ ] Specify and test the versioned change contract: repository/base-ref witness, dirty state, allowed paths, exact patch digest, policy/approval identity, expiry/revocation epoch, and destination ref.
- [ ] Stage the agent's candidate patch away from the protected target; do not assign a pre-commit enforcement claim to a direct-write backend.
- [ ] Observe renames, deletions, mode changes, symlinks, untracked files, and path escapes; compare the proposed patch and changed-path manifest with approved scope.
- [ ] Revalidate approval, policy, and Git ref/workspace witness at the promotion boundary; serialize revocation with the check, fail closed on drift, and use a compare-and-swap ref update.
- [ ] Export coverage-aware, content-addressed receipt bundles and an asymmetric-signature offline verifier that can recompute the changed-path claim from a Git object or supplied patch; make missing or unknown effect coverage explicit.
- [ ] Add optional test, secret-scan, and user-script verifier evidence without conflating test success with authorization.
- [ ] Maintain adversarial fixtures for stale refs, changed patches, concurrent promotion, interrupted promotion, symlink escape, and out-of-scope writes, plus benign false-denial fixtures.

## Delivered reference-path controls and remaining Phase 2 closure

- [x] Persist action plans without persisting raw arguments.
- [x] Atomically combine one-use capability consumption with a write-ahead execution record.
- [x] Re-read and compare the downstream tool schema immediately before dispatch.
- [x] Validate supplied arguments against the pinned schema.
- [x] Mark interrupted or ambiguous calls `indeterminate` instead of inferring an outcome.
- [x] Produce a signed Execution Receipt v1 and an independent verification function/CLI.
- [x] Exercise a real downstream MCP stdio process in integration tests.
- [x] Add a production configuration format and start the execution-enabled MCP façade only when every backend, observer, database, and secret is explicitly configured.
- [x] Bind and verify the downstream server artifact digest, not only its advertised schema.
- [ ] Add process ownership/lease metadata so recovery can distinguish a crashed worker from a still-running replica.
- [ ] Add cross-process capability race and hard-kill/response-loss fixtures.
- [ ] Document that HMAC receipt verification requires a shared secret and bounded before/after hashes do not prove effect confinement.

## P1 — make the agent-facing contract easier and cheaper to use (Phase 4)

- [ ] Add schema-on-demand detail for one catalog tool while retaining a small stable discovery surface.
- [ ] Return compact, typed plan/execution summaries, stable reason codes and next steps; expose full evidence only on demand.
- [ ] Add output schemas and truthful, conservative tool annotations; keep backwards-compatible result text until host behavior is tested.
- [ ] Mediate approval and capability use outside model-visible arguments and results.
- [ ] Bound/redact untrusted downstream output without changing what the verifier can inspect.
- [ ] Benchmark agent-visible tokens, call count, task completion, approval time, and error recovery in at least two MCP hosts before claiming savings.

## P2 — strengthen authorization and workflow consistency (Phase 5)

- [ ] Extract authenticated principal identity from a supported transport instead of trusting caller metadata.
- [ ] Add approval reason, approver identity, and policy version to capability claims.
- [ ] Support workflow-scoped revocation and signing-key rotation.
- [ ] Bind accepted parent receipts and cumulative non-widening authority across workflow steps; rejected steps cannot support later approvals.
- [ ] Add a maintained authorization-drift and prompt-injection corpus with both unsafe and benign continuations.
- [ ] Add an isolation adapter for non-Git effects before claiming filesystem, process, network, or credential confinement.
- [ ] Define multi-replica database support after SQLite semantics are proven locally.
- [ ] Add maintained abuse fixtures for schema mutation, replay races, SSRF, permission laundering, and response loss.

## P3 — adoption and interoperability (Phase 6)

- [ ] Publish stable contract and verifier packages separately from the MCP façade.
- [ ] Test at least two MCP hosts and one established gateway adapter.
- [ ] Add Streamable HTTP only after transport authentication and deployment guidance exist.
- [ ] Export OpenTelemetry spans that reference digests but exclude sensitive payloads.
- [ ] Maintain a compatibility matrix for Node, MCP protocol era, hosts, and backends.

## Product validation and kill criteria

Measure whether exact-action receipts solve a problem teams will adopt:

- time required to review and approve an action;
- percentage of approvals invalidated by legitimate drift versus malicious/unsafe drift;
- unauthorized durable promotions blocked, with explicit treatment of unobserved effects;
- replay/schema-mutation and workflow-drift attacks blocked by the contract;
- receipt verification success across independent clients without a shared signing secret;
- agent-visible tokens, tool-call count, task completion, and error recovery across hosts;
- sensitive payload bytes retained by default (target: zero).

Reconsider or narrow the product if teams will not integrate a staged-change flow without a full gateway replacement, if false invalidation makes approvals unusable, if the effect boundary cannot support an honest `verified` claim, or if existing products cover the same approval-to-commit invariant with comparable evidence.

## Explicit non-goals for now

- a general MCP registry;
- model routing or multi-agent orchestration;
- a custom sandbox runtime;
- a Kubernetes operator;
- a hosted multi-tenant evidence lake;
- a dashboard before the receipt format has external users.
