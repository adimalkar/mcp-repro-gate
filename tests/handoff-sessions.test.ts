import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHandoffService, type HandoffService } from "../src/handoff.js";
import { HandoffError } from "../src/handoff-contract.js";
import { fitBrief, renderBriefText } from "../src/handoff-brief.js";
import { runHandoffCli } from "../src/handoff-cli.js";
import { observeGit } from "../src/handoff-observe.js";
import { redactHandoffText } from "../src/handoff-redact.js";
import {
  MAX_NOTES_PER_SESSION,
  MAX_SESSIONS_PER_WORKSPACE,
} from "../src/handoff-session-contract.js";
import { createReproGateServer } from "../src/server.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const handoffModule = pathToFileURL(
  fileURLToPath(new URL("../src/handoff.js", import.meta.url)),
).href;

function fixture(t: TestContext, sessions: Record<string, unknown> = {}) {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-sessions-")),
  );
  const workspaceRoot = join(scratch, "workspace");
  const state = join(scratch, "state");
  mkdirSync(workspaceRoot, { mode: 0o755 });
  mkdirSync(state, { mode: 0o700 });
  const config = {
    configVersion: 1 as const,
    workspaceRoot,
    databasePath: join(state, "context.sqlite"),
    allowUpdates: true,
    sessions: { observeGit: false, ...sessions },
  };
  const configPath = join(state, "handoff.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  let time = Date.parse("2026-10-25T10:00:00.000Z");
  const clock = {
    now: () => new Date(time),
    advance: (seconds: number) => {
      time += seconds * 1000;
    },
  };
  const services: HandoffService[] = [];
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    for (const service of services) service.close();
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const service = (overrides: Record<string, unknown> = {}) => {
    const value = createHandoffService(
      { ...config, ...overrides },
      { now: clock.now },
    );
    services.push(value);
    return value;
  };
  const cli = (args: string[], stdin?: unknown) => {
    let stdout = "";
    let stderr = "";
    const code = runHandoffCli(args, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      now: clock.now,
      stdin: () =>
        Buffer.from(typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    });
    return { code, stdout, stderr };
  };
  const hook = (payload: Record<string, unknown>) =>
    cli(["hook", "--config", configPath], {
      cwd: workspaceRoot,
      session_id: "claude-1",
      ...payload,
    });
  return {
    scratch,
    workspaceRoot,
    config,
    configPath,
    clock,
    service,
    cli,
    hook,
    defer: (close: () => unknown) => closers.push(close),
  };
}

function git(root: string, ...args: string[]) {
  const result = spawnSync(
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
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof HandoffError && error.code === code;
}

test("a silent session reads as quiet, then interrupted, and a later note revives it", (t) => {
  const f = fixture(t, { leaseSeconds: 60, graceSeconds: 120 });
  const service = f.service();
  const { sessionId, leaseSeconds, brief } = service.join({
    handoffVersion: 1,
    agent: "codex",
    task: "Fix the parser",
  });
  assert.equal(leaseSeconds, 60);
  assert.equal(brief.sessions.length, 1);
  const state = () =>
    service.brief().sessions.find((s) => s.sessionId === sessionId)?.state;
  assert.equal(state(), "active");
  f.clock.advance(61);
  assert.equal(state(), "quiet");
  f.clock.advance(120);
  assert.equal(state(), "interrupted");
  service.note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "Back after a rate limit",
  });
  assert.equal(state(), "active");
  const ended = service.end({
    handoffVersion: 1,
    sessionId,
    summary: "Parser fixed",
  });
  assert.equal(ended.session.state, "ended");
  assert.equal(ended.session.endReason, "completed");
  assert.equal(ended.session.lastNote?.kind, "result");
  assert.throws(
    () =>
      service.note({
        handoffVersion: 1,
        sessionId,
        kind: "progress",
        text: "late",
      }),
    errorCode("session_ended"),
  );
  assert.throws(
    () => service.end({ handoffVersion: 1, sessionId }),
    errorCode("session_ended"),
  );
  assert.throws(
    () =>
      service.note({
        handoffVersion: 1,
        sessionId: "00000000-0000-4000-8000-000000000000",
        kind: "progress",
        text: "who",
      }),
    errorCode("unknown_session"),
  );
});

