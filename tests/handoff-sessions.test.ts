import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID as randomUUIDv4 } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  createHandoffService,
  writeProjection,
  type HandoffService,
} from "../src/handoff.js";
import { HandoffError } from "../src/handoff-contract.js";
import { buildBrief, fitBrief, renderBriefText } from "../src/handoff-brief.js";
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
  const service = (
    overrides: Record<string, unknown> = {},
    options: { deferProjection?: boolean } = {},
  ) => {
    const value = createHandoffService(
      { ...config, ...overrides },
      { now: clock.now, ...options },
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
  const service = f.service();
  const brief = service.brief(65536);
  // Healthy subagents are folded into their parent's counts.
  assert.deepEqual(
    brief.sessions.map((s) => s.kind),
    ["agent"],
  );
  const parent = brief.sessions[0];
  assert.deepEqual(parent?.subagents, {
    active: 19,
    idle: 0,
    quiet: 0,
    interrupted: 0,
    failed: 0,
    ended: 1,
  });
  assert.match(service.briefText(), /subagents: 19 active, 1 ended/u);
  // The parent's lane lists every subagent.
  const lane = service.status({
    handoffVersion: 1,
    sessionId: parent.sessionId,
    briefBytes: 65536,
  }).lane;
  assert.ok(lane);
  const subagents = lane.subagents;
  assert.equal(subagents.length, 20);
  assert.ok(subagents.every((s) => s.parentSessionId === parent.sessionId));
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
  const reader = f.service();
  const sessions = reader.brief(65536).sessions;
  const lane = reader.status({
    handoffVersion: 1,
    sessionId: sessions.find((s) => s.kind === "agent")?.sessionId ?? "",
  }).lane;
  assert.equal(lane?.subagents[0]?.agent, "subagent");
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

test("the ledger refuses activity and notes on an ended session", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "done" });
  service.end({ handoffVersion: 1, sessionId });
  const db = new DatabaseSync(f.config.databasePath, { readOnly: true });
  f.defer(() => {
    db.close();
  });
  const workspaceId = String(
    db.prepare("SELECT workspace_id FROM handoff_sessions").get()?.workspace_id,
  );
  const ledger = service.store.handoffSessions();
  assert.throws(
    () => ledger.touch(workspaceId, sessionId, Date.now()),
    errorCode("session_ended"),
  );
  assert.throws(
    () =>
      ledger.note(workspaceId, sessionId, "progress", "late", 0, Date.now()),
    errorCode("session_ended"),
  );
});

test("the skeleton fits 1 KiB even when every text is quote-heavy and counts are large", () => {
  const quotes = '"\\'.repeat(1024);
  const brief = buildBrief({
    now: Date.parse("2026-10-30T00:00:00Z"),
    liveness: { leaseMs: 1, graceMs: 1 },
    latest: undefined,
    sessions: [],
    lastNotes: new Map(),
    notes: [],
    git: {
      state: "observed",
      branch: quotes,
      head: "a".repeat(64),
      detached: false,
      upstream: quotes,
      ahead: 999_999_999,
      behind: 999_999_999,
      operation: "cherry_pick",
      changes: {
        staged: 999_999_999,
        unstaged: 999_999_999,
        untracked: 999_999_999,
        conflicted: 999_999_999,
      },
      paths: [],
      omittedPaths: 999_999_999,
      commitsSince: null,
    },
  });
  brief.handoff.goal = quotes;
  brief.handoff.activeAgent = "a".repeat(64);
  brief.handoff.revision = 9_007_199_254_740_990;
  brief.omittedSessions = 256;
  brief.omittedNotes = 999_999;
  const fitted = fitBrief(brief, 1024, (value) =>
    Buffer.byteLength(JSON.stringify(value)),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 1024);
  assert.equal(fitted.truncated, true);
});

