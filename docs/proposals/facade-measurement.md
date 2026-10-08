# Façade measurement harness: sixth Phase 4 slice

Status: proposed implementation. The Phase 4 exit criteria require measurements before any token-savings claim. They ask for at least a 25% lower median agent-visible tool-result size on baseline operations, plus host benchmarks covering tokens, call count, completion, approval time and error recovery. This slice provides the in-repository, deterministic half: a harness that measures what the façade itself returns. It also writes down the manual protocol for the two-host runs. It does not claim host token savings.

## Deliverable

- **`reprogate bench facade [--json]`** runs fixed operations through a real in-memory MCP client against a ReproGate server, using a published synthetic fixture catalog, and reports UTF-8 bytes:
  - **Context cost:** the façade's own `tools/list` against a direct `tools/list` of every downstream tool, plus the cost of finding a tool (one search and one describe). It also reports the catalog size at which the façade breaks even.
  - **Tool results:**
    - the compact `action.plan` against `detail: "full"`;
    - `action.run` at the default output limit against the unredacted downstream result, for both a large result and a small one.

    Each result notes whether the output was truncated.

  - **The median tool-result reduction,** labelled as a fixture check, never as an exit-criterion result.
- Every measured call must succeed. A failed call stops the run, so it can never look like a large reduction.
- The fixture is deterministic and lives in the repository. Runs reproduce the same report.
- **`docs/BENCHMARKS.md`** covers the method, the current numbers, the costs as well as the savings (truncation, small-result overhead, break-even), what is not measured, and a protocol and recording template for the manual two-host benchmark.
- Review change: the first version measured discovery against definitions without counting the façade's own tool list, used a non-default 4 KiB output limit, and printed a pass verdict against the target. All three were corrected.

## Non-goals

- Host token counts, completion rate, approval time and error recovery. These need real hosts and stay in the manual protocol.
- Any claim about grep-versus-graph or raw-HTML-versus-research savings. No research tool exists yet.

## Verification

- Two runs produce identical reports.
- The break-even and median arithmetic is checked.
- The large result is truncated, and the small one shows the façade's overhead as a negative reduction.
- A failed call is refused.
- The published tables match the harness.
- The CLI prints the table, or JSON with `--json`.
