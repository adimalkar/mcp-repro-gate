import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHandoffService, type HandoffService } from "../src/handoff.js";
import { runHandoffCli } from "../src/handoff-cli.js";
import { HandoffError } from "../src/handoff-contract.js";
import {
  identifierParts,
  indexedParts,
  pathWords,
  searchExpression,
} from "../src/handoff-search.js";
import {
  MAX_NOTES_PER_SESSION,
  handoffSearchResultSchema,
} from "../src/handoff-session-contract.js";
import { createReproGateServer } from "../src/server.js";

const errorCode = (code: string) => (error: unknown) =>
  error instanceof HandoffError && error.code === code;

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
}

function fixture(t: TestContext, scope?: "repository") {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-search-")),
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
    ...(scope === undefined ? {} : { scope }),
    sessions: { observeGit: false },
  };
  let time = Date.parse("2026-11-11T10:00:00.000Z");
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
  const service = (
    overrides: Record<string, unknown> = {},
    options: { cwd?: string } = {},
  ) => {
    const value = createHandoffService(
      { ...config, ...overrides },
      { now, deferProjection: false, ...options },
    );
    services.push(value);
    return value;
  };
  return {
    scratch,
    workspaceRoot,
    config,
    service,
    advance: (seconds: number) => {
      time += seconds * 1000;
    },
  };
}

function join1(service: HandoffService, agent: string, extra = {}) {
  return service.join({ handoffVersion: 1, agent, ...extra }).sessionId;
}
function note(
  service: HandoffService,
  sessionId: string,
  text: string,
  kind = "progress",
) {
  service.note({ handoffVersion: 1, sessionId, kind, text });
}
function search(service: HandoffService, query: string, extra = {}) {
  const result = service.search({ handoffVersion: 1, query, ...extra });
  // Every result satisfies the published output schema.
  assert.ok(handoffSearchResultSchema.safeParse(result).success);
  return result;
}
const texts = (result: ReturnType<typeof search>) =>
  result.hits.map((hit) => hit.text);

test("identifier parts split camelCase and snake_case, not other words", () => {
  assert.deepEqual(identifierParts("parseHandoffConfig"), [
    "parse",
    "handoff",
    "config",
  ]);
  assert.deepEqual(identifierParts("handoff_search"), ["handoff", "search"]);
  assert.deepEqual(identifierParts("HTTPServer"), ["http", "server"]);
  assert.deepEqual(identifierParts("EPERM"), []);
  assert.deepEqual(identifierParts("plain"), []);
  assert.equal(
    indexedParts("fix rmSync in handoff_search, not EPERM"),
    "rm sync handoff search",
  );
});

test("query words are quoted phrases, so no FTS5 syntax reaches the index", () => {
  for (const query of [
    'foo" OR bar*',
    "NEAR(alpha beta)",
    "body:secret",
    "-excluded ^start",
    "a AND b NOT c",
    "{body parts}: x",
  ]) {
    const expression = searchExpression(query);
    assert.ok(expression !== undefined);
    // Outside quoted phrases only OR, parentheses and the parts column remain.
    const outside = expression.replace(/"(?:[^"]|"")*"/gu, "");
    assert.match(outside, /^(?:\s|OR|AND|\(|\)|parts :)*$/u, query);
  }
  assert.equal(searchExpression("... --- !!!"), undefined);
  assert.equal(searchExpression(""), undefined);
});

test("path-like words name files, not abbreviations or versions", () => {
  assert.deepEqual(
    pathWords(
      "edited `src/cli.ts`, cli.ts and ./docs/HANDOFF.md (e.g. v1.2.3) at https://x.io/a i.e. done.",
    ),
    ["src/cli.ts", "cli.ts", "docs/HANDOFF.md"],
  );
});