test("an idle session never pins the commits-since base", (t) => {
  const f = fixture(t, { observeGit: true });
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "0\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base");
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  f.hook({ hook_event_name: "Stop" });
  const service = f.service();
  for (let index = 1; index <= 3; index++) {
    f.clock.advance(60);
    const { sessionId } = service.join({ handoffVersion: 1, agent: "w" });
    writeFileSync(join(root, "a.txt"), `${String(index)}\n`);
    git(root, "commit", "-q", "-am", `step ${String(index)}`);
    service.end({ handoffVersion: 1, sessionId });
  }
  f.clock.advance(60);
  const { brief } = service.join({ handoffVersion: 1, agent: "next" });
  assert.equal(brief.git.commitsSince?.count, 1);
  assert.match(brief.git.commitsSince.subjects[0] ?? "", /step 3/u);
});

test("only a new prompt or note clears a reported failure", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  f.hook({ hook_event_name: "StopFailure", error: "overloaded" });
  f.hook({ hook_event_name: "PreCompact", trigger: "auto" });
  f.hook({ hook_event_name: "Stop" });
  f.hook({ hook_event_name: "SessionEnd", reason: "other" });
  const state = () => f.service().brief().sessions[0]?.state;
  assert.equal(state(), "failed");
  f.hook({ hook_event_name: "UserPromptSubmit", prompt: "retry" });
  assert.equal(state(), "active");
  // A session that completes normally is ended, whatever failed earlier.
  f.hook({ hook_event_name: "StopFailure", error: "rate_limit" });
  const sessionId = f.service().brief().sessions[0]?.sessionId ?? "";
  f.service().end({ handoffVersion: 1, sessionId });
  assert.equal(state(), "ended");
});

test("a late Codex notification never reopens an ended session", (t) => {
  const f = fixture(t);
  const codex = (payload: Record<string, unknown>) =>
    f.cli(["hook", "--config", f.configPath, "--client", "codex"], {
      cwd: f.workspaceRoot,
      session_id: "thread-9",
      ...payload,
    });
  codex({ hook_event_name: "SessionStart", source: "startup" });
  codex({ hook_event_name: "SessionEnd", reason: "other" });
  f.cli([
    "hook",
    "--config",
    f.configPath,
    "--client",
    "codex",
    JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "thread-9",
      cwd: f.workspaceRoot,
    }),
  ]);
  f.clock.advance(30 * 86_400);
  assert.equal(f.service().brief().sessions[0]?.state, "ended");
});

test("rows a later version wrote with unknown values are skipped, not fatal", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "known" });
  const db = new DatabaseSync(f.config.databasePath);
  f.defer(() => {
    db.close();
  });
  const workspaceId = String(
    db.prepare("SELECT workspace_id FROM handoff_sessions").get()?.workspace_id,
  );
  db.prepare(
    `INSERT INTO handoff_sessions(session_id, workspace_id, client, client_session, client_agent,
      agent, kind, started_at, last_seen_at) VALUES(?, ?, 'gemini', 'g', '', 'gemini', 'agent', 1, 1)`,
  ).run("11111111-1111-4111-8111-111111111111", workspaceId);
  db.prepare(
    "INSERT INTO handoff_notes(session_id, kind, text, redactions, created_at) VALUES(?, 'question', 'q', 0, 2)",
  ).run(sessionId);
  const brief = service.brief();
  assert.deepEqual(
    brief.sessions.map((s) => s.agent),
    ["known"],
  );
  assert.equal(brief.sessions[0]?.lastNote, null);
  assert.match(service.briefText(), /known/u);
});

test("subagents that need attention stay visible beside their parent's counts", (t) => {
  const f = fixture(t, { leaseSeconds: 60, graceSeconds: 60 });
  const service = f.service();
  const parent = service.join({ handoffVersion: 1, agent: "lead" });
  const join = (agent: string) =>
    service.join({
      handoffVersion: 1,
      agent,
      parentSessionId: parent.sessionId,
    }).sessionId;
  join("stuck");
  const done = join("done");
  service.end({ handoffVersion: 1, sessionId: done });
  f.clock.advance(300);
  join("live");
  service.note({
    handoffVersion: 1,
    sessionId: parent.sessionId,
    kind: "progress",
    text: "x",
  });
  const brief = service.brief(65536);
  assert.deepEqual(brief.sessions.map((s) => s.agent).sort(), [
    "lead",
    "stuck",
  ]);
  assert.equal(
    brief.sessions.find((s) => s.agent === "stuck")?.state,
    "interrupted",
  );
  // Listed subagents are not counted again: each session appears once.
  assert.deepEqual(brief.sessions.find((s) => s.agent === "lead")?.subagents, {
    active: 1,
    idle: 0,
    quiet: 0,
    interrupted: 0,
    failed: 0,
    ended: 1,
  });
});

