import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_VERSION,
  benchmarkCatalog,
  formatBenchmarkReport,
  runFacadeBenchmark,
  succeeded,
} from "../src/benchmark.js";

test("the façade measurement is deterministic and reports costs as well as savings", async () => {
  const first = await runFacadeBenchmark();
  const second = await runFacadeBenchmark();
  assert.deepEqual(first, second);
  assert.equal(first.fixtureVersion, FIXTURE_VERSION);
  assert.equal(first.fixtureTools, benchmarkCatalog().length);

  const { context } = first;
  assert.ok(context.facadeToolListBytes > 0);
  assert.ok(context.discoveryCallsBytes > 0);
  assert.equal(
    context.averageDownstreamToolBytes,
    Math.round(context.directToolListBytes / first.fixtureTools),
  );
  assert.equal(
    context.breakEvenCatalogTools,
    Math.ceil(
      (context.facadeToolListBytes + context.discoveryCallsBytes) /
        context.averageDownstreamToolBytes,
    ),
  );

  assert.deepEqual(
    first.toolResults.map((item) => [item.name, item.truncated]),
    [
      ["planning", false],
      ["execution, large result", true],
      ["execution, small result", false],
    ],
  );
  for (const item of first.toolResults)
    assert.equal(
      item.reduction,
      Math.round((1 - item.measuredBytes / item.baselineBytes) * 10_000) /
        10_000,
      item.name,
    );
  const [planning, large, small] = first.toolResults;
  assert.ok((planning?.reduction ?? 0) > 0);
  assert.ok((large?.reduction ?? 0) > 0);
  // The façade's fixed fields outweigh a tiny result; this must stay visible.
  assert.ok((small?.reduction ?? 0) < 0);
  const sorted = first.toolResults
    .map((item) => item.reduction)
    .sort((a, b) => a - b);
  assert.equal(first.medianToolResultReduction, sorted[1]);

  const table = formatBenchmarkReport(first);
  for (const item of first.toolResults) assert.ok(table.includes(item.name));
  assert.match(table, /not an exit-criterion result/u);
  assert.match(table, /break-even at \d+ downstream tools/u);
});

test("a failed or empty call is refused rather than measured", () => {
  assert.throws(
    () => succeeded("x", { isError: true, content: [] }),
    /did not succeed/u,
  );
  assert.throws(() => succeeded("x", { content: [] }), /did not succeed/u);
  assert.deepEqual(succeeded("x", { structuredContent: { ok: 1 } }), { ok: 1 });
});

test("the CLI prints the same report as JSON and rejects other arguments", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const json = spawnSync(process.execPath, [cli, "bench", "facade", "--json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), await runFacadeBenchmark());
  const table = spawnSync(process.execPath, [cli, "bench", "facade"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /median tool-result reduction/u);
  const bad = spawnSync(process.execPath, [cli, "bench", "facade", "--csv"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Usage: reprogate bench facade/u);
});

test("published benchmark numbers match the harness", async () => {
  const report = await runFacadeBenchmark();
  const docs = readFileSync(
    fileURLToPath(new URL("../../docs/BENCHMARKS.md", import.meta.url)),
    "utf8",
  );
  const rows = docs
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const row = (name: string) => {
    const cells = rows.find((cells) => cells[0] === "" && cells[1] === name);
    assert.ok(cells, name);
    return cells;
  };
  for (const item of report.toolResults) {
    const cells = row(item.name);
    assert.equal(cells.at(-5), String(item.measuredBytes), item.name);
    assert.equal(cells.at(-4), String(item.baselineBytes), item.name);
    assert.equal(
      cells.at(-3),
      `${(item.reduction * 100).toFixed(1)}%`,
      item.name,
    );
    assert.equal(cells.at(-2), item.truncated ? "yes" : "no", item.name);
  }
  const { context } = report;
  for (const [name, value] of [
    ["façade tool list", context.facadeToolListBytes],
    ["direct tool list", context.directToolListBytes],
    ["finding a tool (search + describe)", context.discoveryCallsBytes],
    ["average downstream tool definition", context.averageDownstreamToolBytes],
    ["break-even catalog size (tools)", context.breakEvenCatalogTools],
  ] as const)
    assert.equal(row(name).at(-2), String(value), name);
  assert.ok(
    docs.includes(
      `Median tool-result reduction on this fixture: ${(report.medianToolResultReduction * 100).toFixed(1)}%.`,
    ),
  );
});
