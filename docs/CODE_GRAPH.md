# Proxying a code graph

An agent can query a code knowledge graph, such as [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), through ReproGate. Each query is then a planned, receipted action, and with [host mediation](CONFIGURATION.md#host-mediated-execution) a read-only query needs no per-call approval. ReproGate makes no claim here about token savings compared with other ways of exploring code.

## 1. Pin the backend

Print the digest of the graph server binary:

```sh
reprogate artifact digest /absolute/path/to/codebase-memory-mcp
```

Write a draft runtime configuration containing just the backend. The catalog can come later:

```json
{
  "backends": {
    "graph": {
      "transport": "stdio",
      "command": "/absolute/path/to/codebase-memory-mcp",
      "args": [],
      "environment": { "inherit": "safe", "from": {} },
      "artifact": {
        "path": "/absolute/path/to/codebase-memory-mcp",
        "digest": "sha256:<from the command above>"
      }
    }
  }
}
```

## 2. Import only read-only tools

```sh
reprogate catalog import --config /absolute/path/draft.json --backend graph \
  --effects local_read \
  --tools search_graph,trace_path,get_code_snippet,get_architecture,get_graph_schema,search_code,list_projects,index_status
```

Import connects to the backend under the same artifact check `serve` uses. It prints catalog entries on stdout, with each tool's live input schema copied exactly, so plans pass the schema pin. The effects are exactly what you declare; import never infers them and grants nothing. On stderr it prints each tool's schema digest and warnings:

- the downstream does not annotate the tool `readOnlyHint: true`. codebase-memory-mcp 0.9.0 annotates none of its tools, so this warning appears for every one of them.
- the downstream annotates the tool as destructive;
- the tool's name looks like it changes state. This is a name heuristic, so a status tool such as `index_status` can be flagged too.

Review each entry before pasting it into `catalog`. For codebase-memory-mcp:

| Import as `local_read`                                                                                                                   | Leave out                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `search_graph`, `trace_path`, `get_code_snippet`, `get_architecture`, `get_graph_schema`, `search_code`, `list_projects`, `index_status` | `index_repository` (writes the index), `delete_project`, `manage_adr` (writes decision records), `ingest_traces` |

`query_graph` runs a caller-written graph query, and `detect_changes` runs Git commands against a repository. Before declaring either one `local_read`, check that your server version cannot use them to change anything.

## 3. Mediate the queries

Complete the runtime configuration ([configuration guide](CONFIGURATION.md)) with the reviewed catalog entries, a policy that decides `local_read: allow`, and mediation:

```json
"mediation": {
  "effects": ["local_read"],
  "maxRunsPerPlan": 1,
  "result": { "maxTextBytes": 16384 }
}
```

An agent then calls `catalog.search` or `catalog.describe` to find a graph tool, `action.plan` with its arguments, and `action.run` with the returned `actionId`. Each query gets its own plan, so a run limit of 1 still allows any number of distinct queries.

## Notes

- **Observer roots:** every run takes a before-and-after manifest of the observer roots. Graph tools read their own index, not the workspace, so point `observer.roots` at a small directory, such as the database directory, rather than a large repository. For read-only tools, the manifests should not change.
- **One process per call:** each run starts the graph server and verifies its artifact digest first. codebase-memory-mcp also starts a file watcher and tries to open its visualization port on every launch. Turning that off with `codebase-memory-mcp --ui=false` changes the server's own saved configuration, so decide that as the operator.
- **Secrets and output:** the [mediation limits](CONFIGURATION.md#host-mediated-execution) apply. Results are redacted and bounded, but a mediated tool must not be able to read the gateway's secret material. Graph tools return source code from indexed repositories, so index only repositories whose content the agent may see.
- **Local smoke test (not run in CI):** the steps above were checked against codebase-memory-mcp 0.9.0. Import listed 14 tools, and a mediated `list_projects` run succeeded with a bounded result and a `host-mediated:` receipt.