test("a lane returns one session in full within its budget, counting what it leaves out", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "busy" });
  for (let index = 0; index < 80; index++)
    service.note({
      handoffVersion: 1,
      sessionId,
      kind: "progress",
      text: `step ${String(index)} ${"z".repeat(200)}`,
    });
  const roomy = service.status({
    handoffVersion: 1,
    sessionId,
    briefBytes: 65536,
  }).lane;
  assert.equal(roomy?.notes.length, 64);
  assert.equal(roomy.omittedNotes, 16);
  assert.match(roomy.notes[0]?.text ?? "", /^step 79 /u);
  const tight = service.status({
    handoffVersion: 1,
    sessionId,
    briefBytes: 2048,
  }).lane;
  assert.ok(Buffer.byteLength(JSON.stringify(tight)) <= 2048);
  assert.ok((tight?.omittedNotes ?? 0) > 16);
  assert.throws(
    () =>
      service.status({
        handoffVersion: 1,
        sessionId: "00000000-0000-4000-8000-000000000000",
      }),
    errorCode("unknown_session"),
  );
});

test("the sessions file is written at once for lifecycle events and coalesced for notes", (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 60 });
  const service = f.service({}, { deferProjection: false });
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  const { sessionId } = service.join({ handoffVersion: 1, agent: "writer" });
  assert.equal(statSync(join(f.workspaceRoot, ".agent")).mode & 0o777, 0o700);
  const first = readFileSync(file, "utf8");
  assert.match(first, /^# Agent Sessions\n/u);
  assert.match(first, /do not edit it/u);
  assert.equal(service.status({ handoffVersion: 1 }).sessionsFile, "written");
  service.note({
    handoffVersion: 1,
    sessionId,
    kind: "blocker",
    text: "# Fake heading [link](http://x) <b>",
  });
  assert.equal(readFileSync(file, "utf8"), first);
  assert.equal(service.status({ handoffVersion: 1 }).sessionsFile, "pending");
  f.clock.advance(61);
  service.note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "later",
  });
  const second = readFileSync(file, "utf8");
  assert.notEqual(second, first);
  // Caller text sits inside an indented code block, never as Markdown.
  for (const line of second.split("\n").slice(4))
    assert.ok(line === "" || line.startsWith("    "), line);
  assert.match(second, /^ {4}.*# Fake heading/mu);
  assert.doesNotMatch(second, /Git \(observed now\)/u);
  service.end({ handoffVersion: 1, sessionId });
  assert.match(readFileSync(file, "utf8"), /ended \(completed\)/u);
});

test("a long-running server writes a coalesced change after the interval", async (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 1 });
  const service = f.service();
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  const { sessionId } = service.join({ handoffVersion: 1, agent: "timer" });
  service.note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "queued note",
  });
  assert.doesNotMatch(readFileSync(file, "utf8"), /queued note/u);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.match(readFileSync(file, "utf8"), /queued note/u);
});

