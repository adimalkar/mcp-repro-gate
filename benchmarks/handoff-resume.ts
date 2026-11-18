/**
 * Handoff A/B benchmark: a first session works on a task and stops; a new
 * agent resumes it, given either a model-written summary of the session or
 * ReproGate's recorder brief. Same task, same prompt, same tools; only the
 * handoff context differs. See docs/proposals/handoff-flight-recorder.md.
 *
 *   node dist/benchmarks/handoff-resume.js prepare [--out <dir>]
 *   node dist/benchmarks/handoff-resume.js summaries [--model <m>]
 *   node dist/benchmarks/handoff-resume.js run [--model <m>] [--repeats <n>] [--tasks a,b] [--parallel <n>] [--out <dir>]
 *   node dist/benchmarks/handoff-resume.js report <results.json>
 *
 * `run` calls real agents and spends model quota; nothing else does.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createHandoffService } from "../src/handoff.js";
import { TASKS, type ResumeTask } from "./handoff-resume-tasks.js";

export const BENCHMARK_VERSION = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
// Compiled to dist/benchmarks; published results live in the source tree.
const DOCS = resolve(HERE, "..", "..", "docs", "benchmarks");
export const SUMMARIES_PATH = join(DOCS, "handoff-resume-summaries-v1.json");
export const RESULTS_PATH = join(DOCS, "handoff-resume-v1.json");
const START = Date.parse("2026-11-14T09:00:00.000Z");
const SESSION_ID = "6f1c0d3e-2b7a-4c55-9d1e-0a8b7c6d5e4f";
export const BRIEF_CHARS = 9000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- fixture

/** Files after the first session: the base with its writes and edits. */
export function sessionFiles(task: ResumeTask): Record<string, string> {
  const files = { ...task.base };
  for (const step of task.session) {
    if (step.kind === "write") files[step.path] = step.content;
    if (step.kind === "edit") {
      const current = files[step.path];
      if (!current?.includes(step.old))
        throw new Error(`${task.id}: edit of ${step.path} does not apply`);
      files[step.path] = current.replace(step.old, step.new);
    }
  }
  return files;
}

/** The first session as Claude Code writes its transcript. */
export function transcriptLines(task: ResumeTask, root: string): string[] {
  const files = { ...task.base };
  const out: string[] = [];
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const time = () => new Date(START + n * 20_000).toISOString();
  const common = () => ({
    uuid: id(),
    timestamp: time(),
    cwd: root,
    sessionId: SESSION_ID,
    isSidechain: false,
  });
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    out.push(
      JSON.stringify({
        type: "user",
        ...common(),
        message: { role: "user", content },
        ...extra,
      }),
    );
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
    out.push(
      JSON.stringify({
        type: "assistant",
        ...common(),
        message: { role: "assistant", content },
        ...extra,
      }),
    );
  const tool = (
    name: string,
    input: Record<string, unknown>,
    output: string,
    isError = false,
  ) => {
    const toolId = `toolu_${String(n + 1).padStart(6, "0")}`;
    assistant([{ type: "tool_use", id: toolId, name, input }]);
    user(
      [
        {
          type: "tool_result",
          tool_use_id: toolId,
          content: output,
          is_error: isError,
        },
      ],
      {
        toolUseResult:
          name === "Bash"
            ? { stdout: output, stderr: "", interrupted: false }
            : {},
      },
    );
  };
  for (const step of task.session) {
    const path = "path" in step ? join(root, step.path) : "";
    switch (step.kind) {
      case "prompt":
        user(step.text);
        break;
      case "say":
        assistant([{ type: "text", text: step.text }]);
        break;
      case "read": {
        const lines = (files[step.path] ?? "").split("\n");
        tool(
          "Read",
          { file_path: path },
          lines
            .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
            .join("\n"),
        );
        break;
      }
      case "bash":
        tool(
          "Bash",
          { command: step.command, description: "Run a command" },
          step.output,
          step.exit !== 0,
        );
        break;
      case "write": {
        const existed = files[step.path] !== undefined;
        files[step.path] = step.content;
        tool(
          "Write",
          { file_path: path, content: step.content },
          existed
            ? `The file ${path} has been updated successfully.`
            : `File created successfully at: ${path}`,
        );
        break;
      }
      case "edit":
        files[step.path] = (files[step.path] ?? "").replace(step.old, step.new);
        tool(
          "Edit",
          { file_path: path, old_string: step.old, new_string: step.new },
          `The file ${path} has been updated successfully.`,
        );
        break;
    }
  }
  if (task.stop === "rate_limit")
    assistant(
      [
        {
          type: "text",
          text: "API Error: Rate limit reached. Your limit resets at 3pm.",
        },
      ],
      {
        isApiErrorMessage: true,
        error: "rate_limit",
      },
    );
  return out;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Bench",
      "-c",
      "user.email=bench@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export interface Prepared {
  task: ResumeTask;
  /** The repository as the first session left it: base committed, the rest not. */
  repo: string;
  transcript: string;
}

