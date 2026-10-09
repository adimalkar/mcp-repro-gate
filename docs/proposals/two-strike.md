# Two-strike error gating: tenth Phase 4 slice

Status: proposed implementation. This covers the Phase 4 item "active tool-calling enforcement and 2-strike error gating" for host-mediated runs. When one tool fails twice in a row through `action.run`, the host refuses to run it again until a configured resolver tool, such as `resolve_stuck_error` from #35, has run successfully. This stops an agent from retrying the same failing command in a loop. The gate is deterministic and host-side. It is guidance for agents, not a security boundary.

## Deliverable

- **Configuration:** an optional `mediation.strikes` section:

  ```json
  "strikes": { "resolverToolRef": "research.resolve_stuck_error", "limit": 2 }
  ```

  - `resolverToolRef` must name a catalog tool whose effects are all listed in `mediation.effects`. Otherwise the configuration is refused at startup, because an agent could never unlock a blocked tool.
  - `limit` is the number of consecutive failures that blocks a tool: default 2, minimum 2, maximum 5.
  - The policy must also allow the resolver. The documentation says so, because policy is evaluated per plan and cannot be checked at startup.
- **What counts as a failure:** a mediated run whose receipt outcome is `failed`, or an executor error during a mediated run, such as an argument mismatch or a schema violation. Refusals such as `run_limit`, `expired` or `stale_plan` run nothing and do not count.
- **Counting:** per downstream tool (`serverRef` and `toolName` of the plan's envelope), across plans and arguments, because a different argument is often the same loop. A successful run of the tool resets its count. A successful run of the resolver resets every count. The resolver itself is never counted or blocked.
- **Refusal:** a blocked tool's `action.run` returns the error `{ "error": "resolve_required", "resolverToolRef": "…", "failures": n }` and runs nothing: no execution record, no capability use, no receipt.
- **Results:** when the gate is configured, a failed `action.run` result adds `strikes: { failures, limit, resolverToolRef }`, so the agent can see that the next failure will block. Successful results stay unchanged.
- **Tool description:** with the gate configured, the `action.run` description states the rule in one sentence, so the agent learns it before it is refused.
- **Scope of the state:** the counts live in memory, in the mediator of one server process. One stdio session therefore has its own counts, and a restart clears them. `action.execute` with an approved capability is not gated, because a person has approved that exact action.
- **Docs:** CONFIGURATION.md (the section, its rules and its limits), THREAT_MODEL.md (guidance, not a boundary) and CHANGELOG.

## Not in this slice

- Persisting counts across sessions or sharing them between processes.
- Checking that the resolver was asked about the same error. That cannot be decided deterministically.
- Rewriting downstream tool descriptions. Catalog descriptions stay operator-written.

## Verification

- **Mediator unit tests, with a fake downstream:**
  - two failures block the tool, and the refusal leaves no execution record;
  - an executor error counts as a strike;
  - a success in between resets the count;
  - other tools stay usable while one is blocked;
  - a resolver success unblocks every tool, while a resolver failure leaves them blocked;
  - the resolver is never blocked;
  - `limit` 3 needs three failures;
  - refusals that run nothing do not count.
- **Config tests:** a missing resolver, a resolver with unmediated effects and an out-of-range `limit` are each refused.
- **MCP test with a real client:** the `strikes` field on failed results validates against the output schema, the `resolve_required` error carries the resolver, and the description mentions the rule only when the gate is configured.