test("a closing connection ends the sessions it joined, and only those", (t) => {
  const f = fixture(t);
  const first = f.service();
  const own = first.join({ handoffVersion: 1, agent: "claude-code" });
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  first.close();
  const brief = f.service().brief();
  const mine = brief.sessions.find((s) => s.sessionId === own.sessionId);
  assert.equal(mine?.state, "ended");
  assert.equal(mine.endReason, "disconnected");
  const hooked = brief.sessions.find((s) => s.client === "claude-code");
  assert.equal(hooked?.state, "active");
});

test("a rate-limited Claude Code session is reported to the next session without a model call", (t) => {
  const f = fixture(t, { leaseSeconds: 60, graceSeconds: 60 });
  const start = f.hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.equal(start.code, 0);
  const output = JSON.parse(start.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  const sessionId = /handoff session is ([0-9a-f-]{36})/u.exec(
    output.hookSpecificOutput.additionalContext,
  )?.[1];
  assert.ok(sessionId);
  assert.equal(start.stderr, "");
  assert.deepEqual(
    f.hook({ hook_event_name: "UserPromptSubmit", prompt: "do the thing" }),
    { code: 0, stdout: "", stderr: "" },
  );
  f.service().note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "Half of the migration is done",
  });
  f.hook({
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
  });
  f.clock.advance(3600);
  const next = f.hook({
    hook_event_name: "SessionStart",
    session_id: "codex-takeover",
    source: "startup",
  });
  const context = (
    JSON.parse(next.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }
  ).hookSpecificOutput.additionalContext;
  assert.match(context, /stopped on rate_limit 60 min ago/u);
  assert.match(context, /last note \(progress\): Half of the migration/u);
  assert.ok(context.length <= 10_000);
  // The prompt text itself is never stored.
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  f.defer(() => {
    db.close();
  });
  const dump = JSON.stringify(
    db.prepare("SELECT * FROM handoff_sessions").all(),
  );
  assert.equal(dump.includes("do the thing"), false);
});

test("a finished turn reads as waiting for input, not interrupted", (t) => {
  const f = fixture(t, { leaseSeconds: 60, graceSeconds: 60 });
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  f.hook({ hook_event_name: "UserPromptSubmit", prompt: "x" });
  f.hook({ hook_event_name: "Stop", last_assistant_message: "Done." });
  f.clock.advance(7200);
  const [session] = f.service().brief().sessions;
  assert.equal(session?.state, "idle");
  // Messages are not collected unless the host opts in.
  assert.equal(session.lastMessage, null);
  f.hook({ hook_event_name: "UserPromptSubmit", prompt: "y" });
  f.clock.advance(7200);
  assert.equal(f.service().brief().sessions[0]?.state, "interrupted");
});

