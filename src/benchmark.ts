import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { ReproGateExecutor } from "./executor.js";
import { ReproGateKernel } from "./kernel.js";
import {
  DEFAULT_MAX_TEXT_BYTES,
  HostMediator,
  mediationConfigSchema,
} from "./mediation.js";
import { createReproGateServer } from "./server.js";
import type { CatalogTool, Digest, PolicyV1 } from "./types.js";

/** Bumped whenever the fixture changes, so reports name what they measured. */
export const FIXTURE_VERSION = 3;
const DIGEST: Digest = `sha256:${"0".repeat(64)}`;

// A synthetic code-graph-shaped catalog: deterministic, written for this
// harness, and not copied from any real server.
const FIXTURE_TOOLS: [string, string, Record<string, string>][] = [
  [
    "search_symbols",
    "Search indexed functions, classes and routes by name or text.",
    {
      query: "Full-text or name query.",
      kind: "Optional symbol kind filter.",
      path_glob: "Optional file path glob.",
    },
  ],
  [
    "trace_calls",
    "Trace callers and callees of one symbol up to a depth.",
    {
      symbol: "Qualified symbol name.",
      direction: "callers, callees or both.",
      depth: "Maximum hops to follow.",
    },
  ],
  [
    "read_symbol",
    "Return the source of one symbol with its location.",
    {
      symbol: "Qualified symbol name.",
      context_lines: "Lines of context around the symbol.",
    },
  ],
  [
    "describe_module",
    "Summarize one module's exports, imports and size.",
    { module: "Module path." },
  ],
  [
    "list_routes",
    "List HTTP routes with their handlers.",
    { method: "Optional HTTP method filter.", prefix: "Optional path prefix." },
  ],
  [
    "find_references",
    "Find every reference to a symbol.",
    {
      symbol: "Qualified symbol name.",
      include_tests: "Whether to include test files.",
    },
  ],
  [
    "dependency_graph",
    "Return module-level dependency edges.",
    {
      root: "Optional root module.",
      max_edges: "Upper bound on edges returned.",
    },
  ],
  [
    "hotspots",
    "Rank functions by fan-in, fan-out and size.",
    { limit: "Number of results.", metric: "fan_in, fan_out or size." },
  ],
  [
    "type_hierarchy",
    "Show base and derived types for one type.",
    { type: "Qualified type name." },
  ],
  [
    "recent_changes",
    "Map recent version-control changes to symbols.",
    { since: "Revision or date to compare against." },
  ],
  [
    "test_coverage_map",
    "Map tests to the symbols they exercise.",
    { symbol: "Optional symbol filter." },
  ],
  [
    "config_keys",
    "List configuration keys and where they are read.",
    { prefix: "Optional key prefix." },
  ],
  [
    "schema_entities",
    "List data model entities and relations.",
    { entity: "Optional entity name." },
  ],
  [
    "architecture_overview",
    "Summarize layers, packages and entry points.",
    { detail: "summary or full." },
  ],
];

/** The published fixture catalog, as the façade's operator would configure it. */
export function benchmarkCatalog(): CatalogTool[] {
  return FIXTURE_TOOLS.map(([toolName, description, fields]) => ({
    toolRef: `graph.${toolName}`,
    serverRef: "graph",
    toolName,
    description,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(fields).map(([name, text]) => [
          name,
          { type: "string", description: text },
        ]),
      ),
      required: Object.keys(fields).slice(0, 1),
    },
    effects: ["local_read"],
    artifactDigest: DIGEST,
  }));
}

// A small downstream result, where the façade's fixed fields dominate.
function smallResult() {
  return {
    content: [{ type: "text", text: "app.services.module0.handler0" }],
    structuredContent: { total: 1 },
  };
}

// A large downstream result: a code search returning many matches.
function downstreamResult() {
  const matches = Array.from({ length: 120 }, (_, index) => ({
    symbol: `app.services.module${String(index % 12)}.handler${String(index)}`,
    file: `src/services/module${String(index % 12)}/handler${String(index)}.ts`,
    line: 10 + index,
    snippet: `export async function handler${String(index)}(request: Request): Promise<Response> { return respond(request); }`,
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({ matches }) }],
    structuredContent: { total: matches.length, matches },
  };
}