test("a symlinked or hard-linked sessions file is refused, and the event is still recorded", (t) => {
  const f = fixture(t);
  const agent = join(f.workspaceRoot, ".agent");
  mkdirSync(agent, { mode: 0o700 });
  const outside = join(f.scratch, "outside.md");
  writeFileSync(outside, "keep\n", { mode: 0o600 });
  symlinkSync(outside, join(agent, "sessions.md"));
  const service = f.service({}, { deferProjection: false });
  const { sessionId } = service.join({ handoffVersion: 1, agent: "safe" });
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  // A write that keeps failing is reported, unlike one merely coalesced.
  assert.equal(
    service.status({ handoffVersion: 1 }).sessionsFile,
    "unavailable",
  );
  assert.equal(service.brief().sessions[0]?.sessionId, sessionId);
  rmSync(join(agent, "sessions.md"));
  linkSync(outside, join(agent, "sessions.md"));
  service.end({ handoffVersion: 1, sessionId });
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(service.brief().sessions[0]?.state, "ended");
});

test("no sessions file is written when turned off or read-only", (t) => {
  const f = fixture(t, { projectFile: false });
  const service = f.service();
  service.join({ handoffVersion: 1, agent: "quiet" });
  assert.equal(
    existsSync(join(f.workspaceRoot, ".agent", "sessions.md")),
    false,
  );
  assert.equal(service.status({ handoffVersion: 1 }).sessionsFile, "disabled");
  const g = fixture(t);
  assert.equal(
    g.service({ allowUpdates: false }).status({ handoffVersion: 1 })
      .sessionsFile,
    "disabled",
  );
});

test("a one-shot hook leaves a coalesced write pending instead of flushing it", (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 60 });
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  const written = readFileSync(file, "utf8");
  f.hook({ hook_event_name: "UserPromptSubmit", prompt: "x" });
  assert.equal(readFileSync(file, "utf8"), written);
  assert.equal(
    f.service({}, { deferProjection: false }).status({ handoffVersion: 1 })
      .sessionsFile,
    "pending",
  );
  f.hook({ hook_event_name: "StopFailure", error: "rate_limit" });
  assert.match(readFileSync(file, "utf8"), /stopped on rate_limit/u);
});

test("a projection generation is renamed and confirmed only while no later claim exists", (t) => {
  const f = fixture(t);
  const service = f.service({}, { deferProjection: false });
  assert.equal(service.status({ handoffVersion: 1 }).sessionsFile, "pending");
  const ledger = service.store.handoffSessions();
  const workspace = "sha256:" + "0".repeat(64);
  const renamed: number[] = [];
  const commit = (generation: number) =>
    ledger.commitProjection(workspace, generation, () =>
      renamed.push(generation),
    );
  const first = ledger.claimProjection(workspace, 1000, 60_000, true);
  const second = ledger.claimProjection(workspace, 1001, 60_000, true);
  assert.ok(first !== undefined && second !== undefined && second > first);
  // An overtaken writer is never renamed, so renames land in order.
  assert.equal(commit(first), false);
  assert.deepEqual(renamed, []);
  assert.equal(ledger.projectionState(workspace), "pending");
  assert.equal(commit(second), true);
  assert.deepEqual(renamed, [second]);
  assert.equal(ledger.projectionState(workspace), "written");
  // A coalesced event recorded while a write is in flight invalidates it.
  const inFlight = ledger.claimProjection(
    workspace,
    1001 + 60_000,
    60_000,
    false,
  );
  assert.ok(inFlight !== undefined);
  assert.equal(
    ledger.claimProjection(workspace, 1001 + 60_001, 60_000, false),
    undefined,
  );
  assert.equal(commit(inFlight), false);
  assert.equal(ledger.projectionState(workspace), "pending");
  // Within the interval only dirty, at the boundary due, and a clock that
  // stepped back is due too.
  const due = ledger.claimProjection(workspace, 1001 + 120_001, 60_000, false);
  assert.ok(due !== undefined && commit(due));
  assert.equal(
    ledger.claimProjection(workspace, 1001 + 180_000, 60_000, false),
    undefined,
  );
  assert.ok(
    ledger.claimProjection(workspace, 1001 + 180_001, 60_000, false) !==
      undefined,
  );
  assert.ok(ledger.claimProjection(workspace, 10, 60_000, false) !== undefined);
  // A failing write reports unavailable until a write succeeds.
  ledger.failProjection(workspace);
  assert.equal(ledger.projectionState(workspace), "unavailable");
  const recovered = ledger.claimProjection(workspace, 20, 60_000, true);
  assert.ok(recovered !== undefined && commit(recovered));
  assert.equal(ledger.projectionState(workspace), "written");
  // A rename that throws commits nothing.
  const broken = ledger.claimProjection(workspace, 30, 60_000, true);
  assert.ok(broken !== undefined);
  assert.throws(() =>
    ledger.commitProjection(workspace, broken, () => {
      throw new Error("disk full");
    }),
  );
  assert.equal(ledger.projectionState(workspace), "pending");
});