test("subagents get their own sessions, a short context and a recorded result when opted in", (t) => {
  const f = fixture(t, { captureMessages: true });
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  const children: string[] = [];
  for (let index = 0; index < 20; index++) {
    const started = f.hook({
      hook_event_name: "SubagentStart",
      agent_id: `agent-${String(index)}`,
      agent_type: "Explore",
    });
    const context = (
      JSON.parse(started.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      }
    ).hookSpecificOutput.additionalContext;
    assert.ok(context.length < 2000, "subagents get a short context");
    const id = /session is ([0-9a-f-]{36})/u.exec(context)?.[1];
    assert.ok(id);
    children.push(id);
  }
  assert.equal(new Set(children).size, 20);
  f.hook({
    hook_event_name: "SubagentStop",
    agent_id: "agent-3",
    agent_type: "Explore",
    last_assistant_message:
      "Found it. token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  const brief = f.service().brief(65536);
  const parent = brief.sessions.find((s) => s.kind === "agent");
  const subagents = brief.sessions.filter((s) => s.kind === "subagent");
  assert.equal(subagents.length, 20);
  assert.ok(subagents.every((s) => s.parentSessionId === parent?.sessionId));
  const stopped = subagents.find((s) => s.state === "ended");
  assert.equal(stopped?.endReason, "subagent_stopped");
  assert.equal(stopped.agent, "Explore");
  assert.match(
    stopped.lastNote?.text ?? "",
    /^Found it\. token \[REDACTED\]$/u,
  );
});

test("SessionEnd ends the session with the client's reason and is idempotent", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  for (const reason of ["prompt_input_exit", "other"])
    assert.deepEqual(f.hook({ hook_event_name: "SessionEnd", reason }), {
      code: 0,
      stdout: "",
      stderr: "",
    });
  const [session] = f.service().brief().sessions;
  assert.equal(session?.state, "ended");
  assert.equal(session.endReason, "client_ended");
  assert.equal(session.clientReason, "prompt_input_exit");
  // Resuming the same client session revives it.
  f.hook({ hook_event_name: "SessionStart", source: "resume" });
  assert.equal(f.service().brief().sessions[0]?.state, "active");
  assert.equal(f.service().brief().sessions.length, 1);
});

test("hooks ignore other projects, malformed payloads and oversized input, and never block", (t) => {
  const f = fixture(t);
  const elsewhere = mkdtempSync(join(f.scratch, "other-"));
  assert.deepEqual(
    f.hook({ hook_event_name: "SessionStart", cwd: elsewhere }),
    { code: 0, stdout: "", stderr: "" },
  );
  assert.equal(
    f.hook({ hook_event_name: "SessionStart", session_id: "../x" }).stdout,
    "",
  );
  const garbage = f.cli(["hook", "--config", f.configPath], "{not json");
  assert.equal(garbage.code, 0);
  assert.match(garbage.stderr, /invalid_payload/u);
  let hugeError = "";
  const huge = runHandoffCli(["hook", "--config", f.configPath], {
    now: f.clock.now,
    stdout: () => undefined,
    stderr: (text) => {
      hugeError += text;
    },
    stdin: () => undefined,
  });
  assert.equal(huge, 0);
  assert.match(hugeError, /payload_too_large/u);
  assert.equal(f.service().brief().sessions.length, 0);
  // Claude Code treats exit code 2 as "block", so even command-line misuse
  // exits 1: a typo in a user-level hook must not block every prompt.
  for (const args of [
    ["hook"],
    ["hook", "--config", f.configPath, "--client", "x"],
    ["hook", "--config", f.configPath, "--unknown-flag"],
    ["hook", "--config", f.configPath, "extra"],
    ["hok", "--config", f.configPath],
    ["brief", "--bytes", "1"],
  ])
    assert.equal(f.cli(args).code, 1, args.join(" "));
  // A read-only configuration records nothing.
  const readOnlyPath = join(f.scratch, "state", "read-only.json");
  writeFileSync(
    readOnlyPath,
    JSON.stringify({ ...f.config, allowUpdates: false }),
    { mode: 0o600 },
  );
  const readOnly = f.cli(["hook", "--config", readOnlyPath], {
    cwd: f.workspaceRoot,
    session_id: "s",
    hook_event_name: "SessionStart",
  });
  assert.equal(readOnly.code, 1);
  assert.match(readOnly.stderr, /read_only/u);
});

test("a hook from another project never opens or creates the database", (t) => {
  const f = fixture(t);
  const fresh = join(f.scratch, "state", "fresh.sqlite");
  const freshConfig = join(f.scratch, "state", "fresh.json");
  writeFileSync(
    freshConfig,
    JSON.stringify({ ...f.config, databasePath: fresh }),
    { mode: 0o600 },
  );
  const result = f.cli(["hook", "--config", freshConfig], {
    cwd: f.scratch,
    session_id: "elsewhere",
    hook_event_name: "SessionStart",
  });
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.equal(existsSync(fresh), false);
});

test("a session that hit a rate limit stays failed after the user quits, and outlives ended sessions", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  f.hook({ hook_event_name: "StopFailure", error: "rate_limit" });
  f.hook({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  const service = f.service();
  const [session] = service.brief().sessions;
  assert.equal(session?.state, "failed");
  assert.equal(session.endReason, "client_ended");
  assert.match(
    service.briefText(),
    /stopped on rate_limit 0s ago, then ended \(client_ended: prompt_input_exit\); its work may be unfinished/u,
  );
  // A normal end after the session resumed clears the failure.
  const { sessionId } = service.join({ handoffVersion: 1, agent: "ok" });
  service.end({ handoffVersion: 1, sessionId });
  // Fill the workspace with ended sessions; pruning drops them first.
  for (let index = 0; index < MAX_SESSIONS_PER_WORKSPACE; index++) {
    const joined = service.join({
      handoffVersion: 1,
      agent: `filler${String(index)}`,
    });
    service.end({ handoffVersion: 1, sessionId: joined.sessionId });
    f.clock.advance(1);
  }
  f.clock.advance(120);
  service.join({ handoffVersion: 1, agent: "last" });
  assert.ok(
    service
      .brief(65536)
      .sessions.some(
        (candidate) =>
          candidate.state === "failed" && candidate.client === "claude-code",
      ),
  );
});

test("pruning never drops the parent being joined or a session seen in the last minute", (t) => {
  const f = fixture(t);
  const service = f.service();
  const parent = service.join({ handoffVersion: 1, agent: "parent" });
  service.end({ handoffVersion: 1, sessionId: parent.sessionId });
  f.clock.advance(3600);
  const recent: string[] = [];
  for (let index = 1; index < MAX_SESSIONS_PER_WORKSPACE; index++) {
    const joined = service.join({
      handoffVersion: 1,
      agent: `s${String(index)}`,
    });
    service.end({ handoffVersion: 1, sessionId: joined.sessionId });
    recent.push(joined.sessionId);
  }
  // The table is full; the oldest ended session is the parent itself.
  const child = service.join({
    handoffVersion: 1,
    agent: "child",
    parentSessionId: parent.sessionId,
  });
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  f.defer(() => {
    db.close();
  });
  const ids = new Set(
    db
      .prepare("SELECT session_id FROM handoff_sessions")
      .all()
      .map((row) => row.session_id),
  );
  assert.ok(ids.has(parent.sessionId));
  assert.ok(ids.has(child.sessionId));
  // Everything else was seen within the last minute, so nothing was pruned.
  assert.ok(recent.every((id) => ids.has(id)));
  assert.equal(ids.size, MAX_SESSIONS_PER_WORKSPACE + 1);
});

test("a resumed subagent and a prompted ended session are reopened, and Stop after an end changes nothing", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  const start = () =>
    /session is ([0-9a-f-]{36})/u.exec(
      f.hook({
        hook_event_name: "SubagentStart",
        agent_id: "agent-7",
        agent_type: "Plan",
      }).stdout,
    )?.[1];
  const first = start();
  f.hook({
    hook_event_name: "SubagentStop",
    agent_id: "agent-7",
    agent_type: "Plan",
  });
  const second = start();
  assert.ok(first !== undefined && first === second);
  const service = f.service();
  assert.equal(
    service.note({
      handoffVersion: 1,
      sessionId: second,
      kind: "progress",
      text: "resumed work",
    }).session.state,
    "active",
  );
  f.hook({ hook_event_name: "SessionEnd", reason: "other" });
  const late = f.hook({ hook_event_name: "Stop" });
  assert.deepEqual(late, { code: 0, stdout: "", stderr: "" });
  const main = () =>
    f
      .service()
      .brief()
      .sessions.find((s) => s.kind === "agent");
  assert.equal(main()?.state, "ended");
  assert.deepEqual(
    f.hook({ hook_event_name: "UserPromptSubmit", prompt: "again" }),
    { code: 0, stdout: "", stderr: "" },
  );
  assert.equal(main()?.state, "active");
});

test("internal agents that never started do not become subagent sessions", (t) => {
  const f = fixture(t, { captureMessages: true });
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  for (const agent_id of ["suggest-1", "btw-2"])
    f.hook({
      hook_event_name: "SubagentStop",
      agent_id,
      agent_type: "",
      last_assistant_message: "internal",
    });
  f.hook({ hook_event_name: "SubagentStart", agent_id: "x", agent_type: "" });
  f.hook({ hook_event_name: "PreCompact", agent_id: "ghost", trigger: "auto" });
  const sessions = f.service().brief().sessions;
  assert.deepEqual(
    sessions.map((s) => s.kind),
    ["agent"],
  );
});

test("credential-shaped labels are refused or replaced, and huge captured replies stay fast", (t) => {
  const f = fixture(t, { captureMessages: true });
  const service = f.service();
  assert.throws(
    () =>
      service.join({
        handoffVersion: 1,
        agent: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
    errorCode("invalid_input"),
  );
  assert.throws(
    () =>
      service.join({ handoffVersion: 1, agent: "a", task: "esc \u001b[2J" }),
    errorCode("invalid_input"),
  );
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  f.hook({
    hook_event_name: "SubagentStart",
    agent_id: "a1",
    agent_type: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  f.hook({
    hook_event_name: "StopFailure",
    error: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  const started = performance.now();
  f.hook({
    hook_event_name: "Stop",
    last_assistant_message: "-eyJ".repeat(256 * 1024),
  });
  assert.ok(performance.now() - started < 2000);
  const sessions = f.service().brief(65536).sessions;
  assert.equal(sessions.find((s) => s.kind === "subagent")?.agent, "subagent");
  const dump = JSON.stringify(sessions);
  assert.equal(dump.includes("ghp_"), false);
  assert.ok(
    Buffer.byteLength(
      sessions.find((s) => s.kind === "agent")?.lastMessage ?? "",
    ) <= 1024,
  );
});

test("Codex lifecycle hooks on standard input are recorded under the codex client", (t) => {
  const f = fixture(t);
  const codex = (payload: Record<string, unknown>) =>
    f.cli(["hook", "--config", f.configPath, "--client", "codex"], {
      cwd: f.workspaceRoot,
      session_id: "019a-thread",
      ...payload,
    });
  const started = codex({ hook_event_name: "SessionStart", source: "startup" });
  assert.match(started.stdout, /"hookEventName":"SessionStart"/u);
  codex({ hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "x" });
  codex({ hook_event_name: "Interrupt", turn_id: "t1" });
  const [session] = f.service().brief().sessions;
  assert.equal(session?.client, "codex");
  assert.equal(session.agent, "codex");
  assert.equal(session.state, "idle");
});

test("Codex turn notifications track a thread from the command-line payload", (t) => {
  const f = fixture(t, { captureMessages: true });
  const payload = {
    type: "agent-turn-complete",
    "thread-id": "thread-42",
    "turn-id": "turn-1",
    cwd: f.workspaceRoot,
    "input-messages": ["refactor it"],
    "last-assistant-message": "Refactored the module.",
  };
  const result = f.cli([
    "hook",
    "--config",
    f.configPath,
    "--client",
    "codex",
    JSON.stringify(payload),
  ]);
  assert.equal(result.code, 0);
  const [session] = f.service().brief().sessions;
  assert.equal(session?.client, "codex");
  assert.equal(session.state, "idle");
  assert.equal(session.lastMessage, "Refactored the module.");
});

test("notes from many processes at once all land without conflicts", async (t) => {
  const f = fixture(t);
  f.service();
  const script = `
    import { createHandoffService } from ${JSON.stringify(handoffModule)};
    const service = createHandoffService(JSON.parse(process.argv[1]));
    const { sessionId } = service.join({ handoffVersion: 1, agent: "worker" });
    for (let i = 0; i < 10; i++)
      service.note({ handoffVersion: 1, sessionId, kind: "progress", text: "step " + i });
    service.end({ handoffVersion: 1, sessionId });
    service.close();
  `;
  const workers = Array.from({ length: 8 }, () => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(f.config)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    return once(child, "exit").then(([code]) => {
      assert.equal(code, 0, stderr);
    });
  });
  await Promise.all(workers);
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  f.defer(() => {
    db.close();
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM handoff_notes").get()?.n,
    80,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM handoff_sessions WHERE end_reason = 'completed'",
      )
      .get()?.n,
    8,
  );
});

test("lanes and session history stay bounded and say how much was dropped", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "busy" });
  for (let index = 0; index < MAX_NOTES_PER_SESSION + 10; index++)
    service.note({
      handoffVersion: 1,
      sessionId,
      kind: "progress",
      text: `step ${String(index)}`,
    });
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  f.defer(() => {
    db.close();
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM handoff_notes").get()?.n,
    MAX_NOTES_PER_SESSION,
  );
  const view = service.brief().sessions.find((s) => s.sessionId === sessionId);
  assert.equal(view?.notes, MAX_NOTES_PER_SESSION + 10);
  assert.equal(
    view.lastNote?.text,
    `step ${String(MAX_NOTES_PER_SESSION + 9)}`,
  );
  for (let index = 0; index < MAX_SESSIONS_PER_WORKSPACE + 5; index++) {
    f.clock.advance(120);
    service.join({ handoffVersion: 1, agent: `a${String(index)}` });
  }
  assert.ok(
    Number(db.prepare("SELECT count(*) AS n FROM handoff_sessions").get()?.n) <=
      MAX_SESSIONS_PER_WORKSPACE,
  );
});

test("briefs fit their byte and character budgets and count what they leave out", (t) => {
  const f = fixture(t);
  const service = f.service();
  for (let index = 0; index < 40; index++) {
    const { sessionId } = service.join({
      handoffVersion: 1,
      agent: `agent-${String(index)}`,
      task: "x".repeat(400),
    });
    service.note({
      handoffVersion: 1,
      sessionId,
      kind: "blocker",
      text: `blocked on ${"y".repeat(1500)}`,
    });
  }
  const brief = service.brief(4096);
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 4096);
  assert.ok(brief.omittedSessions > 0);
  assert.ok(brief.omittedNotes > 0);
  const text = service.briefText(3000);
  assert.ok(text.length <= 3000, String(text.length));
  assert.match(text, /more not shown/u);
  // A budget too small for even one entry still returns a valid brief.
  const tiny = fitBrief(
    service.brief(65536),
    10,
    (value) => renderBriefText(value).length,
  );
  assert.ok(tiny.sessions.length <= 1);
});

test("known credential shapes are redacted from notes and the count is reported", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "paster" });
  const result = service.note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "used ghp_abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP and https://user:hunter2@example.com/x",
  });
  assert.equal(result.redactions, 3);
  assert.equal(
    result.session.lastNote?.text,
    "used [REDACTED] and [REDACTED] and [REDACTED]example.com/x",
  );
  assert.deepEqual(redactHandoffText("plain text, sk-short"), {
    text: "plain text, sk-short",
    redactions: 0,
  });
  const key = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAA",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  assert.equal(
    redactHandoffText(`key:\n${key}\nafter`).text,
    "key:\n[REDACTED]\nafter",
  );
  // Linear on hostile input.
  const started = performance.now();
  redactHandoffText(`${"Bearer ".repeat(5000)}${"-".repeat(50_000)}`);
  assert.ok(performance.now() - started < 1000);
});