const policy: PolicyV1 = {
  version: 1,
  defaults: {
    local_read: "allow",
    local_write: "approval_required",
    process_exec: "approval_required",
    network_read: "approval_required",
    network_write: "deny",
    credential_use: "deny",
    destructive: "deny",
  },
  rules: [],
};

export interface ToolResultMeasurement {
  name: string;
  measured: string;
  baseline: string;
  measuredBytes: number;
  baselineBytes: number;
  reduction: number;
  /** True when the façade cut the downstream text to its byte limit. */
  truncated: boolean;
}

export interface BenchmarkReport {
  fixtureVersion: number;
  fixtureTools: number;
  unit: "utf8-bytes";
  /** Definitions a host loads, and the calls a task spends finding a tool. */
  context: {
    facadeToolListBytes: number;
    directToolListBytes: number;
    discoveryCallsBytes: number;
    averageDownstreamToolBytes: number;
    breakEvenCatalogTools: number;
  };
  /** Tool results only; the median is a fixture check, not an exit result. */
  toolResults: ToolResultMeasurement[];
  medianToolResultReduction: number;
}

// Everything a host receives for one tool call: text and structured content.
function visibleBytes(result: unknown): number {
  const { content, structuredContent, isError } = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  return Buffer.byteLength(
    JSON.stringify({ content, structuredContent, isError }),
  );
}

