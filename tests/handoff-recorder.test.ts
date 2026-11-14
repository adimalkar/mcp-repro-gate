import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

import { createHandoffService, type HandoffService } from "../src/handoff.js";
import { runHandoffCli } from "../src/handoff-cli.js";
import { extractTranscript, readTranscript } from "../src/handoff-recorder.js";
import { handoffSearchResultSchema } from "../src/handoff-session-contract.js";

const posix = { skip: process.platform === "win32" };

function fixture(
  t: TestContext,
  sessions: Record<string, unknown> = {},
  scope?: "repository",
) {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-recorder-")),
  );
  const workspaceRoot = join(scratch, "workspace");
  const state = join(scratch, "state");
  const transcripts = join(scratch, "transcripts");
  mkdirSync(workspaceRoot, { mode: 0o755 });
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(transcripts, { mode: 0o700 });
  const config = {
    configVersion: 1 as const,
    workspaceRoot,
    databasePath: join(state, "context.sqlite"),
    allowUpdates: true,
    ...(scope === undefined ? {} : { scope }),
    sessions: { observeGit: false, captureTranscripts: true, ...sessions },
  };
  let time = Date.parse("2026-11-13T10:00:00.000Z");
  const now = () => new Date(time);
  const services: HandoffService[] = [];
  t.after(() => {
    for (const service of services) service.close();
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const service = () => {
    const value = createHandoffService(config, {
      now,
      deferProjection: false,
    });
    services.push(value);
    return value;
  };
  return {
    scratch,
    workspaceRoot,
    transcripts,
    config,
    service,
    advance: (seconds: number) => {
      time += seconds * 1000;
    },
  };
}

// Transcript records in the shape Claude Code writes them.
let counter = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const at = "2026-11-13T09:00:00.000Z";
const prompt = (text: string, extra = {}) =>
  JSON.stringify({
    type: "user",
    uuid: uuid(),
    timestamp: at,
    message: { role: "user", content: text },
    ...extra,
  });
const assistant = (content: unknown[], extra = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid: uuid(),
    timestamp: at,
    message: { role: "assistant", content },
    ...extra,
  });
const say = (text: string) => assistant([{ type: "text", text }]);
const bash = (id: string, command: string) =>
  assistant([{ type: "tool_use", id, name: "Bash", input: { command } }]);
const edit = (id: string, path: string) =>
  assistant([
    {
      type: "tool_use",
      id,
      name: "Edit",
      input: { file_path: path, old_string: "a", new_string: "b" },
    },
  ]);
const result = (id: string, content: string, isError = false, extra = {}) =>
  JSON.stringify({
    type: "user",
    uuid: uuid(),
    timestamp: at,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content, is_error: isError },
      ],
    },
    toolUseResult: { stdout: "", stderr: "", interrupted: false },
    ...extra,
  });
const lines = (...records: string[]) => `${records.join("\n")}\n`;

