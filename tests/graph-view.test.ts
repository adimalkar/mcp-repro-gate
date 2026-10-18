import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { demoPolicy } from "../src/demo-config.js";
import { digestCanonical } from "../src/digest.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import { ReproGateExecutor } from "../src/executor.js";
import { actionRunOutputSchema } from "../src/facade.js";
import { graphJson, MAX_GRAPH_VIEW_CHARS } from "../src/graph-view.js";
import { ReproGateKernel } from "../src/kernel.js";
import { HostMediator, mediationConfigSchema } from "../src/mediation.js";
import { verifyExecutionReceipt } from "../src/receipt.js";
import { createReproGateServer } from "../src/server.js";
import type { CatalogTool } from "../src/types.js";

const capabilitySecret = "graph-capability-secret-at-least-32-bytes";
const receiptSecret = "graph-receipt-secret-different-at-least-32-bytes";
const row = {
  name: "example",
  qualified_name: "project.src.example",
  label: "Function",
  file_path: "src/example.ts",
  lines: 3,
  fp: "diagnostic-fingerprint",
  bt: "diagnostic token stream",
  recursion_in_loop: false,
  unguarded_recursion: false,
};
const search = {
  total: 7,
  has_more: true,
  results: [row, { ...row, name: "next" }],
};
const snippet = {
  ...row,
  start_line: 2,
  end_line: 4,
  source: "function example() {\n  return 'é😀';\n}",
  callers: 1,
};

function reply(payload: unknown, mirror = true) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(mirror ? { structuredContent: payload } : {}),
    isError: false,
  };
}

function mediator(maxTextBytes = 65536, redactPatterns: string[] = []) {
  return new HostMediator(
    {} as ReproGateExecutor,
    new ReproGateKernel([], demoPolicy),
    mediationConfigSchema.parse({
      effects: ["local_read"],
      result: { maxTextBytes, redactPatterns },
    }),
    capabilitySecret,
    receiptSecret,
  );
}

test("graph views retain all rows, pagination, locations and complete source", () => {
  const host = mediator();
  const original = reply(search);
  const before = structuredClone(original);
  for (const mirror of [true, false]) {
    const bounded = host.bound(reply(search, mirror), "search");
    assert.deepEqual(JSON.parse(bounded.content[0]?.text ?? ""), {
      view: "graph_search_v1",
      total: 7,
      has_more: true,
      results: search.results.map(
        ({ name, qualified_name, label, file_path, lines }) => ({
          name,
          qualified_name,
          label,
          file_path,
          lines,
        }),
      ),
    });
    const source = host.bound(reply(snippet, mirror), "snippet");
    assert.deepEqual(JSON.parse(source.content[0]?.text ?? ""), {
      view: "graph_snippet_v1",
      name: row.name,
      qualified_name: row.qualified_name,
      label: row.label,
      file_path: row.file_path,
      start_line: 2,
      end_line: 4,
      source: snippet.source,
    });
    assert.equal(source.truncated, false);
    assert.equal(source.redactions, 0);
    assert.equal(source.omittedItems, 0);
  }
  host.bound(original, "search");
  assert.deepEqual(original, before);
  // No profile: the existing mirror-deduplicated view is unchanged.
  assert.equal(
    host.bound(original).content[0]?.text ?? "",
    JSON.stringify(search),
  );
  assert.deepEqual(
    JSON.parse(
      host.bound(reply({ total: 0, has_more: false, results: [] }), "search")
        .content[0]?.text ?? "",
    ),
    { view: "graph_search_v1", total: 0, has_more: false, results: [] },
  );
});