test("search finds notes by identifier, identifier part, path and error code", (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker");
  note(service, session, "Fixed parseHandoffConfig in src/handoff-contract.ts");
  note(service, session, "rmSync failed with EPERM on Windows", "blocker");
  note(service, session, "handoff_search ranks with bm25", "decision");

  assert.deepEqual(texts(search(service, "parseHandoffConfig")), [
    "Fixed parseHandoffConfig in src/handoff-contract.ts",
  ]);
  assert.deepEqual(texts(search(service, "HandoffConfig")), [
    "Fixed parseHandoffConfig in src/handoff-contract.ts",
  ]);
  assert.deepEqual(texts(search(service, "search")), [
    "handoff_search ranks with bm25",
  ]);
  const byPath = search(service, "src/handoff-contract.ts");
  assert.deepEqual(byPath.hits[0]?.paths, ["src/handoff-contract.ts"]);
  const blocker = search(service, "EPERM").hits[0];
  assert.equal(blocker?.source, "note");
  assert.equal(blocker.kind, "blocker");
  assert.equal(blocker.agent, "worker");
  assert.equal(blocker.sessionId, session);
  assert.equal(blocker.sessionState, "active");
  assert.equal(blocker.sessionKind, "agent");
  assert.equal(blocker.cut, false);
  assert.deepEqual(texts(search(service, "nothing-like-this")), []);
  // Text that looks like FTS5 syntax is searched as text.
  note(service, session, 'quoted "NEAR(a b)" OR body:x text');
  assert.equal(search(service, 'NEAR(a b)" OR body:x').hits.length, 1);
});

test("the index follows pruned and new notes and never returns stale text", (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker");
  for (let index = 0; index <= MAX_NOTES_PER_SESSION; index++)
    note(service, session, `marker${String(index)} step`);
  // The oldest note was pruned when the cap was passed.
  assert.equal(search(service, "marker0").hits.length, 0);
  assert.equal(search(service, "marker1").hits.length, 1);
  note(service, session, "brandnew note after a search");
  assert.equal(search(service, "brandnew").hits.length, 1);

  // A note changed behind the index, with the fingerprint unchanged, is
  // dropped rather than returned with text it no longer has.
  const database = new DatabaseSync(f.config.databasePath);
  try {
    database
      .prepare("UPDATE handoff_notes SET text = ? WHERE text = ?")
      .run("rewritten elsewhere", "brandnew note after a search");
  } finally {
    database.close();
  }
  assert.equal(search(service, "brandnew").hits.length, 0);
});

test("an index rebuilt from scratch matches the sources", (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker", { task: "migrate fooBar storage" });
  note(service, session, "kept note about widgets");
  assert.equal(search(service, "widgets").hits.length, 1);
  const database = new DatabaseSync(f.config.databasePath);
  try {
    database.exec("DROP TABLE handoff_search; DROP TABLE handoff_search_state");
  } finally {
    database.close();
  }
  assert.equal(search(service, "widgets").hits.length, 1);
  const task = search(service, "bar storage", { kinds: ["task"] }).hits[0];
  assert.equal(task?.source, "task");
  assert.equal(task.kind, null);
  assert.equal(task.text, "migrate fooBar storage");
});

function update(
  service: HandoffService,
  context: Record<string, unknown>,
): void {
  const status = service.status({ handoffVersion: 1 });
  service.update({
    handoffVersion: 1,
    updateId: randomUUID(),
    expectedRevision: status.revision,
    expectedDocumentDigest: status.documentDigest,
    context: {
      activeAgent: "lead",
      goal: "ship search",
      completed: [],
      touchedFiles: [],
      blockers: [],
      nextSteps: [],
      ...context,
    },
    actionIds: [],
  });
}

test("revision items are searchable once, under the newest revision holding them", (t) => {
  const f = fixture(t);
  const service = f.service();
  update(service, { blockers: ["flaky widget fixture"] });
  update(service, {
    blockers: ["flaky widget fixture"],
    touchedFiles: ["src/widget.ts"],
  });
  const hits = search(service, "widget").hits;
  const blocker = hits.find((hit) => hit.kind === "blocker");
  assert.equal(blocker?.source, "revision");
  assert.equal(blocker.revision, 2);
  assert.equal(blocker.sessionId, null);
  assert.equal(hits.filter((hit) => hit.kind === "blocker").length, 1);
  const file = hits.find((hit) => hit.kind === "touchedFile");
  assert.deepEqual(file?.paths, ["src/widget.ts"]);
  assert.deepEqual(
    search(service, "widget", { kinds: ["blocker"] }).hits.map(
      (hit) => hit.source,
    ),
    [],
  );
  assert.equal(
    search(service, "widget", { kinds: ["revision"] }).hits.length,
    2,
  );
});