/** Build a task's repository and its first-session transcript under `dir`. */
export function prepare(task: ResumeTask, dir: string): Prepared {
  const repo = join(dir, task.id, "repo");
  const transcripts = join(dir, task.id, "transcripts");
  mkdirSync(repo, { recursive: true });
  mkdirSync(transcripts, { recursive: true, mode: 0o700 });
  writeFiles(repo, task.base);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  writeFiles(repo, sessionFiles(task));
  const transcript = join(transcripts, "session.jsonl");
  writeFileSync(transcript, `${transcriptLines(task, repo).join("\n")}\n`, {
    mode: 0o600,
  });
  return { task, repo, transcript };
}

// ---------------------------------------------------------------- contexts

/**
 * The transcript as text, as a summarizer sees it: every message and tool
 * call with its full output. Paths are relative to the repository.
 */
export function renderTranscript(task: ResumeTask): string {
  const files = { ...task.base };
  const out: string[] = [];
  for (const step of task.session) {
    switch (step.kind) {
      case "prompt":
        out.push(`USER:\n${step.text}`);
        break;
      case "say":
        out.push(`ASSISTANT:\n${step.text}`);
        break;
      case "read":
        out.push(`TOOL Read ${step.path}\nRESULT:\n${files[step.path] ?? ""}`);
        break;
      case "bash":
        out.push(
          `TOOL Bash: ${step.command}\nRESULT (exit ${String(step.exit)}):\n${step.output}`,
        );
        break;
      case "write":
        files[step.path] = step.content;
        out.push(`TOOL Write ${step.path}:\n${step.content}`);
        break;
      case "edit":
        files[step.path] = (files[step.path] ?? "").replace(step.old, step.new);
        out.push(`TOOL Edit ${step.path}:\n- ${step.old}\n+ ${step.new}`);
        break;
    }
  }
  out.push(
    task.stop === "rate_limit"
      ? "[The session stopped here: API rate limit reached.]"
      : "[The session stopped here: the process was killed.]",
  );
  return out.join("\n\n");
}

export const SUMMARY_PROMPT_VERSION = 2;
export function summaryPrompt(task: ResumeTask): string {
  return `The following is the transcript of a coding session that stopped before its task was finished. Another agent will continue the work in the same repository, and will receive your handoff note instead of this transcript. Write that handoff note: what the user asked for, what was done, what failed or was tried, and what remains. Refer to files by their paths relative to the repository root. Be concise: at most 600 words. Reply with the note only.\n\n<transcript>\n${renderTranscript(task)}\n</transcript>`;
}

