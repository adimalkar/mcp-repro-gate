import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RESEARCH_FIXTURE_VERSION,
  fixturePages,
  formatResearchReport,
  measurePage,
  pageText,
  runResearchBenchmark,
  succeededResult,
} from "../src/research/benchmark.js";

test("the research measurement is deterministic and keeps every answer", async () => {
  const first = await runResearchBenchmark();
  assert.deepEqual(await runResearchBenchmark(), first);
  assert.equal(first.fixtureVersion, RESEARCH_FIXTURE_VERSION);
  assert.equal(first.rows.length, fixturePages().length + 1);
  assert.equal(first.answersChecked, first.rows.length);
  assert.equal(first.answersKept, first.answersChecked);
  for (const row of first.rows) {
    assert.ok(row.measuredBytes > 0, row.name);
    // Text content and structuredContent both carry the distilled text.
    assert.ok(row.measuredBytes >= 2 * row.resultTextBytes, row.name);
    assert.ok(row.pageTextBytes < row.rawHtmlBytes, row.name);
  }
  // The fixture is synthetic: four large pages and one small one.
  const sizes = fixturePages().map((item) => Buffer.byteLength(item.html));
  assert.deepEqual(
    sizes.map((size) => size > 100_000),
    [true, true, true, true, false],
  );
  const table = formatResearchReport(first);
  for (const row of first.rows) assert.ok(table.includes(row.name));
  assert.match(table, /synthetic pages/u);
});

test("the page-text baseline drops scripts and styles but keeps page chrome", () => {
  const text = pageText(
    '<html><head><title>T</title><style>.a{}</style></head><body><nav><a href="/">Home</a></nav><script>var x = 1;</script><p>Body&amp;text</p><!-- note --><template><p>hidden</p></template><footer>Foot</footer></body></html>',
  );
  assert.equal(text, "Home Body&text Foot");
  // Unterminated constructs end the scan instead of looping.
  assert.equal(pageText("<p>a<script>b"), "a");
  assert.equal(pageText("a <b"), "a");
  // "</head" is not "</header", and an omitted </head> ends at <body>.
  assert.equal(
    pageText("<head><title>T</title></head><body><header>H</header><p>B</p>"),
    "H B",
  );
  assert.equal(
    pageText("<html><head><title>T</title><body><header>H</header><p>B</p>"),
    "H B",
  );
  // Many heads without a body stay linear (this took seconds when the
  // body was searched from scratch for every head).
  for (const tail of ["", "<body><p>end</p>"]) {
    const started = performance.now();
    assert.equal(
      pageText(`${"<head></head>".repeat(40_000)}${tail}`),
      tail === "" ? "" : "end",
    );
    assert.ok(performance.now() - started < 1000);
  }
  // Non-ASCII case mapping must not shift later indices.
  assert.equal(pageText("<p>İİİ</p><SCRIPT>x</SCRIPT><p>z</p>"), "İİİ z");
});

test("an empty baseline has no ratio instead of an infinite one", async () => {
  const row = await measurePage("", "anything");
  assert.equal(row.reductionVsHtml, null);
  assert.equal(row.reductionVsText, null);
  assert.match(formatResearchReport({ rows: [row] }), /n\/a/u);
});

test("a failed call is refused rather than measured", () => {
  assert.throws(
    () => succeededResult("x", { isError: true, content: [] }),
    /did not succeed/u,
  );
  assert.throws(
    () => succeededResult("x", { structuredContent: { other: 1 } }),
    /did not succeed/u,
  );
  assert.deepEqual(
    succeededResult("x", { structuredContent: { text: "t", truncated: true } }),
    { text: "t", truncated: true },
  );
});

test("a local page is measured without an answer check", async () => {
  const row = await measurePage(
    `<html><body><nav>${"<a>menu</a>".repeat(200)}</nav><p>Retry with backoff when the socket resets.</p></body></html>`,
    "socket retry backoff",
  );
  assert.equal(row.answerKept, null);
  assert.ok((row.reductionVsHtml ?? 0) > 0);
  assert.match(formatResearchReport({ rows: [row] }), /local page/u);
});

test("the CLI prints the fixture report and measures a saved page", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "bench", "research", ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
  const json = run("--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), await runResearchBenchmark());
  const table = run();
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /median reduction/u);

  const directory = mkdtempSync(join(tmpdir(), "reprogate-research-bench-"));
  try {
    const saved = join(directory, "page.html");
    writeFileSync(saved, "<p>Retry with backoff when the socket resets.</p>");
    const local = run("--html", saved, "--query", "retry backoff");
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /local page/u);
    for (const args of [
      ["--html", saved],
      ["--query", "x"],
      ["--html", "--query"],
      ["--csv"],
    ]) {
      const bad = run(...args);
      assert.notEqual(bad.status, 0, args.join(" "));
      assert.match(bad.stderr, /Usage: reprogate bench research/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published research numbers match the harness", async () => {
  const report = await runResearchBenchmark();
  const docs = readFileSync(
    fileURLToPath(new URL("../../docs/RESEARCH.md", import.meta.url)),
    "utf8",
  );
  const rows = docs
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()));
  for (const row of report.rows) {
    const cells = rows.find((cells) => cells[1] === row.name);
    assert.ok(cells, row.name);
    assert.deepEqual(
      cells.slice(2, 10),
      [
        String(row.rawHtmlBytes),
        String(row.pageTextBytes),
        String(row.measuredBytes),
        String(row.resultTextBytes),
        `${((row.reductionVsHtml ?? 0) * 100).toFixed(1)}%`,
        `${((row.reductionVsText ?? 0) * 100).toFixed(1)}%`,
        row.answerKept === true ? "kept" : "lost",
        row.truncated ? "yes" : "no",
      ],
      row.name,
    );
  }
  assert.ok(
    docs.includes(
      `Median reduction on this fixture: ${(report.medianReductionVsHtml * 100).toFixed(1)}% against raw HTML and ${(report.medianReductionVsText * 100).toFixed(1)}% against page text. All ${String(report.answersChecked)} answers were kept.`,
    ),
  );
  assert.equal(report.answersKept, report.answersChecked);
  // "Every page measured here saves more than 95%" covers the fixture.
  for (const row of report.rows)
    if (row.rawHtmlBytes > 150_000)
      assert.ok((row.reductionVsHtml ?? 0) > 0.95, row.name);
});