test("an overtaken write retries from fresh state, forced, a bounded number of times", () => {
  const calls: string[] = [];
  let generation = 0;
  const steps = (wins: number) => ({
    claim: (force: boolean) => {
      calls.push(`claim:${String(force)}`);
      return ++generation;
    },
    prepare: () => {
      calls.push("prepare");
      return generation;
    },
    commit: (claimed: number) => {
      calls.push(`commit:${String(claimed)}`);
      return claimed >= wins;
    },
    discard: (prepared: number) => {
      calls.push(`discard:${String(prepared)}`);
    },
  });
  assert.equal(writeProjection(steps(2), false), "written");
  assert.deepEqual(calls, [
    "claim:false",
    "prepare",
    "commit:1",
    "discard:1",
    "claim:true",
    "prepare",
    "commit:2",
  ]);
  calls.length = 0;
  generation = 0;
  assert.equal(writeProjection(steps(99), true), "overtaken");
  assert.equal(calls.filter((call) => call === "prepare").length, 3);
  assert.equal(calls.filter((call) => call.startsWith("discard")).length, 3);
  assert.equal(
    writeProjection(
      {
        claim: () => undefined,
        prepare: () => assert.fail("a coalesced write prepares nothing"),
        commit: () => false,
        discard: () => undefined,
      },
      false,
    ),
    "deferred",
  );
});

test("every lifecycle event and join writes the sessions file at once", (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 3600 });
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  let previous = "";
  const changed = (label: string) => {
    const current = readFileSync(file, "utf8");
    assert.notEqual(current, previous, label);
    previous = current;
  };
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  changed("SessionStart");
  f.clock.advance(1);
  f.hook({
    hook_event_name: "SubagentStart",
    agent_id: "s1",
    agent_type: "Plan",
  });
  changed("SubagentStart");
  f.clock.advance(1);
  f.hook({
    hook_event_name: "SubagentStop",
    agent_id: "s1",
    agent_type: "Plan",
  });
  changed("SubagentStop");
  f.clock.advance(1);
  f.hook({ hook_event_name: "SessionEnd", reason: "other" });
  changed("SessionEnd");
  const service = f.service({}, { deferProjection: false });
  f.clock.advance(1);
  service.join({ handoffVersion: 1, agent: "joiner" });
  changed("join");
});

test("closing a server writes its ends and any pending write", (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 3600 });
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "closer" });
  service.note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "unsaved note",
  });
  assert.doesNotMatch(readFileSync(file, "utf8"), /unsaved note/u);
  service.close();
  const text = readFileSync(file, "utf8");
  assert.match(text, /unsaved note/u);
  assert.match(text, /ended \(disconnected\)/u);
});