test("Git observation reports branch, changes, an operation in progress and commits since the last session", (t) => {
  const f = fixture(t, { observeGit: true });
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "first");
  const service = f.service();
  service.join({ handoffVersion: 1, agent: "first" });
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "commit", "-q", "-am", "second: fix parser");
  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "a.txt"), "feature\n");
  git(root, "commit", "-q", "-am", "feature change");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "a.txt"), "main\n");
  git(root, "commit", "-q", "-am", "main change");
  spawnSync("git", [
    "-C",
    root,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e.invalid",
    "merge",
    "feature",
  ]);
  writeFileSync(join(root, "new file.txt"), "untracked\n");
  const { brief } = service.join({ handoffVersion: 1, agent: "second" });
  const observed = brief.git;
  assert.equal(observed.state, "observed");
  assert.equal(observed.branch, "main");
  assert.equal(observed.operation, "merge");
  assert.equal(observed.changes.conflicted, 1);
  assert.equal(observed.changes.untracked, 1);
  assert.ok(
    observed.paths.some((p) => p.path === "new file.txt" && p.status === "??"),
  );
  assert.equal(observed.commitsSince?.count, 2);
  assert.match(
    observed.commitsSince.subjects.join("\n"),
    /second: fix parser/u,
  );
  const text = service.briefText();
  assert.match(text, /A merge is in progress/u);
  // Observation never touched the index or worktree.
  assert.match(git(root, "status", "--porcelain"), /^UU a\.txt/mu);
});