test("the caller's lane ranks first, and old hits rank lower", (t) => {
  const f = fixture(t);
  const service = f.service();
  const old = join1(service, "old");
  note(service, old, "flaky runner test seen first");
  f.advance(60 * 86_400);
  const mine = join1(service, "mine");
  const other = join1(service, "other");
  note(service, other, "flaky runner test seen by other");
  note(service, mine, "flaky runner test seen by mine");
  const ranked = search(service, "flaky runner", { sessionId: other }).hits;
  assert.equal(ranked[0]?.agent, "other");
  assert.equal(ranked.at(-1)?.agent, "old");
  assert.equal(
    search(service, "flaky runner", { sessionId: mine }).hits[0]?.agent,
    "mine",
  );
  // A subagent's lane includes its parent.
  const child = join1(service, "child", {
    kind: "subagent",
    parentSessionId: mine,
  });
  assert.equal(
    search(service, "flaky runner", { sessionId: child }).hits[0]?.agent,
    "mine",
  );
  // Identical text from two sessions is one hit.
  note(service, other, "same words twice");
  note(service, mine, "same words twice");
  assert.equal(search(service, "same words").hits.length, 1);
});

test("a file named in the query that matches several paths is reported as ambiguous", (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker");
  note(service, session, "changed usage in src/cli.ts");
  note(service, session, "changed hooks in src/handoff-cli.ts");
  note(service, session, "touched src/cli.ts again");
  const result = search(service, "cli.ts");
  assert.equal(result.ambiguous?.term, "cli.ts");
  assert.deepEqual(
    result.ambiguous.candidates.map((candidate) => [
      candidate.path,
      candidate.hits,
    ]),
    [
      ["src/cli.ts", 2],
      ["src/handoff-cli.ts", 1],
    ],
  );
  const exact = search(service, "cli.ts", { path: "src/cli.ts" });
  assert.equal(exact.ambiguous, null);
  assert.deepEqual(texts(exact).sort(), [
    "changed usage in src/cli.ts",
    "touched src/cli.ts again",
  ]);
  // One path only: nothing to disambiguate.
  assert.equal(
    search(service, "handoff-cli.ts", { path: "src/handoff-cli.ts" }).ambiguous,
    null,
  );
});

test("in repository scope, worktrees disambiguate the same path and rank the caller's first", (t) => {
  const f = fixture(t, "repository");
  const root = f.workspaceRoot;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "first");
  const linked = join(f.scratch, "linked");
  git(root, "worktree", "add", "-q", "-b", "topic", linked);
  const main = f.service();
  const other = f.service({}, { cwd: linked });
  const mainSession = join1(main, "main-agent");
  const linkedSession = join1(other, "linked-agent");
  note(main, mainSession, "rewrote src/store.ts locking in main");
  note(other, linkedSession, "rewrote src/store.ts locking in topic");

  const result = search(other, "src/store.ts");
  assert.equal(result.hits[0]?.worktree, "linked");
  assert.deepEqual(
    result.ambiguous?.candidates.map((candidate) => candidate.worktree).sort(),
    ["linked", "workspace"],
  );
  const filtered = search(main, "src/store.ts", { worktree: "linked" });
  assert.deepEqual(texts(filtered), ["rewrote src/store.ts locking in topic"]);
  assert.equal(filtered.ambiguous, null);
  assert.equal(
    search(main, "src/store.ts", { worktree: "absent" }).hits.length,
    0,
  );
});