/** ReproGate's brief for the resuming agent, from the real hooks. */
export function recorderBrief(
  prepared: Prepared,
  maxChars = BRIEF_CHARS,
): string {
  const state = mkdtempSync(join(tmpdir(), "reprogate-bench-state-"));
  try {
    let time = START;
    const service = createHandoffService(
      {
        configVersion: 1,
        workspaceRoot: prepared.repo,
        databasePath: join(state, "context.sqlite"),
        allowUpdates: true,
        sessions: {
          observeGit: true,
          captureTranscripts: true,
          projectFile: false,
        },
      },
      { now: () => new Date(time), deferProjection: false, cwd: prepared.repo },
    );
    try {
      const hook = (payload: Record<string, unknown>) =>
        service.hook("claude-code", {
          session_id: "first-session",
          cwd: prepared.repo,
          transcript_path: prepared.transcript,
          ...payload,
        });
      hook({ hook_event_name: "SessionStart", source: "startup" });
      if (prepared.task.stop === "rate_limit")
        hook({ hook_event_name: "StopFailure", error: "rate_limit" });
      time += 2 * 3600_000;
      return service.briefText(maxChars);
    } finally {
      service.close();
    }
  } finally {
    rmSync(state, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

export const RESUME_PROMPT_VERSION = 1;
export function resumePrompt(context: string): string {
  return `You are taking over a coding task in this repository from a previous agent that stopped before it finished. This is the handoff context it left:\n\n<handoff>\n${context.trim()}\n</handoff>\n\nFinish the task the user asked for. Work only in this repository. When you are done, make sure \`npm test\` passes, then reply with one short paragraph.`;
}

// ---------------------------------------------------------------- agent runs

export interface RunMetrics {
  completed: boolean;
  timedOut: boolean;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  /** Input, cache and output tokens over the run. */
  tokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Tokens and tool calls up to the first edit of a target file. */
  tokensToFirstEdit: number | null;
  callsToFirstEdit: number | null;
  /** Edits and writes, by repository-relative path. */
  edited: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown) => (typeof value === "number" ? value : 0);

/** Metrics from Claude Code's stream-json output. */
export function parseStream(
  lines: readonly string[],
  repo: string,
  targets: readonly string[],
): RunMetrics {
  const metrics: RunMetrics = {
    completed: false,
    timedOut: false,
    costUsd: null,
    turns: null,
    durationMs: null,
    tokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    tokensToFirstEdit: null,
    callsToFirstEdit: null,
    edited: [],
  };
  const seen = new Set<string>();
  let running = 0;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      const message = record(event.message);
      const id =
        typeof message.id === "string" ? message.id : String(seen.size);
      // Content blocks of one message arrive as separate events with one usage.
      if (!seen.has(id)) {
        seen.add(id);
        const usage = record(message.usage);
        running +=
          num(usage.input_tokens) +
          num(usage.cache_creation_input_tokens) +
          num(usage.cache_read_input_tokens) +
          num(usage.output_tokens);
      }
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        const b = record(block);
        if (b.type !== "tool_use") continue;
        metrics.toolCalls++;
        const input = record(b.input);
        const path = input.file_path ?? input.notebook_path;
        if (
          typeof b.name === "string" &&
          EDIT_TOOLS.has(b.name) &&
          typeof path === "string"
        ) {
          const inside = relative(
            repo,
            isAbsolute(path) ? path : join(repo, path),
          )
            .split(sep)
            .join("/");
          if (!metrics.edited.includes(inside)) metrics.edited.push(inside);
          if (metrics.tokensToFirstEdit === null && targets.includes(inside)) {
            metrics.tokensToFirstEdit = running;
            metrics.callsToFirstEdit = metrics.toolCalls;
          }
        }
      }
    }
    if (event.type === "result") {
      metrics.completed = event.is_error !== true;
      metrics.costUsd =
        typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
      metrics.turns =
        typeof event.num_turns === "number" ? event.num_turns : null;
      metrics.durationMs =
        typeof event.duration_ms === "number" ? event.duration_ms : null;
      const usage = record(event.usage);
      metrics.outputTokens = num(usage.output_tokens);
      metrics.tokens =
        num(usage.input_tokens) +
        num(usage.cache_creation_input_tokens) +
        num(usage.cache_read_input_tokens) +
        num(usage.output_tokens);
    }
  }
  if (metrics.tokens === 0) metrics.tokens = running;
  return metrics;
}