test("Git observation is unavailable outside a repository and absent when turned off", (t) => {
  const f = fixture(t, { observeGit: true });
  assert.equal(f.service().brief().git.state, "unavailable");
  const g = fixture(t, { observeGit: false });
  assert.equal(g.service().brief().git.state, "disabled");
});

test("a detached HEAD is reported as detached", (t) => {
  const f = fixture(t, { observeGit: true });
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "first");
  git(root, "checkout", "-q", "--detach");
  const observed = f.service().brief().git;
  assert.equal(observed.detached, true);
  assert.equal(observed.branch, null);
  assert.match(observed.head ?? "", /^[0-9a-f]{40,64}$/u);
});

test("MCP clients get session tools, server instructions and a brief from status", async (t) => {
  const f = fixture(t);
  const service = f.service();
  const server = createReproGateServer(undefined, undefined, service);
  const client = new Client({ name: "sessions", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  f.defer(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  assert.match(client.getInstructions() ?? "", /handoff_note/u);
  const joined = await client.callTool({
    name: "handoff_join",
    arguments: { handoffVersion: 1, agent: "claude-code" },
  });
  assert.equal(joined.isError, undefined);
  const sessionId = (joined.structuredContent as { sessionId: string })
    .sessionId;
  const noted = await client.callTool({
    name: "handoff_note",
    arguments: {
      handoffVersion: 1,
      sessionId,
      kind: "decision",
      text: "Use WAL",
    },
  });
  assert.equal(noted.isError, undefined);
  const status = await client.callTool({
    name: "handoff_status",
    arguments: { handoffVersion: 1, brief: true },
  });
  const brief = (status.structuredContent as { brief: { notes: unknown[] } })
    .brief;
  assert.equal(brief.notes.length, 1);
  const bad = await client.callTool({
    name: "handoff_note",
    arguments: {
      handoffVersion: 1,
      sessionId: "00000000-0000-4000-8000-000000000000",
      kind: "progress",
      text: "x",
    },
  });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.content), /unknown_session/u);

  const readOnly = createReproGateServer(
    undefined,
    undefined,
    f.service({ allowUpdates: false }),
  );
  const viewer = new Client({ name: "viewer", version: "1.0.0" });
  const [c, d] = InMemoryTransport.createLinkedPair();
  f.defer(async () => {
    await viewer.close();
    await readOnly.close();
  });
  await readOnly.connect(d);
  await viewer.connect(c);
  assert.deepEqual(
    (await viewer.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("handoff")),
    ["handoff_status"],
  );
  assert.equal(viewer.getInstructions(), undefined);
});

test("the compiled CLI records a hook from standard input and prints a brief", (t) => {
  const f = fixture(t);
  const hook = spawnSync(
    process.execPath,
    [cliPath, "handoff", "hook", "--config", f.configPath],
    {
      input: JSON.stringify({
        cwd: f.workspaceRoot,
        session_id: "real-1",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stdout, /"hookEventName":"SessionStart"/u);
  const brief = spawnSync(
    process.execPath,
    [cliPath, "handoff", "brief", "--config", f.configPath],
    { encoding: "utf8" },
  );
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(
    brief.stdout,
    /claude-code \(claude-code, [0-9a-f]{8}\): active/u,
  );
  const json = spawnSync(
    process.execPath,
    [
      cliPath,
      "handoff",
      "brief",
      "--config",
      f.configPath,
      "--json",
      "--bytes",
      "2048",
    ],
    { encoding: "utf8" },
  );
  assert.equal(json.status, 0, json.stderr);
  assert.ok(Buffer.byteLength(json.stdout) <= 2049);
});

test("published schemas accept session values", (t) => {
  const f = fixture(t, { observeGit: true });
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
  const join = { handoffVersion: 1, agent: "codex", task: "t" };
  check("handoff.schema.json#/$defs/join", join);
  const joined = service.join(join);
  check("handoff.schema.json#/$defs/joinResult", joined);
  const note = {
    handoffVersion: 1,
    sessionId: joined.sessionId,
    kind: "blocker",
    text: "stuck",
  };
  check("handoff.schema.json#/$defs/note", note);
  check("handoff.schema.json#/$defs/sessionResult", service.note(note));
  check(
    "handoff.schema.json#/$defs/status",
    service.status({ handoffVersion: 1, brief: true }),
  );
  const end = { handoffVersion: 1, sessionId: joined.sessionId, summary: "ok" };
  check("handoff.schema.json#/$defs/end", end);
  check("handoff.schema.json#/$defs/sessionResult", service.end(end));
});

test("briefs keep every budget, even with long escaped notes, and flag what was cut", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({
    handoffVersion: 1,
    agent: "quoter",
    task: "t".repeat(512),
  });
  service.note({
    handoffVersion: 1,
    sessionId,
    kind: "blocker",
    text: '"'.repeat(2048),
  });
  for (const budget of [1024, 2048, 4096]) {
    const brief = service.brief(budget);
    assert.ok(
      Buffer.byteLength(JSON.stringify(brief)) <= budget,
      String(budget),
    );
    assert.equal(brief.truncated, true);
  }
  const status = service.status({
    handoffVersion: 1,
    brief: true,
    briefBytes: 1024,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(status.brief)) <= 1024);
  assert.ok(service.briefText(1500).length <= 1500);
  // Without pressure nothing is cut, and omissions are exact.
  for (let index = 0; index < 29; index++)
    service.join({ handoffVersion: 1, agent: `a${String(index)}` });
  const roomy = service.brief(65536);
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.sessions.length, 24);
  assert.equal(roomy.omittedSessions, 6);
  assert.equal(roomy.omittedNotes, 0);
});

test("commits since the oldest unfinished agent session are shown, whatever joined later", (t) => {
  const f = fixture(t, {
    observeGit: true,
    leaseSeconds: 60,
    graceSeconds: 60,
  });
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base");
  const service = f.service();
  const a = service.join({ handoffVersion: 1, agent: "a" });
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "commit", "-q", "-am", "work by a");
  service.join({
    handoffVersion: 1,
    agent: "helper",
    parentSessionId: a.sessionId,
  });
  f.clock.advance(30);
  service.join({ handoffVersion: 1, agent: "b" });
  f.clock.advance(600);
  const { brief } = service.join({ handoffVersion: 1, agent: "c" });
  assert.equal(brief.git.commitsSince?.count, 1);
  assert.match(brief.git.commitsSince.subjects[0] ?? "", /work by a/u);
});

test("Git observation detects a rebase, reports renames once and escapes control characters in paths", (t) => {
  const f = fixture(t, { observeGit: true });
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "base\n");
  writeFileSync(join(root, "old name.txt"), "rename me\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "topic");
  writeFileSync(join(root, "a.txt"), "topic\n");
  git(root, "commit", "-q", "-am", "topic");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "a.txt"), "main\n");
  git(root, "commit", "-q", "-am", "main");
  git(root, "checkout", "-q", "topic");
  spawnSync("git", [
    "-C",
    root,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e.invalid",
    "rebase",
    "main",
  ]);
  git(root, "mv", "old name.txt", "new name.txt");
  writeFileSync(join(root, "evil\u001b[2Jname.txt"), "x\n");
  const observed = f.service().brief(65536).git;
  assert.equal(observed.operation, "rebase");
  const renamed = observed.paths.filter((p) => p.path.includes("name.txt"));
  assert.deepEqual(renamed.map((p) => p.path).sort(), [
    "evil�[2Jname.txt",
    "new name.txt",
  ]);
  assert.match(
    f.service().briefText(),
    /^Attention: a rebase is in progress/mu,
  );
});

