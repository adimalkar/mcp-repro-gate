import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  assertSuccessfulRun,
  claudeArgs,
  parseStream,
  prepare,
  recorderBrief,
  renderTranscript,
  resumePrompt,
  score,
  summarize,
  type RunResult,
} from "../benchmarks/handoff-resume.js";
import { TASKS } from "../benchmarks/handoff-resume-tasks.js";
import { extractTranscript } from "../src/handoff-recorder.js";

const posix = { skip: process.platform === "win32" };

function scratch(t: TestContext) {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-resume-bench-")),
  );
  t.after(() => {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  return dir;
}

const prompts = (task: (typeof TASKS)[number]) =>
  task.session.flatMap((step) => (step.kind === "prompt" ? [step.text] : []));

// The scoring must fail the state the first session left and pass a known
// good finish, or the benchmark measures nothing.
for (const task of TASKS)
  test(
    `${task.id}: unfinished work fails and the reference passes every check`,
    posix,
    (t) => {
      const dir = scratch(t);
      const prepared = prepare(task, dir);
      const unfinished = join(dir, "unfinished");
      cpSync(prepared.repo, unfinished, { recursive: true });
      assert.equal(score(task, unfinished).success, false);

      const finished = join(dir, "finished");
      cpSync(prepared.repo, finished, { recursive: true });
      for (const [path, content] of Object.entries(task.reference)) {
        mkdirSync(dirname(join(finished, path)), { recursive: true });
        writeFileSync(join(finished, path), content);
      }
      const result = score(task, finished);
      assert.deepEqual(
        result.checks.filter((check) => !check.pass),
        [],
      );
      assert.equal(result.hiddenPassed, result.hiddenTotal);
      assert.ok(result.hiddenTotal > 0);
      assert.equal(result.testsFailed, 0);
      assert.equal(result.success, true);
    },
  );

test(
  "the transcripts read as Claude Code transcripts, and the brief keeps every user prompt verbatim",
  posix,
  (t) => {
    const dir = scratch(t);
    for (const task of TASKS) {
      const prepared = prepare(task, dir);
      const lines = readFileSync(prepared.transcript, "utf8")
        .trim()
        .split("\n");
      const { events } = extractTranscript(lines, {
        root: prepared.repo,
        now: 0,
        sidechain: false,
      });
      assert.deepEqual(
        events
          .filter((event) => event.kind === "request")
          .map((event) => event.text),
        prompts(task),
        task.id,
      );
      const brief = recorderBrief(prepared);
      assert.ok(brief.length <= 9000, task.id);
      for (const prompt of prompts(task))
        assert.ok(brief.includes(prompt), `${task.id}: ${prompt.slice(0, 40)}`);
      if (task.stop === "rate_limit")
        assert.match(brief, /rate_limit/u, task.id);
      // The summarizer sees the same session in full.
      for (const prompt of prompts(task))
        assert.ok(renderTranscript(task).includes(prompt));
      assert.ok(resumePrompt(brief).includes(brief.trim()));
    }
  },
);

test("stream metrics count tokens once per message and find the first target edit", () => {
  const repo = "/runs/repo";
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 0,
    output_tokens: 5,
  };
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        usage,
        content: [{ type: "text", text: "looking" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        usage,
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: `${repo}/src/a.js` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m2",
        usage,
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: `${repo}/src/decoy.js` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m3",
        usage,
        content: [
          { type: "tool_use", name: "Write", input: { file_path: "src/a.js" } },
        ],
      },
    }),
    "not json",
    JSON.stringify({
      type: "result",
      is_error: false,
      total_cost_usd: 0.12,
      num_turns: 4,
      duration_ms: 9000,
      usage: {
        input_tokens: 30,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 0,
        output_tokens: 15,
      },
    }),
  ];
  const metrics = parseStream(lines, repo, ["src/a.js"]);
  assert.equal(metrics.toolCalls, 3);
  assert.equal(metrics.tokensToFirstEdit, 345);
  assert.equal(metrics.callsToFirstEdit, 3);
  assert.deepEqual(metrics.edited, ["src/decoy.js", "src/a.js"]);
  assert.equal(metrics.tokens, 345);
  assert.equal(metrics.costUsd, 0.12);
  assert.equal(metrics.completed, true);
  // A run that never edits a target has no first edit.
  assert.equal(
    parseStream(lines.slice(0, 5), repo, ["src/a.js"]).tokensToFirstEdit,
    null,
  );
});

test("every model call is isolated from user hooks, MCP servers and saved sessions", () => {
  for (const tools of ["agent", "none"] as const) {
    const args = claudeArgs("sonnet", tools);
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
    assert.ok(args.includes("--no-session-persistence"));
    assert.match(
      args[args.indexOf("--disallowedTools") + 1] ?? "",
      /WebFetch WebSearch Agent/u,
    );
  }
  assert.match(
    claudeArgs("sonnet", "none")[
      claudeArgs("sonnet", "none").indexOf("--disallowedTools") + 1
    ] ?? "",
    /^Bash Read Edit Write/u,
  );
});

test("provider errors and missing results cannot become benchmark failures", () => {
  const result = (value: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      ...value,
    });
  assert.doesNotThrow(() => {
    assertSuccessfulRun([result({ is_error: false })], "task");
  });
  assert.throws(() => {
    assertSuccessfulRun(
      [result({ is_error: true, api_error: "usage_limit_reached" })],
      "task",
    );
  }, /task: model call rejected: usage_limit_reached/u);
  assert.throws(() => {
    assertSuccessfulRun([JSON.stringify({ type: "system" })], "task");
  }, /task: model call returned no result/u);
});

test("totals count successes, checks and medians per condition", () => {
  const run = (
    condition: "summary" | "recorder",
    success: boolean,
    tokens: number,
    first: number | null,
  ): RunResult => ({
    task: "t",
    condition,
    repeat: 1,
    contextChars: 100,
    completed: true,
    timedOut: false,
    costUsd: 0.5,
    turns: 3,
    durationMs: 1,
    tokens,
    outputTokens: 1,
    toolCalls: 2,
    tokensToFirstEdit: first,
    callsToFirstEdit: first === null ? null : 2,
    edited: [],
    success,
    testsPassed: 1,
    testsFailed: success ? 0 : 1,
    hiddenPassed: success ? 1 : 0,
    hiddenTotal: 1,
    checks: [{ name: "c", pass: success }],
  });
  const totals = summarize([
    run("summary", true, 100, 50),
    run("summary", false, 300, null),
    run("recorder", true, 200, 20),
    run("recorder", true, 400, 40),
  ]);
  assert.deepEqual(
    [
      totals.summary.successes,
      totals.summary.medianTokens,
      totals.summary.medianTokensToFirstEdit,
      totals.summary.noTargetEdit,
    ],
    [1, 200, 50, 1],
  );
  assert.deepEqual(
    [
      totals.recorder.successes,
      totals.recorder.checksPassed,
      totals.recorder.medianTokensToFirstEdit,
      totals.recorder.costUsd,
    ],
    [2, 2, 30, 1],
  );
});
