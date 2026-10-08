import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_VERSION,
  TARGET_MEDIAN_REDUCTION,
  benchmarkCatalog,
  formatBenchmarkReport,
  runFacadeBenchmark,
} from "../src/benchmark.js";

test("the façade benchmark is deterministic and every operation shrinks", async () => {
  const first = await runFacadeBenchmark();
  const second = await runFacadeBenchmark();
  assert.deepEqual(first, second);
  assert.equal(first.fixtureVersion, FIXTURE_VERSION);
  assert.equal(first.fixtureTools, benchmarkCatalog().length);
  assert.deepEqual(
    first.operations.map((item) => item.name),
    ["discovery", "schema", "planning", "execution view"],
  );
  for (const item of first.operations) {
    assert.ok(item.measuredBytes > 0, item.name);
    assert.ok(item.measuredBytes < item.baselineBytes, item.name);
    assert.equal(
      item.reduction,
      Math.round((1 - item.measuredBytes / item.baselineBytes) * 10_000) /
        10_000,
      item.name,
    );
  }
  const execution = first.operations.find(
    (item) => item.name === "execution view",
  );
  // Text and structured content each carry the bounded view once.
  assert.ok((execution?.measuredBytes ?? Infinity) < 3 * 4096);
  const reductions = first.operations
    .map((item) => item.reduction)
    .sort((a, b) => a - b);
  assert.equal(
    first.medianReduction,
    Math.round((((reductions[1] ?? 0) + (reductions[2] ?? 0)) / 2) * 10_000) /
      10_000,
  );
  assert.equal(first.target, TARGET_MEDIAN_REDUCTION);
  assert.equal(first.meetsTarget, first.medianReduction >= first.target);
  const table = formatBenchmarkReport(first);
  for (const item of first.operations) assert.ok(table.includes(item.name));
  assert.match(table, /Bytes, not host tokens/u);
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
  assert.match(table.stdout, /median reduction/u);
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
  for (const item of report.operations) {
    // Table cells are padded by the formatter; compare trimmed cells.
    const cells = docs
      .split("\n")
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .find((row) => row[0] === "" && row[1] === item.name);
    assert.ok(cells, item.name);
    assert.equal(cells.at(-4), String(item.measuredBytes), item.name);
    assert.equal(cells.at(-3), String(item.baselineBytes), item.name);
    assert.equal(
      cells.at(-2),
      `${(item.reduction * 100).toFixed(1)}%`,
      item.name,
    );
  }
  assert.ok(
    docs.includes(
      `Median reduction: ${(report.medianReduction * 100).toFixed(1)}% on this fixture.`,
    ),
  );
});
