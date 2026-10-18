import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import * as z from "zod/v4";

import { demoPolicy } from "../src/demo-config.js";
import { digestCanonical } from "../src/digest.js";
import type { ReproGateExecutor } from "../src/executor.js";
import { ReproGateKernel } from "../src/kernel.js";
import { HostMediator, type BoundedContent } from "../src/mediation.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const fixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  upstream: z.object({
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    path: z.string(),
    digest,
    measuredAt: z.string(),
    tools: z.record(z.string(), z.unknown()),
    sourceRevision: z.string(),
    sourceTree: z.string(),
  }),
  tasks: z
    .array(
      z.object({
        symbol: z.string().min(1),
        file: z.string().min(1),
        answer: z.string().min(1),
        sourceDigest: digest,
        search: z.unknown(),
        snippet: z.unknown(),
      }),
    )
    .length(6),
});

const identity = {
  name: z.string(),
  qualified_name: z.string(),
  label: z.string(),
  file_path: z.string(),
};
const searchSchema = z.object({
  total: z.number(),
  has_more: z.boolean(),
  results: z.array(z.object({ ...identity, lines: z.number().optional() })),
});
const snippetSchema = z.object({
  ...identity,
  start_line: z.number(),
  end_line: z.number(),
  source: z.string(),
});

function payload(result: unknown): unknown {
  const envelope = z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .length(1),
    })
    .parse(result);
  const item = envelope.content[0];
  assert.ok(item);
  return JSON.parse(item.text) as unknown;
}

function visible(result: BoundedContent): unknown {
  assert.equal(result.truncated, false);
  assert.equal(result.redactions, 0);
  assert.equal(result.omittedItems, 0);
  return payload(result);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Offline replay of recorded graph replies; no graph server or Git access. */
export function replayGraphViews(input: unknown) {
  const fixture = fixtureSchema.parse(input);
  const host = new HostMediator(
    {} as ReproGateExecutor,
    new ReproGateKernel([], demoPolicy),
    { effects: ["local_read"] },
    "replay-capability-fake-secret-32-characters",
    "replay-receipt-fake-secret-32-characters",
  );
  const tasks = fixture.tasks.map((task) => {
    const originalSearch = searchSchema.parse(payload(task.search));
    const originalSnippet = snippetSchema.parse(payload(task.snippet));
    assert.ok(
      originalSearch.results.some(
        (row) => row.name === task.symbol && row.file_path === task.file,
      ),
    );
    assert.equal(originalSnippet.name, task.symbol);
    assert.ok(originalSnippet.file_path.endsWith("/" + task.file));
    assert.equal(sha256(originalSnippet.source), task.sourceDigest);
    assert.ok(originalSnippet.source.includes(task.answer));
    const originalDigest = digestCanonical([task.search, task.snippet]);
    const before = {
      search: host.bound(task.search),
      snippet: host.bound(task.snippet),
    };
    const after = {
      search: host.bound(task.search, "search"),
      snippet: host.bound(task.snippet, "snippet"),
    };
    z.object({ view: z.literal("graph_search_v1") }).parse(
      visible(after.search),
    );
    z.object({ view: z.literal("graph_snippet_v1") }).parse(
      visible(after.snippet),
    );
    // Compare every identity/location, pagination and the complete source,
    // including trailing newlines, against the independently pinned fixture.
    assert.deepEqual(searchSchema.parse(visible(after.search)), originalSearch);
    assert.deepEqual(
      snippetSchema.parse(visible(after.snippet)),
      originalSnippet,
    );
    assert.deepEqual(
      searchSchema.parse(visible(before.search)),
      originalSearch,
    );
    assert.deepEqual(
      snippetSchema.parse(visible(before.snippet)),
      originalSnippet,
    );
    assert.equal(digestCanonical([task.search, task.snippet]), originalDigest);
    const location = {
      beforeBytes: bytes(before.search),
      afterBytes: bytes(after.search),
    };
    const implementation = {
      beforeBytes: bytes(before.search) + bytes(before.snippet),
      afterBytes: bytes(after.search) + bytes(after.snippet),
    };
    return {
      symbol: task.symbol,
      answersChecked: true,
      sourceDigest: task.sourceDigest,
      originalDigest,
      location: {
        ...location,
        reduction: 1 - location.afterBytes / location.beforeBytes,
      },
      implementation: {
        ...implementation,
        reduction: 1 - implementation.afterBytes / implementation.beforeBytes,
      },
      before,
      after,
    };
  });
  return {
    fixtureVersion: 1,
    unit: "utf8-bytes",
    measurement: "offline-mediation-replay",
    upstream: fixture.upstream,
    maxTextBytes: 16384,
    denominator:
      "JSON serialized BoundedContent before projection, after mirror deduplication",
    tasks,
    medianLocationReduction: median(
      tasks.map((task) => task.location.reduction),
    ),
    medianImplementationReduction: median(
      tasks.map((task) => task.implementation.reduction),
    ),
    hostTokensMeasured: false,
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const input = readFileSync(
    new URL("../../docs/benchmarks/graph-views-input-v1.json", import.meta.url),
    "utf8",
  );
  process.stdout.write(
    JSON.stringify(replayGraphViews(JSON.parse(input)), null, 2) + "\n",
  );
}