test("quiet and failed subagents are listed; healthy nested ones fold into the nearest listed ancestor", (t) => {
  const f = fixture(t, { leaseSeconds: 60, graceSeconds: 600 });
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  f.hook({
    hook_event_name: "SubagentStart",
    agent_id: "fails",
    agent_type: "Plan",
  });
  f.hook({
    hook_event_name: "StopFailure",
    agent_id: "fails",
    error: "overloaded",
  });
  const service = f.service();
  const main = service.brief().sessions.find((s) => s.kind === "agent");
  assert.ok(main);
  service.join({
    handoffVersion: 1,
    agent: "quiet",
    parentSessionId: main.sessionId,
  });
  f.clock.advance(120);
  const child = service.join({
    handoffVersion: 1,
    agent: "child",
    parentSessionId: main.sessionId,
  });
  for (const name of ["g1", "g2"])
    service.join({
      handoffVersion: 1,
      agent: name,
      parentSessionId: child.sessionId,
    });
  f.hook({ hook_event_name: "UserPromptSubmit", prompt: "x" });
  const brief = service.brief(65536);
  const byAgent = new Map(brief.sessions.map((s) => [s.agent, s]));
  assert.equal(byAgent.get("Plan")?.state, "failed");
  assert.equal(byAgent.get("quiet")?.state, "quiet");
  assert.equal(byAgent.has("child"), false);
  assert.equal(byAgent.has("g1"), false);
  assert.equal(byAgent.get("claude-code")?.subagents?.active, 3);
  // In the parent's lane the child carries its own subagents' counts.
  const lane = service.status({
    handoffVersion: 1,
    sessionId: main.sessionId,
    briefBytes: 65536,
  }).lane;
  assert.equal(
    lane?.subagents.find((s) => s.agent === "child")?.subagents?.active,
    2,
  );
  assert.deepEqual(lane.session.subagents, {
    active: 3,
    idle: 0,
    quiet: 1,
    interrupted: 0,
    failed: 1,
    ended: 0,
  });
});

test("a dropped parent counts the subagents folded into it, and an orphan subagent is listed", (t) => {
  const f = fixture(t);
  const service = f.service();
  const parent = service.join({ handoffVersion: 1, agent: "old-parent" });
  for (let index = 0; index < 10; index++)
    service.join({
      handoffVersion: 1,
      agent: `kid${String(index)}`,
      parentSessionId: parent.sessionId,
    });
  for (let index = 0; index < 30; index++) {
    f.clock.advance(1);
    service.join({ handoffVersion: 1, agent: `new${String(index)}` });
  }
  const brief = service.brief(65536);
  assert.equal(brief.sessions.length, 24);
  assert.equal(brief.omittedSessions, 41 - 24);
  const tight = service.brief(1024);
  const shown = tight.sessions.reduce(
    (sum, view) =>
      sum +
      1 +
      (view.subagents === null
        ? 0
        : Object.values(view.subagents).reduce((a, b) => a + b, 0)),
    0,
  );
  assert.equal(shown + tight.omittedSessions, 41);
  // A subagent whose parent is not among the sessions is listed itself.
  const orphan = buildBrief({
    now: 0,
    liveness: { leaseMs: 1000, graceMs: 1000 },
    latest: undefined,
    sessions: [
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        client: "mcp",
        clientSession: "",
        clientAgent: "",
        agent: "orphan",
        kind: "subagent",
        parentSessionId: "33333333-3333-4333-8333-333333333333",
        task: null,
        startedAt: 0,
        startHead: null,
        lastSeenAt: 0,
        turnOpen: null,
        failure: null,
        endedAt: null,
        endReason: null,
        clientReason: null,
        lastMessage: null,
        noteCount: 0,
      },
    ],
    lastNotes: new Map(),
    notes: [],
    git: observeGit(f.workspaceRoot, null),
  });
  assert.deepEqual(
    orphan.sessions.map((s) => s.agent),
    ["orphan"],
  );
});

test("a tight lane keeps the newest notes and the subagents most in need of attention", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  for (let index = 0; index < 30; index++)
    f.hook({
      hook_event_name: "SubagentStart",
      agent_id: `a${String(index)}`,
      agent_type: "Explore",
    });
  f.hook({
    hook_event_name: "StopFailure",
    agent_id: "a0",
    error: "rate_limit",
  });
  const service = f.service();
  const main = service.brief().sessions.find((s) => s.kind === "agent");
  assert.ok(main);
  for (let index = 0; index < 20; index++)
    service.note({
      handoffVersion: 1,
      sessionId: main.sessionId,
      kind: "progress",
      text: `n${String(index)}`,
    });
  const lane = service.status({
    handoffVersion: 1,
    sessionId: main.sessionId,
    briefBytes: 4096,
  }).lane;
  assert.ok(lane);
  assert.ok(Buffer.byteLength(JSON.stringify(lane)) <= 4096);
  assert.ok(lane.omittedSubagents > 0);
  assert.equal(lane.subagents.length + lane.omittedSubagents, 30);
  if (lane.subagents.length > 0)
    assert.equal(lane.subagents[0]?.state, "failed");
  if (lane.notes.length > 0) assert.equal(lane.notes[0]?.text, "n19");
});