/** Isolation for every model call: no user hooks, MCP servers or saved session. */
export function claudeArgs(model: string, tools: "agent" | "none"): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    ...(tools === "agent"
      ? [
          "--allowedTools",
          "Read Edit Write Glob Grep Bash(npm test:*) Bash(npm run:*) Bash(node:*) Bash(ls:*) Bash(cat:*) Bash(grep:*) Bash(git status:*) Bash(git diff:*) Bash(git log:*)",
          "--disallowedTools",
          "WebFetch WebSearch Agent Task",
        ]
      : [
          "--disallowedTools",
          "Bash Read Edit Write Glob Grep WebFetch WebSearch Agent Task",
        ]),
  ];
}

function runClaude(
  prompt: string,
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ lines: string[]; timedOut: boolean; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on(
      "data",
      (chunk: Buffer) => (stdout += chunk.toString("utf8")),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr += chunk.toString("utf8")),
    );
    child.on("close", () => {
      clearTimeout(timer);
      done({
        lines: stdout.split("\n").filter((line) => line.trim() !== ""),
        timedOut,
        stderr,
      });
    });
    child.stdin.end(prompt);
  });
}

/** A provider rejection is not a failed coding attempt and must not be scored. */
export function assertSuccessfulRun(
  lines: readonly string[],
  label: string,
): void {
  for (const line of [...lines].reverse()) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type !== "result") continue;
    if (event.is_error === true) {
      const reason =
        typeof event.api_error === "string"
          ? event.api_error
          : typeof event.result === "string"
            ? event.result
            : "unknown provider error";
      throw new Error(`${label}: model call rejected: ${reason.slice(0, 200)}`);
    }
    return;
  }
  throw new Error(`${label}: model call returned no result`);
}