test("extraction keeps requests, replies, commands, edits and errors, and nothing else", () => {
  const root = "/work/repo";
  const { events, results } = extractTranscript(
    [
      prompt("Fix the flaky widget test"),
      prompt("Caveat: generated", { isMeta: true }),
      prompt("<task-notification>done</task-notification>"),
      prompt("summary of earlier turns", { isCompactSummary: true }),
      JSON.stringify({
        type: "user",
        uuid: uuid(),
        timestamp: at,
        message: {
          content: [
            { type: "text", text: "and this screenshot" },
            { type: "image", source: {} },
          ],
        },
      }),
      assistant([{ type: "thinking", thinking: "private reasoning" }]),
      say(`Looking at it. ${"x".repeat(2000)}`),
      bash("toolu_1", "npm test -- widget"),
      result(
        "toolu_1",
        "Exit code 2\nFAIL widget.test.ts\nError: ENOENT ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        true,
      ),
      bash("toolu_2", "git status"),
      result("toolu_2", "clean"),
      edit("toolu_3", "/work/repo/src/widget.ts"),
      edit("toolu_4", "/etc/passwd"),
      edit("toolu_5", "../outside.ts"),
      assistant([
        {
          type: "tool_use",
          id: "toolu_6",
          name: "Read",
          input: { file_path: "/work/repo/a" },
        },
      ]),
      result("toolu_6", "secret file contents that must not be stored"),
      assistant([{ type: "text", text: "API Error: rate limited" }], {
        isApiErrorMessage: true,
        error: "rate_limit",
      }),
      say("from a subagent"),
      JSON.stringify({
        type: "assistant",
        uuid: uuid(),
        isSidechain: true,
        message: { content: [{ type: "text", text: "sidechain reply" }] },
      }),
      "{not json",
      JSON.stringify({ type: "attachment", uuid: uuid() }),
      JSON.stringify({ type: "user", message: { content: "no uuid" } }),
    ],
    { root, now: 0, sidechain: false },
  );
  const byKind = (kind: string) =>
    events.filter((event) => event.kind === kind).map((event) => event.text);
  assert.deepEqual(byKind("request"), [
    "Fix the flaky widget test",
    "and this screenshot",
  ]);
  const replies = byKind("reply");
  assert.equal(replies.length, 2);
  assert.ok(Buffer.byteLength(replies[0] ?? "") <= 512);
  assert.ok(!replies.includes("sidechain reply"));
  assert.deepEqual(byKind("command"), ["npm test -- widget", "git status"]);
  assert.deepEqual(byKind("edit"), ["src/widget.ts"]);
  assert.deepEqual(byKind("api_error"), [
    "[rate_limit] API Error: rate limited",
  ]);
  assert.ok(!JSON.stringify(events).includes("private reasoning"));
  assert.ok(
    !JSON.stringify({ events, results }).includes("secret file contents"),
  );

  const failed = results.find((entry) => entry.toolUseId === "toolu_1");
  assert.equal(failed?.status, "failed");
  assert.equal(failed.exitCode, 2);
  assert.match(String(failed.tail), /FAIL widget\.test\.ts/u);
  assert.doesNotMatch(String(failed.tail), /ghp_/u);
  assert.equal(failed.redactions, 1);
  const ok = results.find((entry) => entry.toolUseId === "toolu_2");
  assert.deepEqual([ok?.status, ok?.tail], ["ok", null]);

  // A subagent transcript is all sidechain records.
  const side = extractTranscript(
    [
      JSON.stringify({
        type: "assistant",
        uuid: uuid(),
        isSidechain: true,
        message: { content: [{ type: "text", text: "sidechain reply" }] },
      }),
    ],
    { root, now: 0, sidechain: true },
  );
  assert.deepEqual(
    side.events.map((event) => event.text),
    ["sidechain reply"],
  );
});

test("transcripts are read incrementally, complete lines only, and restart on a new file", (t) => {
  const f = fixture(t);
  const path = join(f.transcripts, "a.jsonl");
  writeFileSync(path, `${prompt("one")}\n${prompt("two")}\n{"partial":`, {
    mode: 0o600,
  });
  const first = readTranscript(path, undefined);
  assert.equal(first?.lines.length, 2);
  assert.ok(first.remaining > 0);
  appendFileSync(path, `"rest"}\n`);
  const second = readTranscript(path, first);
  assert.deepEqual(second?.lines, ['{"partial":"rest"}']);
  assert.equal(second.remaining, 0);
  assert.deepEqual(readTranscript(path, second)?.lines, []);

  // Truncated, or replaced by another file: read from the start.
  truncateSync(path, 0);
  appendFileSync(path, `${prompt("three")}\n`);
  assert.equal(readTranscript(path, second)?.lines.length, 1);
  const other = join(f.transcripts, "b.jsonl");
  writeFileSync(other, `${prompt("four")}\n${prompt("five")}\n`, {
    mode: 0o600,
  });
  const before = readTranscript(path, undefined);
  renameSync(other, path);
  assert.equal(readTranscript(path, before)?.lines.length, 2);

  // A line longer than one read is skipped to its end.
  const long = join(f.transcripts, "long.jsonl");
  writeFileSync(long, `${"x".repeat(5000)}\n${prompt("after")}\n`, {
    mode: 0o600,
  });
  const skipped = readTranscript(long, undefined, 1024);
  assert.deepEqual(skipped?.lines, []);
  assert.equal(readTranscript(long, skipped, 1024)?.lines.length, 1);

  // Refused paths.
  assert.equal(readTranscript("relative.jsonl", undefined), undefined);
  assert.equal(
    readTranscript(join(f.transcripts, "missing.jsonl"), undefined),
    undefined,
  );
  const text = join(f.transcripts, "notes.txt");
  writeFileSync(text, `${prompt("x")}\n`);
  assert.equal(readTranscript(text, undefined), undefined);
});