test("graph projection falls back without hiding errors, warnings or extra channels", () => {
  const host = mediator();
  const original = reply(search);
  const unsupported: unknown[] = [
    { ...original, isError: true },
    { ...original, isError: "false" },
    { ...original, _meta: { warning: "notice" } },
    {
      ...original,
      content: [...original.content, { type: "text", text: "notice" }],
    },
    {
      ...original,
      content: [...original.content, { type: "image", data: "AAAA" }],
    },
    {
      ...original,
      content: [
        { ...original.content[0], annotations: { audience: ["user"] } },
      ],
    },
    { ...original, content: [{ type: "text", text: "{bad json" }] },
    { ...original, structuredContent: { ...search, total: 8 } },
    reply({ ...search, warning: "new field" }),
    reply({ ...search, semantic_results: [{ answer: "new channel" }] }),
    reply({ ...search, results: [{ ...row, warning: "new row field" }] }),
    reply({ ...search, total: 0 }),
    reply({ ...search, has_more: "true" }),
    reply({ ...search, results: [{ ...row, file_path: "" }] }),
    reply({
      ...search,
      results: Array.from({ length: 201 }, () => row),
      total: 201,
    }),
    reply({
      ...search,
      results: [{ ...row, bt: "x".repeat(MAX_GRAPH_VIEW_CHARS) }],
    }),
  ];
  for (const input of unsupported)
    assert.deepEqual(
      host.bound(input, "search"),
      host.bound(input),
      JSON.stringify(input).slice(0, 250),
    );
  for (const input of [
    reply({ ...snippet, end_line: 1 }),
    reply({ ...snippet, source: "" }),
    reply({ ...snippet, callers: ["new callers shape"] }),
    reply({ ...snippet, warning: "notice" }),
    reply(search),
  ])
    assert.deepEqual(host.bound(input, "snippet"), host.bound(input));
});

test("graph views preserve redactions in removed diagnostics and across fields", () => {
  for (const secret of [capabilitySecret, receiptSecret, "rg1.echo.token"]) {
    const host = mediator();
    const input = reply({ ...search, results: [{ ...row, bt: secret }] });
    const actual = host.bound(input, "search");
    assert.deepEqual(actual, host.bound(input));
    assert.ok(actual.redactions > 0);
    assert.equal(
      actual.content
        .map((item) => item.text)
        .join("")
        .includes(secret),
      false,
    );
  }
  const host = mediator(65536, ["BEGIN[\\s\\S]*?END"]);
  const input = reply({
    ...search,
    results: [{ ...row, fp: "BEGIN", bt: "private END" }],
  });
  const actual = host.bound(input, "search");
  assert.deepEqual(actual, host.bound(input));
  assert.equal(actual.redactions, 2);
  assert.equal(
    actual.content
      .map((item) => item.text)
      .join("")
      .includes("private END"),
    false,
  );
  // Projection introduces a marker; the resulting text still gets redacted.
  const marker = mediator(65536, ["graph_search_v1"]).bound(
    reply(search),
    "search",
  );
  assert.equal(marker.redactions, 1);
  assert.ok((marker.content[0]?.text ?? "").includes("[REDACTED]"));
});

test("projected views obey the UTF-8 byte bound and report truncation", () => {
  const input = reply({ ...snippet, source: "é😀".repeat(100) });
  const actual = mediator(256).bound(input, "snippet");
  assert.equal(actual.truncated, true);
  assert.equal(actual.content.length, 1);
  assert.ok(
    (actual.content[0]?.text ?? "").startsWith('{"view":"graph_snippet_v1"'),
  );
  assert.ok(Buffer.byteLength(actual.content[0]?.text ?? "") <= 256);
  assert.equal((actual.content[0]?.text ?? "").includes("�"), false);
});