/** The final text of a stream-json run. */
export function resultText(lines: readonly string[]): string | undefined {
  for (const line of [...lines].reverse()) {
    try {
      const event = record(JSON.parse(line));
      if (event.type === "result" && typeof event.result === "string")
        return event.result;
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- scoring

export interface Score {
  success: boolean;
  testsPassed: number;
  testsFailed: number;
  hiddenPassed: number;
  hiddenTotal: number;
  checks: { name: string; pass: boolean }[];
}

function listFiles(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir));
  } catch {
    return [];
  }
}
/** Add the hidden tests, run the suite, and run the task's checks. */
export function score(task: ResumeTask, repo: string): Score {
  const read = (path: string) => {
    try {
      return readFileSync(join(repo, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const list = (dir: string) => listFiles(repo, dir);
  // Checks see the agent's files, before the hidden tests are added.
  const checks = task.checks.map((check) => ({
    name: check.name,
    pass: check.pass(read, list),
  }));
  writeFiles(repo, task.hidden);
  // A test runner's own context would make the nested run report to it
  // instead of printing TAP.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "NODE_TEST_CONTEXT",
    ),
  );
  const run = spawnSync(
    "npm",
    ["test", "--silent", "--", "--test-reporter=tap"],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
      env,
    },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  const count = (pattern: RegExp) => Number(pattern.exec(output)?.[1] ?? 0);
  const hiddenTotal = Object.values(task.hidden).reduce(
    (sum, source) => sum + (source.match(/test\("hidden:/gu)?.length ?? 0),
    0,
  );
  const hiddenPassed = (output.match(/^\s*ok \d+ - hidden:/gmu) ?? []).length;
  const testsPassed = count(/^# pass (\d+)/mu);
  const testsFailed = count(/^# fail (\d+)/mu);
  return {
    success:
      testsFailed === 0 &&
      testsPassed > 0 &&
      hiddenPassed === hiddenTotal &&
      checks.every((check) => check.pass),
    testsPassed,
    testsFailed,
    hiddenPassed,
    hiddenTotal,
    checks,
  };
}

// ---------------------------------------------------------------- driver

export type Condition = "summary" | "recorder";
export interface RunResult extends RunMetrics, Score {
  task: string;
  condition: Condition;
  repeat: number;
  contextChars: number;
}

interface Summaries {
  benchmarkVersion: number;
  promptVersion: number;
  model: string;
  summaries: Record<string, string>;
}

async function makeSummaries(model: string): Promise<void> {
  // The summarizer runs in the repository the session left, as a client
  // compacting that session would, so what it sees of its environment is true.
  const dir = mkdtempSync(join(tmpdir(), "reprogate-bench-summary-"));
  const summaries: Record<string, string> = {};
  try {
    for (const task of TASKS) {
      const prepared = prepare(task, dir);
      const run = await runClaude(
        summaryPrompt(task),
        prepared.repo,
        claudeArgs(model, "none"),
        RUN_TIMEOUT_MS,
      );
      assertSuccessfulRun(run.lines, task.id);
      const text = resultText(run.lines);
      if (text === undefined)
        throw new Error(`${task.id}: no summary (${run.stderr.slice(0, 300)})`);
      summaries[task.id] = text.trim();
      process.stdout.write(`${task.id}: ${String(text.length)} chars\n`);
    }
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  mkdirSync(DOCS, { recursive: true });
  const value: Summaries = {
    benchmarkVersion: BENCHMARK_VERSION,
    promptVersion: SUMMARY_PROMPT_VERSION,
    model,
    summaries,
  };
  writeFileSync(SUMMARIES_PATH, `${JSON.stringify(value, null, 2)}\n`);
}

function loadSummaries(): Summaries {
  if (!existsSync(SUMMARIES_PATH)) throw new Error("Run `summaries` first.");
  return JSON.parse(readFileSync(SUMMARIES_PATH, "utf8")) as Summaries;
}

async function runAll(options: {
  model: string;
  repeats: number;
  tasks: ResumeTask[];
  parallel: number;
  out: string;
}): Promise<RunResult[]> {
  const summaries = loadSummaries();
  if (summaries.promptVersion !== SUMMARY_PROMPT_VERSION)
    throw new Error(
      "Summaries are from another prompt version; run `summaries`.",
    );
  const fixtures = join(options.out, "fixtures");
  // Recreate the synthetic starting repositories on resume. The completed
  // agent runs are kept separately in results.partial.json and logs/.
  rmSync(fixtures, { recursive: true, force: true });
  const contexts = new Map<
    string,
    { prepared: Prepared; summary: string; recorder: string }
  >();
  for (const task of options.tasks) {
    const prepared = prepare(task, fixtures);
    const summary = summaries.summaries[task.id];
    if (summary === undefined) throw new Error(`${task.id}: no summary`);
    contexts.set(task.id, {
      prepared,
      summary,
      recorder: recorderBrief(prepared),
    });
  }
  // Interleaved, alternating which condition goes first, so drift over time
  // (load, rate limits) does not favour one condition.
  const jobs: { task: ResumeTask; condition: Condition; repeat: number }[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat++)
    options.tasks.forEach((task, index) => {
      const order: Condition[] =
        (index + repeat) % 2 === 0
          ? ["summary", "recorder"]
          : ["recorder", "summary"];
      for (const condition of order) jobs.push({ task, condition, repeat });
    });
  const partialPath = join(options.out, "results.partial.json");
  const results: RunResult[] = existsSync(partialPath)
    ? (JSON.parse(readFileSync(partialPath, "utf8")) as RunResult[])
    : [];
  const key = (task: string, condition: Condition, repeat: number) =>
    `${task}/${condition}/${String(repeat)}`;
  const expected = new Set(
    jobs.map((job) => key(job.task.id, job.condition, job.repeat)),
  );
  const completed = new Set<string>();
  for (const result of results) {
    const id = key(result.task, result.condition, result.repeat);
    if (!expected.has(id) || completed.has(id))
      throw new Error(`Invalid or duplicate partial result: ${id}`);
    completed.add(id);
  }
  if (completed.size > 0)
    process.stdout.write(
      `Resuming ${String(completed.size)}/${String(jobs.length)} runs.\n`,
    );
  const logs = join(options.out, "logs");
  mkdirSync(logs, { recursive: true });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      if (completed.has(key(job.task.id, job.condition, job.repeat))) continue;
      const context = contexts.get(job.task.id);
      if (context === undefined) throw new Error("missing context");
      const text =
        job.condition === "summary" ? context.summary : context.recorder;
      const runDir = mkdtempSync(
        join(tmpdir(), `reprogate-bench-${job.task.id}-`),
      );
      try {
        const repo = join(runDir, "repo");
        cpSync(context.prepared.repo, repo, { recursive: true });
        const run = await runClaude(
          resumePrompt(text),
          repo,
          claudeArgs(options.model, "agent"),
          RUN_TIMEOUT_MS,
        );
        const name = `${job.task.id}-${job.condition}-${String(job.repeat)}`;
        writeFileSync(join(logs, `${name}.jsonl`), `${run.lines.join("\n")}\n`);
        if (!run.timedOut) assertSuccessfulRun(run.lines, name);
        const metrics = parseStream(run.lines, repo, job.task.targets);
        metrics.timedOut = run.timedOut;
        const scored = score(job.task, repo);
        const result: RunResult = {
          task: job.task.id,
          condition: job.condition,
          repeat: job.repeat,
          contextChars: text.length,
          ...metrics,
          ...scored,
          success: !run.timedOut && scored.success,
        };
        results.push(result);
        process.stdout.write(
          `${name}: ${result.success ? "PASS" : "FAIL"} hidden ${String(result.hiddenPassed)}/${String(result.hiddenTotal)} checks ${String(result.checks.filter((c) => c.pass).length)}/${String(result.checks.length)} tokens ${String(result.tokens)} first-edit ${String(result.tokensToFirstEdit)}\n`,
        );
        const nextPartial = `${partialPath}.tmp`;
        writeFileSync(nextPartial, `${JSON.stringify(results, null, 2)}\n`);
        renameSync(nextPartial, partialPath);
      } finally {
        rmSync(runDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, options.parallel) }, worker),
  );
  return results;
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

export interface ConditionSummary {
  runs: number;
  successes: number;
  checksPassed: number;
  checksTotal: number;
  hiddenPassed: number;
  hiddenTotal: number;
  medianTokens: number | null;
  medianTokensToFirstEdit: number | null;
  medianCallsToFirstEdit: number | null;
  noTargetEdit: number;
  costUsd: number;
}
export function summarize(
  results: readonly RunResult[],
): Record<Condition, ConditionSummary> {
  const of = (condition: Condition): ConditionSummary => {
    const runs = results.filter((result) => result.condition === condition);
    return {
      runs: runs.length,
      successes: runs.filter((run) => run.success).length,
      checksPassed: runs.reduce(
        (sum, run) => sum + run.checks.filter((check) => check.pass).length,
        0,
      ),
      checksTotal: runs.reduce((sum, run) => sum + run.checks.length, 0),
      hiddenPassed: runs.reduce((sum, run) => sum + run.hiddenPassed, 0),
      hiddenTotal: runs.reduce((sum, run) => sum + run.hiddenTotal, 0),
      medianTokens: median(runs.map((run) => run.tokens)),
      medianTokensToFirstEdit: median(
        runs.flatMap((run) =>
          run.tokensToFirstEdit === null ? [] : [run.tokensToFirstEdit],
        ),
      ),
      medianCallsToFirstEdit: median(
        runs.flatMap((run) =>
          run.callsToFirstEdit === null ? [] : [run.callsToFirstEdit],
        ),
      ),
      noTargetEdit: runs.filter((run) => run.tokensToFirstEdit === null).length,
      costUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    };
  };
  return { summary: of("summary"), recorder: of("recorder") };
}

export function renderReport(results: readonly RunResult[]): string {
  const totals = summarize(results);
  const lines = [
    "| Condition | Success | Hidden tests | Checks | Median tokens | Median tokens to first target edit | Median calls to it | Runs with no target edit | Cost (USD) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const condition of ["summary", "recorder"] as const) {
    const t = totals[condition];
    lines.push(
      `| ${condition} | ${String(t.successes)}/${String(t.runs)} | ${String(t.hiddenPassed)}/${String(t.hiddenTotal)} | ${String(t.checksPassed)}/${String(t.checksTotal)} | ${String(t.medianTokens)} | ${String(t.medianTokensToFirstEdit)} | ${String(t.medianCallsToFirstEdit)} | ${String(t.noTargetEdit)} | ${t.costUsd.toFixed(2)} |`,
    );
  }
  lines.push(
    "",
    "| Task | Summary successes | Recorder successes |",
    "| --- | --- | --- |",
  );
  for (const task of [...new Set(results.map((result) => result.task))]) {
    const count = (condition: Condition) => {
      const runs = results.filter(
        (result) => result.task === task && result.condition === condition,
      );
      return `${String(runs.filter((run) => run.success).length)}/${String(runs.length)}`;
    };
    lines.push(`| ${task} | ${count("summary")} | ${count("recorder")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const model = option(args, "--model") ?? "sonnet";
  const out = resolve(
    option(args, "--out") ??
      mkdtempSync(join(tmpdir(), "reprogate-handoff-bench-")),
  );
  const wanted = option(args, "--tasks")?.split(",");
  const tasks =
    wanted === undefined
      ? TASKS
      : TASKS.filter((task) => wanted.includes(task.id));
  switch (command) {
    case "prepare": {
      for (const task of tasks) {
        const prepared = prepare(task, out);
        const brief = recorderBrief(prepared);
        writeFileSync(join(out, task.id, "recorder-brief.txt"), brief);
        writeFileSync(
          join(out, task.id, "summary-prompt.txt"),
          summaryPrompt(task),
        );
        process.stdout.write(
          `${task.id}: ${prepared.repo} (brief ${String(brief.length)} chars)\n`,
        );
      }
      return;
    }
    case "summaries":
      await makeSummaries(model);
      return;
    case "run": {
      mkdirSync(out, { recursive: true });
      const summaries = loadSummaries();
      const manifest = {
        benchmarkVersion: BENCHMARK_VERSION,
        resumePromptVersion: RESUME_PROMPT_VERSION,
        summaryPromptVersion: SUMMARY_PROMPT_VERSION,
        summaryModel: summaries.model,
        summariesSha256: createHash("sha256")
          .update(readFileSync(SUMMARIES_PATH))
          .digest("hex"),
        sourceHead: git(resolve(HERE, "..", ".."), "rev-parse", "HEAD").trim(),
        model,
        repeats: Number(option(args, "--repeats") ?? 3),
        tasks: tasks.map((task) => task.id),
      };
      const manifestPath = join(out, "manifest.json");
      if (existsSync(manifestPath)) {
        const previous = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as unknown;
        if (JSON.stringify(previous) !== JSON.stringify(manifest))
          throw new Error(
            "Benchmark configuration changed; choose a new --out directory.",
          );
      } else if (existsSync(join(out, "results.partial.json"))) {
        throw new Error(
          "Partial results have no manifest; choose a new --out directory.",
        );
      } else {
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const results = await runAll({
        model,
        repeats: Number(option(args, "--repeats") ?? 3),
        tasks,
        parallel: Number(option(args, "--parallel") ?? 2),
        out,
      });
      const value = {
        benchmarkVersion: BENCHMARK_VERSION,
        resumePromptVersion: RESUME_PROMPT_VERSION,
        summaryModel: loadSummaries().model,
        model,
        claudeCode: spawnSync("claude", ["--version"], {
          encoding: "utf8",
        }).stdout.trim(),
        runs: results,
        totals: summarize(results),
      };
      writeFileSync(
        join(out, "results.json"),
        `${JSON.stringify(value, null, 2)}\n`,
      );
      process.stdout.write(
        `\n${renderReport(results)}\nResults: ${join(out, "results.json")}\n`,
      );
      return;
    }
    case "report": {
      const file = args[0];
      if (file === undefined) throw new Error("report <results.json>");
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        runs: RunResult[];
      };
      process.stdout.write(renderReport(value.runs));
      return;
    }
    default:
      process.stderr.write(
        "Usage: handoff-resume <prepare|summaries|run|report> [options]\n",
      );
      process.exitCode = 2;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
