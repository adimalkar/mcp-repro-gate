# Façade measurement harness: sixth Phase 4 slice

Status: proposed implementation. The Phase 4 exit criteria require measurements before any token-savings claim. They ask for at least a 25% lower median agent-visible tool-result size on baseline operations, plus host benchmarks covering tokens, call count, completion, approval time and error recovery. This slice provides the in-repository, deterministic half: a harness that measures what the façade itself returns. It also writes down the manual protocol for the two-host runs. It does not claim host token savings.

## Deliverable

- **`reprogate bench facade [--json]`** runs a fixed set of operations through a real in-memory MCP client against a ReproGate server, using a published synthetic fixture catalog. For each operation it reports the UTF-8 bytes of the complete agent-visible result (the text block plus `structuredContent`) next to a stated baseline:

  | Operation      | Measured                        | Baseline                                                                                                          |
  | -------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
  | Discovery      | `catalog.search` for one task   | every downstream tool definition (name, description, input schema), as a host would see by proxying them directly |
  | Schema         | `catalog.describe` for one tool | the same full tool list                                                                                           |
  | Planning       | default compact `action.plan`   | `action.plan` with `detail: "full"` (the pre-#27 default)                                                         |
  | Execution view | mediated `action.run` result    | the unredacted downstream result for the same call                                                                |

  The report also gives the median reduction across the baseline operations, and says whether it meets the 25% target.

- The fixture is deterministic and lives in the repository: a synthetic catalog of code-graph-shaped tools, plus a large downstream result. Runs are reproducible byte-for-byte, and the numbers reflect this fixture only.
- **`docs/BENCHMARKS.md`** covers:
  - the method;
  - what is and is not measured (bytes rather than host-specific tokens; one call per operation);
  - the current numbers;
  - a protocol and recording template for the manual two-host benchmark: hosts, tasks, metrics, and what would count as meeting each exit criterion.

## Non-goals

- Host token counts, completion rate, approval time and error recovery. These need real hosts and stay in the manual protocol.
- Any claim about grep-versus-graph or raw-HTML-versus-research savings. No research tool exists yet.

## Verification

- Two runs produce identical reports.
- Compact plans are smaller than full plans, and `describe` is smaller than the full tool list.
- The bounded `action.run` view is no larger than the configured limit plus its fixed summary fields.
- The JSON report matches a schema-like shape check.
- The CLI prints the table, or JSON with `--json`.
