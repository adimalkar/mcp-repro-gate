import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { ReproGateExecutor } from "./executor.js";
import { ReproGateKernel } from "./kernel.js";
import { HostMediator, mediationConfigSchema } from "./mediation.js";
import { createReproGateServer } from "./server.js";
import type { CatalogTool, Digest, PolicyV1 } from "./types.js";

/** Bumped whenever the fixture changes, so reports name what they measured. */
export const FIXTURE_VERSION = 1;
export const TARGET_MEDIAN_REDUCTION = 0.25;
const MAX_TEXT_BYTES = 4096;
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

export interface BenchmarkOperation {
  name: string;
  measured: string;
  baseline: string;
  measuredBytes: number;
  baselineBytes: number;
  reduction: number;
}

export interface BenchmarkReport {
  fixtureVersion: number;
  fixtureTools: number;
  unit: "utf8-bytes";
  operations: BenchmarkOperation[];
  medianReduction: number;
  target: number;
  meetsTarget: boolean;
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
 * Measure agent-visible result sizes for fixed operations through a real
 * MCP client. Execution is simulated: the downstream result is a fixture and
 * no process is spawned, so only the façade's own output is measured.
 */
export async function runFacadeBenchmark(): Promise<BenchmarkReport> {
  const catalog = benchmarkCatalog();
  const kernel = new ReproGateKernel(catalog, policy);
  const raw = downstreamResult();
  const executor = {
    store: {
      get: (actionId: string) => kernel.explain(actionId),
      countCapabilityUses: () => 0,
    },
    execute: ({ actionId }: { actionId: string }) =>
      Promise.resolve({
        receipt: {
          executionId: "00000000-0000-4000-8000-000000000000",
          actionId,
          outcome: "succeeded",
          receiptDigest: DIGEST,
          resultDigest: DIGEST,
        },
        downstreamResult: raw,
      }),
  } as unknown as ReproGateExecutor;
  const mediator = new HostMediator(
    executor,
    kernel,
    mediationConfigSchema.parse({
      effects: ["local_read"],
      result: { maxTextBytes: MAX_TEXT_BYTES },
    }),
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

    const allDefinitions = Buffer.byteLength(
      JSON.stringify(
        catalog.map(({ toolName, description, inputSchema }) => ({
          name: toolName,
          description,
          inputSchema,
        })),
      ),
    );
    const searched = visibleBytes(
      await call("catalog.search", { query: "trace callers", limit: 3 }),
    );
    const described = visibleBytes(
      await call("catalog.describe", { toolRef: "graph.trace_calls" }),
    );
    const planArgs = {
      toolRef: "graph.search_symbols",
      arguments: { query: "handler" },
    };
    const compact = await call("action.plan", planArgs);
    const full = visibleBytes(
      await call("action.plan", { ...planArgs, detail: "full" }),
    );
    const actionId = (compact.structuredContent as { actionId: string })
      .actionId;
    const run = visibleBytes(
      await call("action.run", {
        actionId,
        arguments: { query: "handler" },
      }),
    );

    const operation = (
      name: string,
      measured: string,
      baseline: string,
      measuredBytes: number,
      baselineBytes: number,
    ): BenchmarkOperation => ({
      name,
      measured,
      baseline,
      measuredBytes,
      baselineBytes,
      reduction: round(1 - measuredBytes / baselineBytes),
    });
    const operations = [
      operation(
        "discovery",
        "catalog.search (limit 3)",
        "all downstream tool definitions",
        searched,
        allDefinitions,
      ),
      operation(
        "schema",
        "catalog.describe (one tool)",
        "all downstream tool definitions",
        described,
        allDefinitions,
      ),
      operation(
        "planning",
        "action.plan (compact default)",
        'action.plan detail: "full"',
        visibleBytes(compact),
        full,
      ),
      operation(
        "execution view",
        `action.run (maxTextBytes ${String(MAX_TEXT_BYTES)})`,
        "unredacted downstream result",
        run,
        visibleBytes(raw),
      ),
    ];
    const medianReduction = round(
      median(operations.map((item) => item.reduction)),
    );
    return {
      fixtureVersion: FIXTURE_VERSION,
      fixtureTools: catalog.length,
      unit: "utf8-bytes",
      operations,
      medianReduction,
      target: TARGET_MEDIAN_REDUCTION,
      meetsTarget: medianReduction >= TARGET_MEDIAN_REDUCTION,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** A fixed-width text table for terminals. */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const rows = report.operations.map((item) => [
    item.name,
    String(item.measuredBytes),
    String(item.baselineBytes),
    `${(item.reduction * 100).toFixed(1)}%`,
  ]);
  const header = ["operation", "measured B", "baseline B", "reduction"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  return [
    `Façade measurement, fixture v${String(report.fixtureVersion)} (${String(report.fixtureTools)} tools), UTF-8 bytes of agent-visible results`,
    line(header),
    ...rows.map(line),
    `median reduction ${(report.medianReduction * 100).toFixed(1)}% (target ${(report.target * 100).toFixed(0)}%: ${report.meetsTarget ? "met" : "not met"} on this fixture)`,
    "Bytes, not host tokens; execution is simulated. See docs/BENCHMARKS.md.",
    "",
  ].join("\n");
}
