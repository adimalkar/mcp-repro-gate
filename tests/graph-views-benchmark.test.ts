import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { replayGraphViews } from "../benchmarks/graph-views.js";

function fixture(): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../docs/benchmarks/graph-views-input-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
}

test("recorded graph views replay with full source and unchanged results", () => {
  const input = fixture();
  const report = replayGraphViews(input);
  const published: unknown = JSON.parse(
    readFileSync(
      new URL("../../docs/benchmarks/graph-views-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(report, published);
  assert.equal(report.tasks.length, 6);
  assert.ok(report.tasks.every((task) => task.answersChecked));
});

test("replay refuses an answer or source hash that fails independent checks", () => {
  for (const field of ["answer", "sourceDigest"]) {
    const input = fixture() as { tasks: Record<string, unknown>[] };
    const first = input.tasks[0];
    assert.ok(first);
    first[field] =
      field === "answer"
        ? "invented answer absent from source"
        : "sha256:" + "0".repeat(64);
    assert.throws(() => replayGraphViews(input));
  }
});