test("results fit resultBytes and count what was left out", (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker");
  for (let index = 0; index < 20; index++)
    note(service, session, `budget item ${String(index)} ${"x".repeat(300)}`);
  const defaults = search(service, "budget");
  assert.equal(defaults.hits.length + defaults.omittedHits, 20);
  assert.ok(defaults.hits.length <= 8);
  const small = search(service, "budget", { resultBytes: 1024, limit: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 1024);
  assert.equal(small.hits.length + small.omittedHits, 20);
  assert.ok(small.hits.length >= 1);
  // A long note is cut to a window around the match.
  note(
    service,
    session,
    `${"filler ".repeat(120)}needle ${"filler ".repeat(120)}`,
  );
  const long = search(service, "needle").hits[0];
  assert.equal(long?.cut, true);
  assert.match(long.text, /needle/u);
  assert.ok(Buffer.byteLength(long.text) <= 512);
});

test("search input is validated", (t) => {
  const f = fixture(t);
  const service = f.service();
  assert.throws(
    () => service.search({ handoffVersion: 1, query: "a\u0000b" }),
    errorCode("invalid_input"),
  );
  assert.throws(
    () => service.search({ handoffVersion: 1, query: "" }),
    errorCode("invalid_input"),
  );
  assert.throws(
    () =>
      service.search({
        handoffVersion: 1,
        query: "a",
        kinds: ["task", "task"],
      }),
    errorCode("invalid_input"),
  );
  assert.throws(
    () => service.search({ handoffVersion: 1, query: "a", resultBytes: 100 }),
    errorCode("invalid_input"),
  );
  assert.throws(
    () =>
      service.search({
        handoffVersion: 1,
        query: "a",
        sessionId: randomUUID(),
      }),
    errorCode("unknown_session"),
  );
  assert.equal(search(service, "!!!").hits.length, 0);
});

test("handoff_end tells only the last running top-level agent to update the shared summary", (t) => {
  const f = fixture(t);
  const service = f.service();
  const first = join1(service, "first");
  const second = join1(service, "second");
  const child = join1(service, "child", {
    kind: "subagent",
    parentSessionId: second,
  });
  const end = (sessionId: string) =>
    service.end({ handoffVersion: 1, sessionId, summary: "done" }).sharedUpdate;
  assert.equal(end(child), "skip");
  assert.equal(end(first), "skip");
  assert.equal(end(second), "expected");

  // A session that went quiet does not hold the update back.
  const working = join1(service, "working");
  const silent = join1(service, "silent");
  f.advance(400);
  service.note({
    handoffVersion: 1,
    sessionId: working,
    kind: "progress",
    text: "still here",
  });
  assert.equal(end(working), "expected");
  assert.equal(end(silent), "expected");
});

test("handoff_search is served over MCP with instructions for one shared writer", async (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker");
  note(service, session, "searchable over mcp");
  const server = createReproGateServer(undefined, undefined, service);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /handoff_search/u);
  assert.match(instructions, /sharedUpdate \\?"expected\\?"/u);
  assert.doesNotMatch(
    instructions,
    /handoff_end with a summary and handoff_update/u,
  );
  const tools = await client.listTools();
  const tool = tools.tools.find((entry) => entry.name === "handoff_search");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const result = await client.callTool({
    name: "handoff_search",
    arguments: { handoffVersion: 1, query: "mcp" },
  });
  const parsed = handoffSearchResultSchema.parse(result.structuredContent);
  assert.deepEqual(
    parsed.hits.map((hit) => hit.text),
    ["searchable over mcp"],
  );
  const failed = await client.callTool({
    name: "handoff_search",
    arguments: { handoffVersion: 1, query: "x", sessionId: randomUUID() },
  });
  assert.equal(failed.isError, true);

  // Read-only configurations can search too.
  const readOnly = f.service({ allowUpdates: false });
  const readServer = createReproGateServer(undefined, undefined, readOnly);
  const readClient = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await readServer.connect(b);
  await readClient.connect(a);
  t.after(async () => {
    await readClient.close();
    await readServer.close();
  });
  const names = (await readClient.listTools()).tools.map((entry) => entry.name);
  assert.ok(names.includes("handoff_search"));
  assert.ok(!names.includes("handoff_update"));
  const readResult = await readClient.callTool({
    name: "handoff_search",
    arguments: { handoffVersion: 1, query: "searchable" },
  });
  assert.deepEqual(
    handoffSearchResultSchema
      .parse(readResult.structuredContent)
      .hits.map((hit) => hit.text),
    ["searchable over mcp"],
  );
});

test("reprogate handoff search prints hits and the ambiguity, or JSON", (t) => {
  const f = fixture(t);
  const service = f.service();
  const session = join1(service, "worker");
  note(service, session, "changed usage in src/cli.ts");
  note(service, session, "changed hooks in src/handoff-cli.ts");
  const configPath = join(f.scratch, "state", "handoff.json");
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const run = (args: string[]) => {
    let stdout = "";
    let stderr = "";
    const code = runHandoffCli(args, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  };
  const text = run(["search", "--config", configPath, "cli.ts"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^"cli\.ts" matches several files/u);
  assert.match(text.stdout, /\n {2}src\/handoff-cli\.ts: 1 hit/u);
  assert.match(text.stdout, /\[note progress\] worker, active /u);
  const json = run([
    "search",
    "--config",
    configPath,
    "--json",
    "--path",
    "src/cli.ts",
    "changed",
    "usage",
  ]);
  assert.equal(json.code, 0, json.stderr);
  const parsed = handoffSearchResultSchema.parse(JSON.parse(json.stdout));
  assert.deepEqual(
    parsed.hits.map((hit) => hit.text),
    ["changed usage in src/cli.ts"],
  );
  assert.match(
    run(["search", "--config", configPath, "absent"]).stdout,
    /^No matches\./u,
  );
  const usage = run(["search", "--config", configPath]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /reprogate handoff search --config/u);
  const invalid = run(["search", "--config", configPath, "--limit", "0", "x"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /invalid_input/u);
});