test("abandoned temporary files are swept; a fresh one is left alone", (t) => {
  const f = fixture(t);
  const agent = join(f.workspaceRoot, ".agent");
  mkdirSync(agent, { mode: 0o700 });
  const old = join(
    agent,
    ".handoff-sessions-11111111-1111-4111-8111-111111111111.tmp",
  );
  const fresh = join(
    agent,
    ".handoff-sessions-22222222-2222-4222-8222-222222222222.tmp",
  );
  writeFileSync(old, "x", { mode: 0o600 });
  writeFileSync(fresh, "x", { mode: 0o600 });
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  utimesSync(old, tenMinutesAgo, tenMinutesAgo);
  f.service({}, { deferProjection: false }).join({
    handoffVersion: 1,
    agent: "sweeper",
  });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("every way fitBrief drops a listed session counts the subagents folded into it", () => {
  const view = (agent: string, state: "active" | "ended", folded: number) => ({
    sessionId: randomUUIDv4(),
    agent,
    kind: "agent" as const,
    client: "mcp" as const,
    parentSessionId: null,
    task: "t".repeat(400),
    state,
    startedAt: "2026-10-31T00:00:00.000Z",
    lastSeenAt: "2026-10-31T00:00:00.000Z",
    endedAt: state === "ended" ? "2026-10-31T00:00:00.000Z" : null,
    endReason: state === "ended" ? ("completed" as const) : null,
    clientReason: null,
    failure: null,
    lastNote: null,
    notes: 0,
    lastMessage: null,
    subagents: {
      active: folded,
      idle: 0,
      quiet: 0,
      interrupted: 0,
      failed: 0,
      ended: 0,
    },
  });
  const base = buildBrief({
    now: 0,
    liveness: { leaseMs: 1, graceMs: 1 },
    latest: undefined,
    sessions: [],
    lastNotes: new Map(),
    notes: [],
    git: {
      state: "disabled",
      branch: null,
      head: null,
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
      operation: null,
      changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      paths: [],
      omittedPaths: 0,
      commitsSince: null,
    },
  });
  base.sessions = [
    view("a", "active", 5),
    view("b", "active", 7),
    view("c", "ended", 9),
    view("d", "ended", 11),
  ];
  const total = 4 + 5 + 7 + 9 + 11;
  for (const budget of [1024, 1400, 1800, 2400, 3000, 4000]) {
    const fitted = fitBrief(base, budget, (value) =>
      Buffer.byteLength(JSON.stringify(value)),
    );
    const listed = fitted.sessions.reduce(
      (sum, item) =>
        sum +
        1 +
        (item.subagents === null
          ? 0
          : Object.values(item.subagents).reduce((a, b) => a + b, 0)),
      0,
    );
    assert.equal(listed + fitted.omittedSessions, total, String(budget));
  }
});

test("lanes and briefs survive a parent cycle written straight into the database", (t) => {
  const f = fixture(t);
  const service = f.service();
  const a = service.join({ handoffVersion: 1, agent: "a" });
  const b = service.join({
    handoffVersion: 1,
    agent: "b",
    parentSessionId: a.sessionId,
  });
  const leaf = service.status({
    handoffVersion: 1,
    sessionId: a.sessionId,
  }).lane;
  // A subagent without its own subagents carries no counts.
  assert.equal(leaf?.subagents[0]?.subagents, null);
  const db = new DatabaseSync(f.config.databasePath);
  f.defer(() => {
    db.close();
  });
  db.prepare(
    "UPDATE handoff_sessions SET parent_session_id = ? WHERE session_id = ?",
  ).run(b.sessionId, a.sessionId);
  const brief = service.brief();
  assert.equal(
    brief.sessions.length + brief.omittedSessions,
    2,
    "each session listed or counted once",
  );
  const lane = service.status({
    handoffVersion: 1,
    sessionId: a.sessionId,
  }).lane;
  assert.ok(lane);
});

test("the sweep skips odd entries without stopping, and keeps files that are not ours", (t) => {
  const f = fixture(t);
  const agent = join(f.workspaceRoot, ".agent");
  mkdirSync(agent, { mode: 0o700 });
  const name = (n: number) =>
    join(
      agent,
      `.handoff-sessions-${String(n).repeat(8)}-1111-4111-8111-111111111111.tmp`,
    );
  const old = new Date(Date.now() - 10 * 60_000);
  const make = (path: string, mode = 0o600) => {
    writeFileSync(path, "x", { mode });
    utimesSync(path, old, old);
  };
  const outside = join(f.scratch, "target.tmp");
  writeFileSync(outside, "keep", { mode: 0o600 });
  symlinkSync(outside, name(1));
  make(name(2), 0o644);
  make(name(3));
  const foreign = join(agent, "other.tmp");
  make(foreign);
  f.service({}, { deferProjection: false }).join({
    handoffVersion: 1,
    agent: "sweeper",
  });
  assert.equal(readFileSync(outside, "utf8"), "keep");
  assert.equal(existsSync(name(1)), true);
  assert.equal(existsSync(name(2)), true);
  assert.equal(existsSync(name(3)), false);
  assert.equal(existsSync(foreign), true);
});

test("closing writes a pending change alone, and writes ends alone", (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 3600 });
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  const owner = f.service({}, { deferProjection: false });
  const { sessionId } = owner.join({ handoffVersion: 1, agent: "owner" });
  // A server that joined nothing still flushes a pending write on close.
  const noter = f.service();
  noter.note({
    handoffVersion: 1,
    sessionId,
    kind: "progress",
    text: "pending only",
  });
  assert.doesNotMatch(readFileSync(file, "utf8"), /pending only/u);
  noter.close();
  assert.match(readFileSync(file, "utf8"), /pending only/u);
  // A server with nothing pending still writes the sessions it ends.
  const joiner = f.service();
  f.clock.advance(1);
  joiner.join({ handoffVersion: 1, agent: "leaver" });
  assert.equal(joiner.status({ handoffVersion: 1 }).sessionsFile, "written");
  f.clock.advance(1);
  joiner.close();
  assert.match(
    readFileSync(file, "utf8"),
    /leaver \(mcp, [0-9a-f]{8}\): ended \(disconnected\)/u,
  );
});

