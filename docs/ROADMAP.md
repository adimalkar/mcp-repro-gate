# Phased implementation plan

Updated 2026-09-24. The phases retire product and security risk before adding platform breadth. Estimates are solo-developer full-time-equivalent ranges, not release promises; [IMPROVEMENTS.md](IMPROVEMENTS.md) tracks individual backlog items.

## Product decision and claim boundary

ReproGate's first product workflow is an **authorized code change**: an agent proposes a patch, a trusted component binds approval to that exact patch and repository state, and the patch becomes durable only after a fresh boundary check. The output is a portable receipt stating precisely which authorization and effects were verified. The existing general MCP execution path remains a reference implementation, not a sandbox or proof that all downstream effects stayed in scope.

This is a narrower use case for the original exact-action contract, not a pivot to a generic gateway. Approval gates, signed receipts, tool search, and gateway isolation already exist in projects such as [daemonsudo](https://github.com/daemonsudo/daemonsudo) and [ToolHive](https://github.com/stacklok/toolhive). [Commit-time authorization](https://arxiv.org/abs/2607.10487) motivates checking that the approval and workspace witness remain valid when a change becomes durable; [runtime authorization consistency](https://arxiv.org/abs/2609.23498) motivates a later workflow-lineage phase. Both papers report prototypes, so neither concept is claimed as novel or unimplemented elsewhere.

Security language must distinguish: a downstream tool reporting success; a change observed by a bounded observer; and a change verified within a declared, enforced effect boundary. Missing coverage is `indeterminate`, never evidence of safety. A post-call snapshot can detect some drift but cannot undo an already-durable write. A signature proves integrity and signer identity under a trusted key; it does not, by itself, prove that an effect occurred or that the signer observed every possible effect.

## Phase 1 — action-contract kernel (implemented)

**Goal:** prove the core objects and invariants without executing untrusted code.

Scope:

- deterministic canonical JSON and SHA-256 digests;
- Action Envelope v1 with trusted-vs-asserted provenance markers;
- deterministic effect-based policy decisions and explanations;
- single-use HMAC capability tokens bound to the exact action/envelope/scopes/expiry;
- tamper-evident decision evidence chain;
- plan-only MCP server with `catalog.search`, `action.plan`, and `policy.explain`;
- JSON Schema, threat model, architecture decision, and unit tests.

Exit criteria (met for the Phase 1 semantics prototype):

- changes to bound arguments, schema, policy, or authority produce a different action identifier;
- expired, under-scoped, tampered, and replayed capabilities fail;
- the MCP process emits no non-protocol data on stdout;
- no Phase 1 documentation implies that actions are safely executed.

## Phase 2 — configured exact-call reference path (vertical slice implemented; hardening pending, 1–2 weeks)

**Goal:** retain a credible, opt-in reference path for one real downstream MCP call without overstating its guarantees.

Implemented:

- real stdio downstream client, schema discovery, and live schema re-verification;
- SQLite-persisted plans, atomic one-use capability consumption, and write-ahead execution state;
- exact argument digest checks and pinned-schema validation;
- signed Execution Receipt v1 with result and bounded filesystem snapshot digests;
- recovery of incomplete records as `indeterminate`;
- out-of-band approval and receipt-verification CLI commands;
- strict Runtime Configuration v1, artifact digest binding, and bounded symlink-safe filesystem observation.

Remaining closure work:

- cross-process race, worker-ownership, and hard-kill/response-loss fixtures;
- precise documentation and test assertions for what HMAC verification and before/after hashes do **not** prove;
- keep Git-specific workspace identity, effect classification, and commit-time enforcement in Phase 3;
- defer deterministic transcript replay unless an evaluation needs it; it is not a prerequisite for authorized-change claims.

Exit criteria:

- the same capability cannot authorize two executions, including across process races;
- changed execution arguments or downstream schema are rejected before dispatch;
- interrupted calls are recoverably `indeterminate`, not inferred successful;
- a separate process can verify a receipt with the shared secret, while documentation makes clear that this is not public-key, third-party verification;
- the reference path is never described as a production-safe write boundary.

## Phase 3 — staged authorized code change (flagship, provisional 4–6 weeks)

**Goal:** make one developer action enforceable at a durable boundary: promote an agent-proposed patch to an approved Git ref.

Current slices: the Git proposal API captures a clean-worktree witness, exact patch digest, and path list. A separate staging API applies the exact patch to a disposable Git index and checks Git-observed changed paths and regular-file modes. These are still library-level reference contracts: caller-supplied action/policy references are not authenticated, and no approval or protected-ref promotion occurs. See [Git change proposal and staging](GIT_CHANGE_PROPOSAL.md).

Implementation slices, in order:

1. **Contract and adversarial fixtures:** define a versioned change contract that binds repository identity, base commit/tree or dirty-state witness, allowed paths, exact patch digest, policy/approval identity, expiry/revocation epoch, and destination ref. Model renames, deletes, modes, symlinks, untracked files, and concurrent ref movement. Keep raw source and arguments out of receipts by default.
2. **Staged execution and promotion:** the disposable index and Git-observed changed-path manifest are implemented. Next bind a trusted approval to the exact proposal and computed effect, and design safe promotion that does not update a checked-out branch behind its worktree. Recheck approval, policy, base/ref witness, paths, and patch at promotion; serialize revocation with this check and use a compare-and-swap Git ref update or fail closed. State any residual cross-system atomicity limit. A direct-write backend may produce an observation receipt but cannot receive the stronger pre-commit claim.
3. **Portable evidence:** export the envelope, change manifest, observer-coverage statement, verifier outputs, key identity, and receipt as a content-addressed bundle. Add asymmetric signing and an offline verifier that checks approval validity **at promotion time**, detects tampering, and can recompute the Git effect claim from a trusted local repository or supplied patch artifact. Optional test and secret-scan verifiers supply separate evidence; passing them does not upgrade an authorization claim. Keep downstream success separate from `verified`, `drifted`, `failed`, and `indeterminate` effect outcomes.

Exit criteria:

- controlled tests cannot promote an out-of-scope or changed patch, or a patch based on a stale/unauthorized ref, including under concurrent attempts;
- each allowed promotion links one exact approval, observed patch, and resulting Git commit/ref transition;
- independent verification detects tampering without sharing a ReproGate signing secret, and can check the changed-path claim against the referenced Git object or patch artifact;
- every receipt declares which filesystem, process, network, and credential effects were enforced, merely observed, or not covered; a Git-ref-scoped `verified` result never implies that uncovered external effects were verified;
- false denials and approval invalidations are measured on benign fixtures, not only attack fixtures.

This phase is the first candidate for an "authorized change" product claim. It does not imply that arbitrary MCP servers are confined, or that a Git ref update makes every working-tree or external side effect atomic.

## Phase 4 — agent-native façade and compatibility (secondary, provisional 2–3 weeks)

**Goal:** let agents use the contract with few calls and little model-visible data while retaining full evidence for operators and verifiers.

Scope:

- keep a small static tool surface; add schema-on-demand discovery for one catalog entry instead of exposing all downstream schemas;
- return compact, typed plan/results with `actionId`, decision/reason code, next step, and evidence reference; make full envelopes and bundles opt-in through inspection or resources;
- use output schemas, concise descriptions, conservative truthful annotations, and stable actionable errors;
- mediate approval and capability use in a trusted host-side integration so the model need not handle a capability token;
- bound and redact downstream result text, which remains untrusted input to the agent;
- preserve MCP-compatible text alongside `structuredContent` where needed; measure what each host actually includes in model context rather than assuming wire-byte savings equal token savings. See the [MCP tool-result specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Exit criteria:

- benchmark at least two MCP hosts on a published fixture set: agent-visible tokens, call count, completion rate, approval time, and error recovery versus the current façade;
- target at least 25% lower median agent-visible tool-result tokens without worse task completion; report per-host results and abandon the target if it compromises evidence or usability;
- no approval secret appears in model-visible tool arguments, results, or logs by default;
- a verifier can still obtain the complete unchanged evidence bundle.

## Phase 5 — workflow consistency and broader effect enforcement (conditional, provisional 3–5 weeks)

**Goal:** extend a trustworthy single-change contract across accepted steps, and only then offer stronger claims for non-Git effects.

Scope:

- accepted-only parent receipt lineage and cumulative, non-widening authority across a session; rejected steps cannot authorize later actions;
- workflow-scoped revocation/expiry and bounded delegation semantics, with an abuse corpus for permission laundering and prompt-injection-driven tool use informed by [cross-channel MCP prompt-injection research](https://arxiv.org/abs/2609.18217);
- rootless/container enforcement adapter with filesystem, process, network, and secret-handle controls for broader downstream tools;
- coverage-aware receipts for every adapter; unsupported effect surfaces remain unknown rather than `verified`.

Exit criteria:

- workflow replay fixtures block authority drift without blocking expected benign continuations; both rates are published;
- maintained symlink, SSRF, credential, process, and resource-exhaustion fixtures are blocked or yield an explicit limited-coverage outcome;
- security claims name the enforcement adapter, observed surfaces, and tested platforms.

## Phase 6 — integrations and team mode (conditional, provisional 3–6 weeks)

**Goal:** make the contract portable without turning ReproGate into a gateway platform.

Scope:

- stable contract and verifier packages, plus a documented receipt format;
- adapter for an established gateway, modern Streamable HTTP only with transport authentication, and a host compatibility matrix;
- optional centralized policy, redacted metadata, and OTel digest references.

Exit criteria:

- local operation remains fully functional without a hosted service;
- raw prompts, source, arguments, and results remain local by default;
- at least one external gateway or host can produce or verify the change contract.

## Deferred until demand exists

- Kubernetes operator, server lifecycle management, and a general MCP registry;
- model routing, multi-agent orchestration, and a web dashboard;
- custom sandbox technology rather than a maintained isolation adapter;
- hosted multi-tenant evidence lake and deterministic transcript replay as a standalone product.