test("a symlinked transcript is refused", posix, (t) => {
  const f = fixture(t);
  const target = join(f.transcripts, "real.jsonl");
  writeFileSync(target, `${prompt("hello")}\n`, { mode: 0o600 });
  const link = join(f.transcripts, "link.jsonl");
  symlinkSync(target, link);
  assert.equal(readTranscript(link, undefined), undefined);
});

function hook(
  service: HandoffService,
  cwd: string,
  payload: Record<string, unknown>,
) {
  return service.hook("claude-code", {
    cwd,
    session_id: "claude-1",
    ...payload,
  });
}

test("hooks record a session's transcript and the brief shows requests, failures and files", (t) => {
  const f = fixture(t);
  const service = f.service();
  const path = join(f.transcripts, "claude-1.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  const base = { transcript_path: path };
  hook(service, f.workspaceRoot, {
    ...base,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  appendFileSync(
    path,
    lines(
      prompt("Make the importer retry on EPERM"),
      bash("toolu_a", "npm test"),
      result("toolu_a", "Exit code 1\nnot ok 3 - importer retries", true),
      edit("toolu_b", join(f.workspaceRoot, "src", "importer.ts")),
      result("toolu_b", "ok"),
      say("Added a retry loop."),
    ),
  );
  assert.equal(
    hook(service, f.workspaceRoot, { ...base, hook_event_name: "Stop" })
      .recorded,
    true,
  );
  const recorded = service.brief().recorded;
  assert.equal(recorded?.source, "client_transcript");
  assert.deepEqual(
    recorded.requests.map((r) => r.text),
    ["Make the importer retry on EPERM"],
  );
  assert.deepEqual(
    recorded.failures.map((failure) => [
      failure.command,
      failure.status,
      failure.exitCode,
    ]),
    [["npm test", "failed", 1]],
  );
  assert.match(String(recorded.failures[0]?.tail), /importer retries/u);
  assert.deepEqual(
    recorded.files.map((file) => file.path),
    ["src/importer.ts"],
  );
  // Without Git, no blob ID is computed.
  assert.equal(recorded.files[0]?.blob, null);
  const text = service.briefText();
  assert.match(text, /Recorded from client transcripts:/u);
  assert.match(
    text,
    /User asked \([0-9a-f]{8}, .*\): Make the importer retry on EPERM/u,
  );
  assert.match(text, /Failed \(exit 1\), .*: npm test/u);
  assert.match(text, /Changed src\/importer\.ts/u);

  // Reading again records nothing twice, even from the start.
  const database = new DatabaseSync(f.config.databasePath);
  const count = () =>
    database.prepare("SELECT count(*) AS n FROM handoff_events").get()
      ?.n as number;
  const before = count();
  database.exec("UPDATE handoff_transcripts SET read_offset = 0");
  hook(service, f.workspaceRoot, { ...base, hook_event_name: "Stop" });
  assert.equal(count(), before);
  database.close();

  // Recorded events are searchable.
  const found = service.search({
    handoffVersion: 1,
    query: "importer retries",
  });
  assert.ok(handoffSearchResultSchema.safeParse(found).success);
  const command = found.hits.find((hit) => hit.kind === "command");
  assert.equal(command?.source, "event");
  assert.match(command.text, /\[failed exit 1\]/u);
  assert.equal(
    service.search({ handoffVersion: 1, query: "importer", kinds: ["request"] })
      .hits[0]?.text,
    "Make the importer retry on EPERM",
  );
});

test("a turn cut off by a rate limit is recorded by StopFailure, and a killed session at the next start", (t) => {
  const f = fixture(t);
  const service = f.service();
  const first = join(f.transcripts, "first.jsonl");
  writeFileSync(first, "", { mode: 0o600 });
  hook(service, f.workspaceRoot, {
    transcript_path: first,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  appendFileSync(
    first,
    lines(prompt("Port the parser"), bash("toolu_p", "cargo build")),
  );
  hook(service, f.workspaceRoot, {
    transcript_path: first,
    hook_event_name: "StopFailure",
    error: "rate_limit",
  });
  const brief = service.brief();
  assert.deepEqual(
    brief.recorded?.requests.map((r) => r.text),
    ["Port the parser"],
  );
  assert.equal(brief.sessions[0]?.state, "failed");

  // The same session goes on, then dies with no hook at all.
  appendFileSync(
    first,
    lines(
      result("toolu_p", "Exit code 101\nerror[E0425]", true),
      prompt("keep going"),
    ),
  );
  const second = join(f.transcripts, "second.jsonl");
  writeFileSync(second, "", { mode: 0o600 });
  hook(service, f.workspaceRoot, {
    session_id: "claude-2",
    transcript_path: second,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const caught = service.brief().recorded;
  assert.deepEqual(
    caught?.requests.map((r) => r.text),
    ["keep going", "Port the parser"],
  );
  assert.deepEqual(
    caught.failures.map((failure) => failure.exitCode),
    [101],
  );
});

test("a subagent's own transcript is recorded under its session", (t) => {
  const f = fixture(t);
  const service = f.service();
  const main = join(f.transcripts, "main.jsonl");
  const sub = join(f.transcripts, "agent-1.jsonl");
  writeFileSync(main, "", { mode: 0o600 });
  writeFileSync(
    sub,
    lines(
      JSON.stringify({
        type: "user",
        uuid: uuid(),
        isSidechain: true,
        timestamp: at,
        message: { content: "Audit the schema" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: uuid(),
        isSidechain: true,
        timestamp: at,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_s",
              name: "Bash",
              input: { command: "npm run lint" },
            },
          ],
        },
      }),
    ),
    { mode: 0o600 },
  );
  hook(service, f.workspaceRoot, {
    transcript_path: main,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  hook(service, f.workspaceRoot, {
    transcript_path: main,
    hook_event_name: "SubagentStart",
    agent_id: "agent-1",
    agent_type: "auditor",
  });
  hook(service, f.workspaceRoot, {
    transcript_path: main,
    agent_transcript_path: sub,
    hook_event_name: "SubagentStop",
    agent_id: "agent-1",
    agent_type: "auditor",
  });
  const brief = service.brief();
  const request = brief.recorded?.requests[0];
  assert.equal(request?.text, "Audit the schema");
  assert.notEqual(
    request.sessionId,
    brief.sessions.find((s) => s.kind === "agent")?.sessionId,
  );
});

test("nothing is recorded unless capture is on, and an unreadable transcript never fails a hook", (t) => {
  const f = fixture(t, { captureTranscripts: false });
  const service = f.service();
  const path = join(f.transcripts, "off.jsonl");
  writeFileSync(path, lines(prompt("should not be kept")), { mode: 0o600 });
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "Stop",
  });
  assert.equal(service.brief().recorded, undefined);
  assert.equal(
    service.search({ handoffVersion: 1, query: "kept" }).hits.length,
    0,
  );

  const g = fixture(t);
  const on = g.service();
  // Before any session exists, and with paths that cannot be read.
  for (const transcript of [
    join(g.transcripts, "missing.jsonl"),
    "relative.jsonl",
    42,
  ])
    assert.doesNotThrow(() =>
      hook(on, g.workspaceRoot, {
        transcript_path: transcript,
        hook_event_name: "Stop",
      }),
    );
  hook(on, g.workspaceRoot, {
    transcript_path: join(g.transcripts, "missing.jsonl"),
    hook_event_name: "SessionStart",
    source: "startup",
  });
  assert.equal(
    hook(on, g.workspaceRoot, {
      transcript_path: join(g.transcripts, "missing.jsonl"),
      hook_event_name: "Stop",
    }).recorded,
    true,
  );
  assert.deepEqual(on.brief().recorded?.requests, []);
});

function git(root: string, ...args: string[]) {
  const run = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("an edited file is recorded with the Git blob ID of its bytes", (t) => {
  const f = fixture(t, { observeGit: true }, "repository");
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "first");
  writeFileSync(join(root, "a.txt"), "two\n");
  const service = f.service();
  const path = join(f.transcripts, "git.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  hook(service, root, {
    transcript_path: path,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  appendFileSync(
    path,
    lines(edit("toolu_g", join(root, "a.txt")), result("toolu_g", "ok")),
  );
  hook(service, root, { transcript_path: path, hook_event_name: "Stop" });
  const file = service.brief().recorded?.files[0];
  assert.equal(file?.path, "a.txt");
  assert.equal(file.blob, git(root, "hash-object", "a.txt"));
});

test("the byte cap drops replies before user requests", (t) => {
  const f = fixture(t, { captureBytes: 1024 * 1024 });
  const service = f.service();
  const path = join(f.transcripts, "big.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const records: string[] = [];
  for (let index = 0; index < 300; index++)
    records.push(say(`reply ${String(index)} ${"r".repeat(500)}`));
  for (let index = 0; index < 240; index++)
    records.push(prompt(`request ${String(index)} ${"q".repeat(4000)}`));
  appendFileSync(path, lines(...records));
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "Stop",
  });
  const database = new DatabaseSync(f.config.databasePath);
  try {
    const rows = database
      .prepare(
        "SELECT kind, count(*) AS n, sum(bytes) AS bytes FROM handoff_events GROUP BY kind",
      )
      .all();
    const counts = new Map(rows.map((row) => [row.kind, row.n]));
    const total = rows.reduce((sum, row) => sum + (row.bytes as number), 0);
    assert.ok(total <= 1024 * 1024, String(total));
    assert.equal(counts.get("request"), 240);
    assert.ok(Number(counts.get("reply") ?? 0) < 300);
  } finally {
    database.close();
  }
});

test("briefs with recorded events still fit every budget, dropping requests last", (t) => {
  const f = fixture(t);
  const service = f.service();
  const path = join(f.transcripts, "fit.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const records: string[] = [];
  for (let index = 0; index < 5; index++) {
    records.push(prompt(`request ${String(index)} ${"q".repeat(3000)}`));
    records.push(bash(`toolu_${String(index)}`, `make ${"c".repeat(900)}`));
    records.push(
      result(
        `toolu_${String(index)}`,
        `Exit code 2\n${"t".repeat(3000)}`,
        true,
      ),
    );
    records.push(
      edit(
        `toolu_e${String(index)}`,
        join(f.workspaceRoot, `f${String(index)}.ts`),
      ),
    );
    records.push(result(`toolu_e${String(index)}`, "ok"));
  }
  appendFileSync(path, lines(...records));
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "Stop",
  });
  const full = service.brief(64 * 1024).recorded;
  assert.equal(full?.requests.length, 3);
  assert.equal(full.failures.length, 3);
  assert.equal(full.files.length, 5);
  for (let budget = 1024; budget <= 16384; budget += 256) {
    const brief = service.brief(budget);
    assert.ok(
      Buffer.byteLength(JSON.stringify(brief)) <= budget,
      String(budget),
    );
    // What the user asked for is the last entry to go.
    const others =
      brief.sessions.length +
      (brief.recorded?.failures.length ?? 0) +
      (brief.recorded?.files.length ?? 0);
    if (others > 0)
      assert.ok((brief.recorded?.requests.length ?? 0) > 0, String(budget));
  }
  const tight = service.brief(4096).recorded;
  assert.ok((tight?.requests.length ?? 0) >= 1);
  assert.equal(tight?.files.length, 0);
});

test("failure tails and texts stay within their bounds, multi-byte text included", () => {
  const { events, results } = extractTranscript(
    [
      bash("toolu_m", `echo ${"é".repeat(800)}`),
      result("toolu_m", `Exit code 1\n${"é".repeat(5000)}`, true),
      prompt("ü".repeat(4000)),
      say("ß".repeat(1000)),
    ],
    { root: "/w", now: 0, sidechain: false },
  );
  const tail = results[0]?.tail ?? "";
  assert.ok(Buffer.byteLength(tail) <= 1024, String(Buffer.byteLength(tail)));
  assert.ok(tail.startsWith("..."));
  assert.ok(!tail.includes("�"));
  const sizes = Object.fromEntries(
    events.map((event) => [event.kind, Buffer.byteLength(event.text)]),
  );
  assert.ok((sizes.command ?? 0) <= 1024);
  assert.ok((sizes.request ?? 0) <= 4096);
  assert.ok((sizes.reply ?? 0) <= 512);
});

test("the hook command reports a transcript it cannot read, without failing", (t) => {
  const f = fixture(t);
  const configPath = join(f.scratch, "state", "handoff.json");
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const run = (payload: Record<string, unknown>) => {
    let stderr = "";
    const code = runHandoffCli(["hook", "--config", configPath], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      stdin: () =>
        Buffer.from(
          JSON.stringify({
            cwd: f.workspaceRoot,
            session_id: "claude-9",
            ...payload,
          }),
        ),
    });
    return { code, stderr };
  };
  const good = join(f.transcripts, "good.jsonl");
  writeFileSync(good, lines(prompt("hello")), { mode: 0o600 });
  assert.deepEqual(
    run({
      transcript_path: good,
      hook_event_name: "SessionStart",
      source: "startup",
    }),
    { code: 0, stderr: "" },
  );
  assert.deepEqual(
    run({
      transcript_path: join(f.transcripts, "gone.jsonl"),
      hook_event_name: "Stop",
    }),
    { code: 0, stderr: "reprogate handoff hook: transcript_unreadable\n" },
  );
  // No transcript path at all is not a problem to report.
  assert.deepEqual(run({ hook_event_name: "Stop" }), { code: 0, stderr: "" });
});

test("published schemas accept recorder configuration, recorded briefs and event hits", (t) => {
  const f = fixture(t, { captureBytes: 2 * 1024 * 1024 });
  const ajv = new Ajv2020({ strict: true });
  for (const name of ["handoff-config", "handoff"])
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(`../../schemas/${name}.schema.json`, import.meta.url),
          ),
          "utf8",
        ),
      ) as object,
    );
  const base = "https://github.com/adimalkar/mcp-repro-gate/schemas/";
  const check = (ref: string, value: unknown) => {
    const validate = ajv.getSchema(`${base}${ref}`);
    assert.ok(validate, ref);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  };
  check("handoff-config.schema.json", f.config);
  const service = f.service();
  const path = join(f.transcripts, "schema.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  appendFileSync(
    path,
    lines(
      prompt("check the schema"),
      bash("toolu_x", "npm run schema"),
      result("toolu_x", "Exit code 3\nschema mismatch", true),
      edit("toolu_y", join(f.workspaceRoot, "s.json")),
      result("toolu_y", "ok"),
    ),
  );
  hook(service, f.workspaceRoot, {
    transcript_path: path,
    hook_event_name: "Stop",
  });
  const status = service.status({ handoffVersion: 1, brief: true });
  assert.equal(status.brief?.recorded?.failures.length, 1);
  check("handoff.schema.json#/$defs/status", status);
  const search = {
    handoffVersion: 1,
    query: "schema",
    kinds: ["command", "request"],
  };
  check("handoff.schema.json#/$defs/search", search);
  const found = service.search(search);
  assert.equal(found.hits.length, 2);
  check("handoff.schema.json#/$defs/searchResult", found);
});
