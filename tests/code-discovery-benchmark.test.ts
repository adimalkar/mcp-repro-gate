import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod/v4";

import {
  checkedHit,
  checkCorpus,
  checkedSnippet,
  matchedFiles,
  measurement,
  SOURCE_REVISION,
  TASKS,
  toolPayload,
} from "../benchmarks/code-discovery.js";

const task = TASKS[1];
function result(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

test("discovery measurement counts complete mirrors, metadata and UTF-8 reads", () => {
  const response = {
    ...result({ source: "λ" }),
    structuredContent: { source: "λ" },
    _meta: { evidence: "untrimmed" },
  };
  const measured = measurement([
    { request: { name: "read", arguments: {} }, response },
    { request: "read source", response: "λ\n" },
  ]);
  assert.equal(measured.calls, 2);
  assert.equal(
    measured.responseBytes,
    Buffer.byteLength(JSON.stringify(response)) + 3,
  );
  assert.equal(
    measured.requestBytes,
    Buffer.byteLength(JSON.stringify({ name: "read", arguments: {} })) + 11,
  );
});

test("graph errors cannot masquerade as small successful outputs", () => {
  assert.throws(() => toolPayload({ ...result({ total: 0 }), isError: true }));
  assert.throws(() => toolPayload(result({ error: "index unavailable" })));
  assert.throws(() => toolPayload(result({ truncated: true })));
  assert.throws(() => toolPayload(result(null)));
  assert.throws(() =>
    toolPayload({ content: [{ type: "text", text: "not JSON" }] }),
  );
  assert.deepEqual(
    toolPayload({ ...result("ignored"), structuredContent: { total: 1 } }),
    { total: 1 },
  );
});

test("source provenance check refuses changed, missing or extra corpus files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "discovery-source-"));
  const source = "pinned source\n";
  const file = "src/example.ts";
  const manifest = [
    {
      file,
      digest: "sha256:" + createHash("sha256").update(source).digest("hex"),
    },
  ];
  try {
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, file), source);
    checkCorpus(scratch, manifest);
    writeFileSync(join(scratch, file), "modified source\n");
    assert.throws(() => {
      checkCorpus(scratch, manifest);
    });
    writeFileSync(join(scratch, file), source);
    writeFileSync(join(scratch, "src", "extra.ts"), source);
    assert.throws(() => {
      checkCorpus(scratch, manifest);
    });
    rmSync(join(scratch, "src", "extra.ts"));
    rmSync(join(scratch, file));
    assert.throws(() => {
      checkCorpus(scratch, manifest);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("symbol lookup refuses ambiguous, paginated, missing and wrong locations", () => {
  const hit = {
    name: task.symbol,
    file_path: task.file,
    qualified_name: "fixture.policy.evaluatePolicy",
  };
  const payload = { total: 1, has_more: false, results: [hit] };
  assert.equal(checkedHit(result(payload), task), hit.qualified_name);
  for (const invalid of [
    { ...payload, total: 2, results: [hit, hit] },
    { ...payload, has_more: true },
    { ...payload, results: [] },
    { ...payload, results: [{ ...hit, file_path: "src/wrong.ts" }] },
    { ...payload, results: [{ ...hit, name: "different" }] },
  ])
    assert.throws(() => checkedHit(result(invalid), task));
});

test("implementation check rejects stale, shortened, misplaced and answerless snippets", () => {
  const scratch = mkdtempSync(join(tmpdir(), "discovery-test-"));
  const source =
    "export function evaluatePolicy() {\n  return " + task.answer + ";\n}\n";
  const payload = {
    name: task.symbol,
    file_path: join(scratch, task.file),
    start_line: 2,
    end_line: 4,
    source,
  };
  try {
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, task.file), "// pinned file\n" + source);
    checkedSnippet(result(payload), task, scratch);
    for (const invalid of [
      { ...payload, source: source.replace("return", "throw") },
      { ...payload, source: source.slice(0, -3) },
      { ...payload, file_path: join(scratch, "src", "wrong.ts") },
      { ...payload, start_line: 1 },
      { ...payload, end_line: 50 },
      { ...payload, source: "export function evaluatePolicy() {}\n" },
      { ...payload, truncated: true },
    ])
      assert.throws(() => {
        checkedSnippet(result(invalid), task, scratch);
      });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("grep baseline reads each matched file once and refuses missing or unsafe output", () => {
  assert.deepEqual(
    matchedFiles(
      "src/policy.ts:44:export function evaluatePolicy(\n" +
        "src/kernel.ts:3:import { evaluatePolicy } from './policy.js';\n" +
        "src/policy.ts:45:// evaluatePolicy\n",
      task,
    ),
    ["src/kernel.ts", task.file],
  );
  for (const invalid of [
    "",
    "src/kernel.ts:3:evaluatePolicy\n",
    "src/../policy.ts:44:evaluatePolicy\n",
    "src/policy.ts:44:evaluatePolicy\ntruncated",
    "src/policy.ts:44:differentSymbol",
    "src/policy.ts:0:evaluatePolicy",
  ])
    assert.throws(() => matchedFiles(invalid, task));
});

test("published discovery report replays source, answer and byte checks without the server", () => {
  const exchange = z.object({ request: z.unknown(), response: z.unknown() });
  const metric = z.object({
    calls: z.number(),
    requestBytes: z.number(),
    responseBytes: z.number(),
  });
  const comparison = z.object({
    graph: metric,
    baseline: metric,
    responseByteReduction: z.number(),
  });
  const report = z
    .object({
      fixtureVersion: z.literal(1),
      unit: z.literal("utf8-bytes"),
      source: z.object({
        revision: z.literal(SOURCE_REVISION),
        manifest: z.array(z.object({ file: z.string(), digest: z.string() })),
      }),
      tasks: z
        .array(
          z.object({
            symbol: z.string(),
            file: z.string(),
            answer: z.string(),
            answersChecked: z.literal(true),
            location: comparison,
            implementation: comparison,
            transcripts: z.object({
              graph: z.array(exchange),
              baseline: z.array(exchange),
            }),
          }),
        )
        .length(TASKS.length),
      medianLocationReduction: z.number(),
      medianImplementationReduction: z.number(),
      target: z.object({
        threshold: z.literal(0.9),
        locationMet: z.boolean(),
        implementationMet: z.boolean(),
        hostTokenClaim: z.literal(false),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../docs/benchmarks/code-discovery-v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as unknown,
    );
  const scratch = mkdtempSync(join(tmpdir(), "discovery-replay-"));
  try {
    mkdirSync(join(scratch, "src"));
    for (const [index, recorded] of report.tasks.entries()) {
      const expected = TASKS[index];
      assert.ok(expected);
      assert.equal(recorded.symbol, expected.symbol);
      assert.equal(recorded.file, expected.file);
      assert.equal(recorded.answer, expected.answer);
      const [search, snippet] = recorded.transcripts.graph;
      const [grep, ...reads] = recorded.transcripts.baseline;
      assert.ok(search && snippet && grep);
      assert.equal(recorded.transcripts.graph.length, 2);
      checkedHit(search.response, expected);
      assert.equal(typeof grep.response, "string");
      const files = matchedFiles(String(grep.response), expected);
      assert.equal(reads.length, files.length);
      for (const [readIndex, read] of reads.entries()) {
        const file = files[readIndex];
        assert.ok(file);
        assert.match(file, /^src\/[A-Za-z0-9_-]+\.ts$/u);
        assert.deepEqual(read.request, { operation: "readFile", path: file });
        assert.equal(typeof read.response, "string");
        const source = String(read.response);
        const digest =
          "sha256:" + createHash("sha256").update(source).digest("hex");
        assert.equal(
          digest,
          report.source.manifest.find((entry) => entry.file === file)?.digest,
        );
        writeFileSync(join(scratch, file), source);
      }
      const payload = toolPayload(snippet.response);
      checkedSnippet(
        result({ ...payload, file_path: join(scratch, expected.file) }),
        expected,
        scratch,
      );
      assert.deepEqual(measurement([search]), recorded.location.graph);
      assert.deepEqual(measurement([grep]), recorded.location.baseline);
      assert.deepEqual(
        measurement(recorded.transcripts.graph),
        recorded.implementation.graph,
      );
      assert.deepEqual(
        measurement(recorded.transcripts.baseline),
        recorded.implementation.baseline,
      );
      for (const value of [recorded.location, recorded.implementation]) {
        assert.equal(
          value.responseByteReduction,
          1 - value.graph.responseBytes / value.baseline.responseBytes,
        );
      }
    }
    for (const kind of ["Location", "Implementation"] as const) {
      const values = report.tasks
        .map(
          (item) =>
            (kind === "Location" ? item.location : item.implementation)
              .responseByteReduction,
        )
        .sort((left, right) => left - right);
      const measuredMedian = ((values[2] ?? NaN) + (values[3] ?? NaN)) / 2;
      assert.equal(
        measuredMedian,
        report[
          ("median" + kind + "Reduction") as
            "medianLocationReduction" | "medianImplementationReduction"
        ],
      );
      assert.equal(
        kind === "Location"
          ? report.target.locationMet
          : report.target.implementationMet,
        measuredMedian > report.target.threshold,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