test("structured mirror processing stops within a conservative character budget", () => {
  assert.equal(graphJson({ x: "small" }, 1000), '{"x":"small"}');
  assert.equal(
    graphJson({ x: "x".repeat(MAX_GRAPH_VIEW_CHARS) }, MAX_GRAPH_VIEW_CHARS),
    undefined,
  );
  assert.equal(
    graphJson(
      Array.from({ length: 10000 }, () => 0),
      MAX_GRAPH_VIEW_CHARS,
    ),
    undefined,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(graphJson(circular, MAX_GRAPH_VIEW_CHARS), undefined);
  const host = mediator();
  const input = {
    ...reply(search),
    structuredContent: { x: "x".repeat(MAX_GRAPH_VIEW_CHARS) },
  };
  assert.deepEqual(host.bound(input, "search"), host.bound(input));
});

test("graph profile configuration rejects ambiguous identities and unknown options", () => {
  const entry = {
    serverRef: "graph",
    toolName: "search_graph",
    view: "search",
  };
  const parse = (graphViews: unknown) =>
    mediationConfigSchema.safeParse({
      effects: ["local_read"],
      result: { graphViews },
    }).success;
  assert.equal(parse([entry]), true);
  assert.equal(parse([]), true);
  for (const invalid of [
    [entry, entry],
    [entry, { ...entry, view: "snippet" }],
    [{ ...entry, view: "automatic" }],
    [{ ...entry, serverRef: "" }],
    [{ ...entry, toolName: "x".repeat(257) }],
    [{ ...entry, unknown: true }],
    Array.from({ length: 65 }, (_, index) => ({
      ...entry,
      toolName: String(index),
    })),
  ])
    assert.equal(parse(invalid), false);
});

test("real MCP action.run selects exact identities and signs original results", async () => {
  const store = new SqliteExecutionStore(":memory:");
  const inputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const catalog: CatalogTool[] = [
    ["graph", "search_graph"],
    ["other-graph", "search_graph"],
    ["graph", "prefixed_search_graph"],
  ].map(([serverRef, toolName], index) => ({
    toolRef: "graph.test." + String(index),
    serverRef: serverRef ?? "",
    toolName: toolName ?? "",
    description: "Graph integration fixture",
    inputSchema,
    effects: ["local_read"],
  }));
  const kernel = new ReproGateKernel(catalog, demoPolicy, store);
  const original = reply(search);
  const immutableCopy = structuredClone(original);
  const executor = new ReproGateExecutor(
    store,
    {
      connect() {
        return Promise.resolve({
          getTool(name) {
            return Promise.resolve({ name, inputSchema });
          },
          callTool() {
            return Promise.resolve(original);
          },
          close() {
            return Promise.resolve();
          },
        });
      },
    },
    {
      snapshot() {
        return Promise.resolve({});
      },
    },
    capabilitySecret,
    receiptSecret,
    "graph-key",
  );
  const config = mediationConfigSchema.parse({
    effects: ["local_read"],
    result: {
      graphViews: [
        { serverRef: "graph", toolName: "search_graph", view: "search" },
      ],
    },
  });
  const host = new HostMediator(
    executor,
    kernel,
    config,
    capabilitySecret,
    receiptSecret,
  );
  // Mutating a caller's config cannot alter the snapshotted selector map.
  const configuredView = config.result?.graphViews?.[0];
  assert.ok(configuredView);
  configuredView.serverRef = "other-graph";
  const server = createReproGateServer(kernel, executor, undefined, host);
  const client = new Client({ name: "graph-view-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (let index = 0; index < catalog.length; index++) {
      const plan = kernel.plan({
        toolRef: catalog[index]?.toolRef ?? "",
        arguments: {},
      });
      const response = await client.callTool({
        name: "action.run",
        arguments: { actionId: plan.envelope.actionId, arguments: {} },
      });
      assert.notEqual(response.isError, true);
      const summary = actionRunOutputSchema.parse(response.structuredContent);
      assert.equal(summary.resultDigest, digestCanonical(original));
      const execution = store.getExecution(summary.executionId);
      assert.ok(execution?.receipt);
      assert.ok(verifyExecutionReceipt(execution.receipt, receiptSecret));
      assert.equal(execution.receipt.resultDigest, digestCanonical(original));
      assert.equal(execution.receipt.receiptDigest, summary.receiptDigest);
      assert.equal(
        (summary.content[0]?.text ?? "").includes("graph_search_v1"),
        index === 0,
      );
      if (index === 0)
        assert.notEqual(digestCanonical(summary.content), summary.resultDigest);
      else assert.equal(summary.content[0]?.text ?? "", JSON.stringify(search));
    }
    assert.deepEqual(original, immutableCopy);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