test("SessionStart writes at once even right after another write", (t) => {
  const f = fixture(t, { projectionIntervalSeconds: 3600 });
  const file = join(f.workspaceRoot, ".agent", "sessions.md");
  f.service({}, { deferProjection: false }).join({
    handoffVersion: 1,
    agent: "first",
  });
  const before = readFileSync(file, "utf8");
  f.clock.advance(1);
  f.hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.notEqual(readFileSync(file, "utf8"), before);
});

test("a lane cut for budget keeps its newest notes first", (t) => {
  const f = fixture(t);
  const service = f.service();
  const { sessionId } = service.join({ handoffVersion: 1, agent: "noter" });
  for (let index = 0; index < 40; index++)
    service.note({
      handoffVersion: 1,
      sessionId,
      kind: "progress",
      text: `note ${String(index)} ${"y".repeat(100)}`,
    });
  const lane = service.status({
    handoffVersion: 1,
    sessionId,
    briefBytes: 3000,
  }).lane;
  assert.ok(lane && lane.notes.length > 0 && lane.omittedNotes > 0);
  assert.match(lane.notes[0]?.text ?? "", /^note 39 /u);
  assert.match(lane.notes.at(-1)?.text ?? "", /^note \d+ /u);
  assert.equal(lane.notes.length + lane.omittedNotes, 40);
});
