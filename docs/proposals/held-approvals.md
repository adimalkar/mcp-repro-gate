# Host-held approvals: fifth Phase 4 slice

Status: proposed implementation. This proposal completes the Phase 4 backlog item "mediate approval and capability use outside model-visible arguments and results". Host mediation (#29) covers only plans that policy decides `allow`. Every `approval_required` action still needs the model to carry an HMAC capability token into `action.execute`.

## Deliverable

- An optional `mediation.heldApprovals: true` setting. `mediation.effects` becomes optional, but at least one of `effects` or `heldApprovals` must be set.
- `reprogate approve --config <runtime.json> <action-id> --hold`:
  - It refuses unless `heldApprovals` is enabled. It also refuses denied and expired plans, an unknown action, and an action that already has a held approval.
  - Otherwise it records a **held approval** for that exact plan: `approvalId`, `actionId`, `envelopeDigest`, `scopes`, `issuedAt` and `expiresAt` (the plan's expiry).
  - The approval is signed with HMAC-SHA256 under the configured capability secret. The signed message carries a domain prefix (`reprogate.held-approval.v1`), so it can never be read as a capability token, and the reverse holds too.
  - It prints the approval summary, never a token.
- `reprogate approve --config <runtime.json> <action-id> --revoke-held` removes a held approval that has not been used yet.
- When a plan has a held approval, `action.run` runs it **exactly once**, but only when all of these hold:
  - the signature verifies;
  - the approval matches the plan's action ID, envelope digest and scopes;
  - the plan has not expired;
  - its decision is not `deny`;
  - the live catalog and policy still give the envelope the same decision (otherwise `stale_plan`).

  The run uses a single-use capability ID `host-held:<approvalId>`. Store uniqueness makes a second or concurrent use fail with `approval_consumed`. The host-mediation effect allowlist does not apply, because an operator approved this exact plan.

- Without a held approval, `action.run` keeps the existing auto-mediation rules for `allow` plans. An `approval_required` plan without one is refused with `awaiting_approval`.
- `action.run` annotations become conservative when held approvals are enabled: destructive and open-world, because approved plans may write.
- The receipt, executor checks, write-ahead record and `action.execute` token flow are unchanged.

## Trust notes

- **Approver identity:** a held approval proves possession of the capability secret on the host, the same trust as today's `approve` command. It does not authenticate an individual approver.
- **Database access:** write access to the store alone cannot create or alter a valid held approval. It can delete one, which only denies service. Read access reveals approval metadata, never a bearer token.

## Verification

- A real MCP client covers the full held flow. Plan an `approval_required` write action; `action.run` returns `awaiting_approval`. Approve with `--hold`; `action.run` succeeds once, with a receipt carrying `host-held:<approvalId>`. A second run returns `approval_consumed`.
- Concurrent runs: exactly one succeeds.
- Refusals with no execution:
  - a tampered signature, a different plan, an expired plan, or a policy change (`stale_plan`);
  - an approval that was revoked;
  - `--hold` while held approvals are disabled.
- `--revoke-held` refuses an approval that was already used.
- The configuration and JSON Schema are updated, along with docs, the threat model and the CHANGELOG.