test("an invalid base never reaches Git as an argument", (t) => {
  const f = fixture(t, { observeGit: true });
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base");
  const target = join(f.scratch, "written-by-git");
  const observed = observeGit(root, `--output=${target}`);
  assert.equal(observed.state, "observed");
  assert.equal(observed.commitsSince, null);
  assert.equal(existsSync(target), false);
});

test("every handoff module loads on its own", () => {
  for (const name of [
    "handoff-session-contract",
    "handoff-observe",
    "handoff-brief",
    "handoff-sessions",
    "handoff-redact",
    "handoff-contract",
    "handoff-cli",
  ]) {
    const url = new URL(`../src/${name}.js`, import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("a read-only configuration refuses session writes", (t) => {
  const f = fixture(t);
  const service = f.service({ allowUpdates: false });
  const id = "00000000-0000-4000-8000-000000000000";
  assert.throws(
    () => service.join({ handoffVersion: 1, agent: "x" }),
    errorCode("read_only"),
  );
  assert.throws(
    () =>
      service.note({
        handoffVersion: 1,
        sessionId: id,
        kind: "progress",
        text: "x",
      }),
    errorCode("read_only"),
  );
  assert.throws(
    () => service.end({ handoffVersion: 1, sessionId: id }),
    errorCode("read_only"),
  );
  assert.equal(service.brief().sessions.length, 0);
});