// A failed call would look like a large "reduction"; refuse to measure it.
export function succeeded(
  name: string,
  result: unknown,
): Record<string, unknown> {
  const { isError, structuredContent } = result as {
    isError?: unknown;
    structuredContent?: unknown;
  };
  if (
    isError === true ||
    structuredContent === null ||
    typeof structuredContent !== "object"
  )
    throw new Error(`Benchmark call ${name} did not succeed`);
  return structuredContent as Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Measure agent-visible sizes for fixed operations through a real MCP
 * client. Execution is simulated: downstream results are fixtures and no
 * process is spawned, so only the façade's own output is measured.
 */
export async function runFacadeBenchmark(): Promise<BenchmarkReport> {
  const catalog = benchmarkCatalog();
  const kernel = new ReproGateKernel(catalog, policy);
  const results: Record<string, unknown> = {
    "graph.search_symbols": downstreamResult(),
    "graph.list_routes": smallResult(),
  };
  const executor = {
    store: {
      get: (actionId: string) => kernel.explain(actionId),
      countCapabilityUses: () => 0,
    },
    execute: ({ actionId }: { actionId: string }) => {
      const plan = kernel.explain(actionId);
      const toolRef = `graph.${plan?.envelope.tool.toolName ?? ""}`;
      return Promise.resolve({
        receipt: {
          executionId: "00000000-0000-4000-8000-000000000000",
          actionId,
          outcome: "succeeded",
          receiptDigest: DIGEST,
          resultDigest: DIGEST,
        },
        downstreamResult: results[toolRef],
      });
    },
  } as unknown as ReproGateExecutor;
  // The mediation default, so the bound is what an operator gets unless
  // they choose otherwise.
  const mediator = new HostMediator(
    executor,
    kernel,
    mediationConfigSchema.parse({ effects: ["local_read"] }),
    "benchmark-capability-secret-not-used-0123456789",
    "benchmark-receipt-secret-not-used-0123456789ab",
  );
  const server = createReproGateServer(kernel, executor, undefined, mediator);
  const client = new Client({ name: "reprogate-bench", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });

    // Context: what a host loads up front, and what finding a tool costs.
    const facadeToolListBytes = Buffer.byteLength(
      JSON.stringify(await client.listTools()),
    );
    const directTools = catalog.map(
      ({ toolName, description, inputSchema }) => ({
        name: toolName,
        description,
        inputSchema,
      }),
    );
    const directToolListBytes = Buffer.byteLength(
      JSON.stringify({ tools: directTools }),
    );
    const searched = await call("catalog.search", {
      query: "symbol",
      limit: 3,
    });
    const hits = succeeded("catalog.search", searched).tools;
    if (!Array.isArray(hits) || hits.length !== 3)
      throw new Error("Benchmark search must return three tools");
    const described = await call("catalog.describe", {
      toolRef: "graph.find_references",
    });
    succeeded("catalog.describe", described);
    const discoveryCallsBytes =
      visibleBytes(searched) + visibleBytes(described);
    const averageDownstreamToolBytes = Math.round(
      directToolListBytes / catalog.length,
    );

    const measure = async (
      name: string,
      toolRef: string,
      args: Record<string, unknown>,
    ): Promise<ToolResultMeasurement> => {
      const compact = await call("action.plan", { toolRef, arguments: args });
      const actionId = succeeded("action.plan", compact).actionId;
      if (typeof actionId !== "string")
        throw new Error("Benchmark plan returned no actionId");
      if (name === "planning") {
        const full = await call("action.plan", {
          toolRef,
          arguments: args,
          detail: "full",
        });
        succeeded("action.plan full", full);
        const measuredBytes = visibleBytes(compact);
        const baselineBytes = visibleBytes(full);
        return {
          name,
          measured: "action.plan (compact default)",
          baseline: 'action.plan detail: "full"',
          measuredBytes,
          baselineBytes,
          reduction: round(1 - measuredBytes / baselineBytes),
          truncated: false,
        };
      }
      const run = await call("action.run", { actionId, arguments: args });
      const view = succeeded("action.run", run);
      const measuredBytes = visibleBytes(run);
      const baselineBytes = visibleBytes(results[toolRef]);
      return {
        name,
        measured: `action.run (default maxTextBytes ${String(DEFAULT_MAX_TEXT_BYTES)})`,
        baseline: "unredacted downstream result",
        measuredBytes,
        baselineBytes,
        reduction: round(1 - measuredBytes / baselineBytes),
        truncated: view.truncated === true,
      };
    };
    const toolResults = [
      await measure("planning", "graph.search_symbols", { query: "handler" }),
      await measure("execution, large result", "graph.search_symbols", {
        query: "handler",
      }),
      await measure("execution, small result", "graph.list_routes", {
        prefix: "/api",
      }),
    ];
    return {
      fixtureVersion: FIXTURE_VERSION,
      fixtureTools: catalog.length,
      unit: "utf8-bytes",
      context: {
        facadeToolListBytes,
        directToolListBytes,
        discoveryCallsBytes,
        averageDownstreamToolBytes,
        // Catalog size at which loading every downstream definition costs
        // more than the façade's own tools plus one search and describe.
        breakEvenCatalogTools: Math.ceil(
          (facadeToolListBytes + discoveryCallsBytes) /
            averageDownstreamToolBytes,
        ),
      },
      toolResults,
      medianToolResultReduction: round(
        median(toolResults.map((item) => item.reduction)),
      ),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** A fixed-width text table for terminals. */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const { context } = report;
  const rows = report.toolResults.map((item) => [
    item.name,
    String(item.measuredBytes),
    String(item.baselineBytes),
    percent(item.reduction),
    item.truncated ? "yes" : "no",
  ]);
  const header = [
    "tool result",
    "measured B",
    "baseline B",
    "reduction",
    "truncated",
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  return [
    `Façade measurement, fixture v${String(report.fixtureVersion)} (${String(report.fixtureTools)} tools), UTF-8 bytes`,
    `context: façade tool list ${String(context.facadeToolListBytes)} B vs direct tool list ${String(context.directToolListBytes)} B; finding a tool costs ${String(context.discoveryCallsBytes)} B; break-even at ${String(context.breakEvenCatalogTools)} downstream tools`,
    line(header),
    ...rows.map(line),
    `median tool-result reduction ${percent(report.medianToolResultReduction)} (fixture check, not an exit-criterion result)`,
    "Bytes, not host tokens; execution is simulated; truncation hides content. See docs/BENCHMARKS.md.",
    "",
  ].join("\n");
}
