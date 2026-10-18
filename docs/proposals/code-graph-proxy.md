# Code graph proxy and catalog import: fourth Phase 4 slice

Status: proposed implementation. This proposal follows the Phase 4 roadmap item "downstream codebase knowledge graph integration". It builds on host mediation (#29), so read-only graph queries can run without an approval per call. It claims no measured token savings; the roadmap benchmark is a separate slice.

## Problem

ReproGate can already proxy any stdio MCP backend through its catalog. In practice, though, an operator who wants to expose a code graph server such as `codebase-memory-mcp` must hand-write one catalog entry per tool, with each tool's exact input schema. A schema copied by hand that differs from the live one makes every plan fail its schema pin. There is no documented, reviewed way to expose only the read-only tools.

## Deliverable

- **`reprogate catalog import`** is a host-side command:

  ```sh
  reprogate catalog import --config /abs/runtime.json --backend graph \
    --effects local_read --tools search_graph,trace_path,get_code_snippet
  ```

  - It reads only the named backend from the `backends` section of a draft runtime configuration, so the catalog may still be empty. It applies the same validation, artifact-digest check and environment rules as `serve`.
  - It connects to the backend, lists its tools, and prints catalog entries as JSON to stdout:
    - `toolRef` is `<backend>.<tool>`;
    - the live `inputSchema` is copied exactly;
    - `artifactDigest` is pinned;
    - `effects` are exactly what the operator declared.

    The command never infers effects.

  - `--tools` selects tools by name; a name the backend doesn't list is an error. `--filesystem-root` and `--scope` may be repeated and are copied into every entry.
  - Each entry's `schemaDigest` and any warnings go to stderr. A warning fires when:
    - the declared effects are all reads, but the downstream does not annotate the tool `readOnlyHint: true`;
    - the downstream annotates the tool as destructive;
    - the tool name looks like a write (delete, write, index, ingest, manage, set, create, update, run, exec).
  - Bounds: at most 128 tools, tool names `[A-Za-z0-9_.-]{1,128}`, descriptions cut to 2048 characters, and input schemas of at most 64 KiB each.
  - Import grants nothing. Its output is a proposal the operator reviews and pastes into the catalog.

- **`reprogate artifact digest <absolute-path>`** prints the `sha256:` digest that backend `artifact.digest` and catalog `artifactDigest` require.
- **`docs/CODE_GRAPH.md`** with an example runtime configuration, which:
  - proxies `codebase-memory-mcp` as a mediated `local_read` backend;
  - lists which of its tools to import (search, trace, snippet, architecture, schema, status) and which to leave out (indexing, deletion, ADR edits, trace ingestion);
  - explains the observer root choice and the redaction limits from host mediation.

## Non-goals

- Automatic catalog updates, or trusting downstream annotations as effect declarations.
- Writing into the runtime configuration file.
- Token benchmarks, or tool-description enforcement (the "two-strike" item).

## Verification

- Against the stdio test fixture: import produces entries whose schema digests equal the live tools' digests. Pasted into a runtime configuration with mediation, they let a real MCP client run `action.plan` then `action.run`.
- Refusals: an unknown backend, a tool the backend doesn't list, missing `--effects`, invalid effects, and a mismatched artifact digest.
- Warnings appear for a write-shaped name and for a missing read-only annotation.
- The `artifact digest` command matches `sha256File`.
- A local smoke test against an installed `codebase-memory-mcp` is described in the docs. It is not part of CI.
