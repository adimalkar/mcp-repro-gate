# Host-mediated execution and bounded results: third Phase 4 slice

Status: proposed implementation. This proposal follows the Phase 4 roadmap item "Host mediation & redaction". It is a prerequisite for proxying read-only downstream tools, such as a code graph, without a human approval per query. It claims no measured token savings.

## Problem

Every downstream call needs an out-of-band capability token, and the model must pass that token in `action.execute` arguments. That is right for effects that need a human decision. It is unusable for read-only tools the operator's policy already decides `allow`, and it puts a bearer token in model-visible arguments. Downstream output also reaches the model unbounded and unredacted.

## Deliverable

- An optional `mediation` section in Runtime Configuration v1:

  ```json
  "mediation": {
    "effects": ["local_read"],
    "result": { "maxTextBytes": 16384, "redactPatterns": ["[Bb]earer [A-Za-z0-9._~+/-]+=*"] }
  }
  ```

  `effects` must be a non-empty subset of `local_read` and `network_read`. `result` is optional; `maxTextBytes` defaults to 16384 and is capped at 262144. There are at most 16 patterns of at most 256 characters each, and they must compile as JavaScript regular expressions with the `gu` flags. Inline flags such as `(?i)` are not supported on Node 22.

- A new MCP tool, `action.run { actionId, arguments }`, registered only when an executor and `mediation` are both configured. The server mediates a run only when all of these hold:
  - the persisted plan's policy decision is `allow`;
  - every effect in its envelope is in `mediation.effects`;
  - the plan has not expired.

  Otherwise it refuses with a stable reason code and no side effect. A mediated run:
  - issues a one-use capability bound to the exact plan, with a `jti` of `host-mediated:<action digest hex>:<run number>` so receipts record the provenance;
  - consumes that capability through the existing executor, so every existing check still applies: argument digest, live schema pin, artifact digest, JSON Schema validation, write-ahead execution record, signed receipt.

- The model-visible `action.run` result is compact: `executionId`, `outcome`, `receiptDigest`, `resultDigest`, `content`, `truncated`, `redactions` and `omittedItems`.
- Review changes: each run re-checks the live catalog and policy (`stale_plan`). An optional `maxRunsPerPlan` (default 1) is enforced atomically through numbered single-use capability IDs (`run_limit`). Redaction covers every fragment of 12 or more characters of a secret, raw or JSON-escaped. Error messages are redacted and bounded, and output stops at the first cut.
  - `content` keeps only text items.
  - Redaction runs before bounding. It always removes capability-token-shaped strings and the configured capability and receipt secret values, then applies the host patterns.
  - The total text is then cut to `maxTextBytes` on a UTF-8 boundary.
  - Structured downstream content appears only as text, under the same budget.
- What does not change:
  - the receipt and execution record;
  - `resultDigest`, which remains the digest of the complete, unredacted downstream result, so a verifier's evidence is unchanged;
  - `action.execute` and its result shape.

## Non-goals

- Host-held tokens for `approval_required` plans. Those need an operator interface and come in a later slice.
- Write or destructive effects through mediation. These are rejected by the configuration schema.
- Content-level secret detection beyond the configured patterns and known secret values.

## Verification

- A real MCP client runs `action.run` against the configured stdio downstream fixture and gets a compact result. A receipt verifies with the receipt secret, records `capabilityId` starting with `host-mediated:`, and its `resultDigest` matches the unredacted downstream result.
- Refusals produce no execution row and no token use: `approval_required`, a non-allowlisted effect, an expired plan, unknown plans, and changed arguments.
- Redaction covers token-shaped strings, configured secret values and host patterns. Bounding is checked on multi-byte text and on structured content.
- `action.run` is absent without `mediation`. The configuration rejects write effects and invalid patterns. JSON Schema and docs are updated.
