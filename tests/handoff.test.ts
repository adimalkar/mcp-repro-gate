import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ajv2020 } from "ajv/dist/2020.js";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createReproGateServer } from "../src/server.js";
import { createHandoffService, type HandoffService } from "../src/handoff.js";
import { HandoffError, parseHandoffUpdate } from "../src/handoff-contract.js";
import { MAX_HANDOFF_HISTORY } from "../src/handoff-filesystem.js";
import { sha256 } from "../src/digest.js";
import { sha256File } from "../src/file-digest.js";
import { ReproGateKernel } from "../src/kernel.js";
import { demoCatalog, demoPolicy } from "../src/demo-config.js";

function fixture(t: TestContext) {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-handoff-é-")),
  );
  const workspaceRoot = join(scratch, "workspace ü");
  const state = join(scratch, "private state");
  mkdirSync(workspaceRoot);
  mkdirSync(state, { mode: 0o700 });
  const config = {
    configVersion: 1 as const,
    workspaceRoot,
    databasePath: join(state, "context.sqlite"),
    allowUpdates: true,
  };
  const services: HandoffService[] = [];
  const databases: DatabaseSync[] = [];
  t.after(() => {
    for (const db of databases) db.close();
    for (const service of services) service.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const service = (allowUpdates = true) => {
    const value = createHandoffService({ ...config, allowUpdates });
    services.push(value);
    return value;
  };
  const database = () => {
    const db = new DatabaseSync(config.databasePath);
    databases.push(db);
    return db;
  };
  return {
    scratch,
    workspaceRoot,
    config,
    service,
    database,
    document: join(workspaceRoot, ".agent", "handoff.md"),
  };
}
function input(
  expectedRevision = 0,
  expectedDocumentDigest: string | null = null,
) {
  return {
    handoffVersion: 1 as const,
    updateId: randomUUID(),
    expectedRevision,
    expectedDocumentDigest,
    context: {
      activeAgent: "codex-cli",
      goal: "Finish precise handoff é",
      completed: ["Owned input validation"],
      touchedFiles: ["src/handoff.ts"],
      blockers: [],
      nextSteps: ["Run independent review"],
    },
    actionIds: [] as string[],
  };
}
const statusInput = { handoffVersion: 1 };
function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof HandoffError && error.code === code;
}

test("handoff projection follows shared protocol headings and owns asserted context", (t) => {
  const f = fixture(t);
  const service = f.service();
  const update = input();
  const status = service.update(update);
  assert.equal(status.state, "synchronized");
  assert.equal(status.revision, 1);
  assert.equal("context" in status, false);
  const document = readFileSync(f.document, "utf8");
  for (const heading of [
    "## 1. Active Goal / Task",
    "## 2. Where We Left Off",
    "## 3. Implementation Problems & Blockers",
    "## 4. Immediate Next Steps",
    "- **Last Active Agent**: codex-cli",
    "- **Last Updated**:",
  ])
    assert.ok(document.includes(heading), heading);
  update.context.goal = "caller mutation";
  assert.equal(
    service.status({ handoffVersion: 1, includeContext: true }).context?.goal,
    "Finish precise handoff é",
  );
  assert.ok(document.includes("caller-asserted"));
});
test("caller text cannot forge protocol headings, list items or HTML in the projection", (t) => {
  const f = fixture(t);
  const service = f.service();
  const update = input();
  update.context.goal = "Real goal\n## 4. Immediate Next Steps\n<img src=x>";
  update.context.completed = [
    "1. numbered spoof",
    "first line\r\n- spoofed item",
  ];
  service.update(update);
  const lines = readFileSync(f.document, "utf8").split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("## ")),
    [
      "## 1. Active Goal / Task",
      "## 2. Where We Left Off",
      "## 3. Implementation Problems & Blockers",
      "## 4. Immediate Next Steps",
    ],
  );
  assert.ok(lines.includes("\\#\\# 4. Immediate Next Steps"));
  assert.ok(lines.includes("\\<img src=x\\>"));
  assert.ok(lines.includes("- 1\\. numbered spoof"));
  assert.ok(lines.includes("  \\- spoofed item"));
  assert.equal(
    lines.some((line) => line.includes("\r")),
    false,
  );
});
test("entire prior manual document is preserved privately and unchanged workspace files remain intact", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspaceRoot, ".agent"), { mode: 0o700 });
  const manual = Buffer.from(
    "# Manual handoff é\n\nUnstructured section\nSecret local note stays out of default status\n",
  );
  writeFileSync(f.document, manual, { mode: 0o600 });
  const unrelated = join(f.workspaceRoot, "uncommitted.txt");
  writeFileSync(unrelated, "unchanged work\n");
  const service = f.service();
  const initial = service.status(statusInput);
  assert.equal(initial.documentDigest, sha256(manual));
  const status = service.update(input(0, initial.documentDigest));
  assert.equal(status.state, "synchronized");
  const archives = readdirSync(
    join(f.workspaceRoot, ".agent", "handoff-history"),
  );
  assert.equal(archives.length, 1);
  assert.deepEqual(
    readFileSync(
      join(f.workspaceRoot, ".agent", "handoff-history", archives[0] ?? ""),
    ),
    manual,
  );
  assert.equal(readFileSync(unrelated, "utf8"), "unchanged work\n");
  assert.equal(JSON.stringify(status).includes("Secret local"), false);
});
test("handoff revisions and exact UUID retries are durable and never overwrite later snapshots", (t) => {
  const f = fixture(t);
  const service = f.service();
  const update = input();
  const first = service.update(update);
  assert.deepEqual(service.update(update), first);
  const second = service.update(input(1, first.documentDigest));
  assert.equal(second.revision, 2);
  assert.throws(() => service.update(update), errorCode("revision_conflict"));
  assert.throws(
    () =>
      service.update({
        ...update,
        context: { ...update.context, goal: "switched payload" },
      }),
    errorCode("update_conflict"),
  );
  const restart = f.service();
  assert.equal(restart.status(statusInput).revision, 2);
  const db = f.database();
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM handoff_snapshots").get()?.count,
    2,
  );
  assert.throws(() => {
    db.exec("DELETE FROM handoff_snapshots");
  }, /Immutable/u);
  assert.throws(() => {
    db.exec("UPDATE handoff_projection_events SET state='drifted'");
  }, /Immutable/u);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM token_uses").get()?.count,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM executions").get()?.count,
    0,
  );
});
test("manual drift is observed conservatively and stale document revisions cannot reserve", (t) => {
  const f = fixture(t);
  const service = f.service();
  const first = service.update(input());
  writeFileSync(f.document, "external notes\n");
  assert.equal(service.status(statusInput).state, "drifted");
  assert.throws(
    () => service.update(input(1, first.documentDigest)),
    errorCode("document_conflict"),
  );
  assert.equal(readFileSync(f.document, "utf8"), "external notes\n");
  assert.equal(
    f
      .database()
      .prepare("SELECT count(*) AS count FROM handoff_snapshots")
      .get()?.count,
    1,
  );
});
test("handoff references bind consistent real plans and retain only safe summaries", (t) => {
  const f = fixture(t);
  const service = f.service();
  const kernel = new ReproGateKernel(demoCatalog, demoPolicy, service.store);
  const plan = kernel.plan({
    toolRef: "demo.read_file",
    arguments: { path: "PRIVATE-RAW-ARGUMENT" },
  });
  const update = input();
  update.actionIds.push(plan.envelope.actionId);
  service.update(update);
  const context = service.status({ handoffVersion: 1, includeContext: true });
  assert.equal(context.references?.[0]?.envelopeDigest, plan.envelopeDigest);
  assert.equal(JSON.stringify(context).includes("PRIVATE-RAW-ARGUMENT"), false);
  const raw = f.database();
  raw
    .prepare("UPDATE plans SET envelope_digest = ? WHERE action_id = ?")
    .run("sha256:" + "0".repeat(64), plan.envelope.actionId);
  const next = input(1, context.documentDigest);
  next.actionIds.push(plan.envelope.actionId);
  assert.throws(() => service.update(next), errorCode("unknown_plan"));
  assert.equal(
    raw.prepare("SELECT count(*) AS count FROM handoff_snapshots").get()?.count,
    1,
  );
});
test("strict caller snapshots reject getters, proxies, sparse arrays, unknowns and oversized bytes before effects", (t) => {
  const f = fixture(t);
  const service = f.service();
  let getterCalls = 0;
  const accessor = {
    ...input(),
    get updateId() {
      getterCalls++;
      return randomUUID();
    },
  };
  const sparse = input();
  sparse.context.completed = Array(2) as string[];
  const hostile = [
    accessor,
    new Proxy(input(), {}),
    sparse,
    { ...input(), target: f.document },
    { ...input(), context: { ...input().context, goal: "é".repeat(4097) } },
    { ...input(), context: Object.create(input().context) as object },
  ];
  for (const value of hostile)
    assert.throws(() => service.update(value), errorCode("invalid_input"));
  assert.equal(getterCalls, 0);
  assert.equal(existsSync(f.document), false);
  assert.equal(
    f
      .database()
      .prepare("SELECT count(*) AS count FROM handoff_snapshots")
      .get()?.count,
    0,
  );
  const valid = input();
  assert.notEqual(parseHandoffUpdate(valid), valid);
});
test("read-only configuration does not create agent files or grant update authority", (t) => {
  const f = fixture(t);
  const service = f.service(false);
  assert.equal(service.status(statusInput).state, "missing");
  assert.throws(() => service.update(input()), errorCode("read_only"));
  assert.equal(existsSync(join(f.workspaceRoot, ".agent")), false);
});
test(
  "unsafe preexisting manual document is refused without chmod repair",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    mkdirSync(join(f.workspaceRoot, ".agent"), { mode: 0o700 });
    writeFileSync(f.document, "manual remains\n", { mode: 0o644 });
    const service = f.service();
    assert.equal(service.status(statusInput).state, "unavailable");
    assert.throws(() => service.update(input()), errorCode("unavailable"));
    assert.equal(readFileSync(f.document, "utf8"), "manual remains\n");
    chmodSync(f.document, 0o600);
  },
);

async function connect(t: TestContext, service: HandoffService) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createReproGateServer(undefined, undefined, service);
  const client = new Client({ name: "handoff-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
test("MCP clients discover handoff tools only when configured and update with optimistic revisions", async (t) => {
  const f = fixture(t);
  const plain = new Client({ name: "plain", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const plainServer = createReproGateServer();
  t.after(async () => {
    await plain.close();
    await plainServer.close();
  });
  await plainServer.connect(b);
  await plain.connect(a);
  assert.equal(
    (await plain.listTools()).tools.some((tool) =>
      tool.name.startsWith("handoff"),
    ),
    false,
  );

  const client = await connect(t, f.service());
  const tools = (await client.listTools()).tools.filter((tool) =>
    tool.name.startsWith("handoff"),
  );
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "handoff_status",
    "handoff_update",
  ]);
  assert.equal(
    tools.find((tool) => tool.name === "handoff_status")?.annotations
      ?.readOnlyHint,
    true,
  );
  assert.ok(tools.every((tool) => tool.outputSchema !== undefined));
  const initial = await client.callTool({
    name: "handoff_status",
    arguments: { handoffVersion: 1 },
  });
  assert.equal(initial.isError, undefined);
  assert.equal(
    (initial.structuredContent as { state: string }).state,
    "missing",
  );
  const update = input();
  const updated = await client.callTool({
    name: "handoff_update",
    arguments: update,
  });
  assert.equal(updated.isError, undefined);
  assert.equal((updated.structuredContent as { revision: number }).revision, 1);
  const stale = await client.callTool({
    name: "handoff_update",
    arguments: input(),
  });
  assert.equal(stale.isError, true);
  assert.deepEqual(
    JSON.parse((stale.content as { text: string }[])[0]?.text ?? ""),
    { error: "revision_conflict" },
  );
  const unknown = await client.callTool({
    name: "handoff_update",
    arguments: { ...input(1), target: f.document },
  });
  assert.equal(unknown.isError, true);
  assert.equal(JSON.stringify(unknown).includes(f.workspaceRoot), false);
  const context = await client.callTool({
    name: "handoff_status",
    arguments: { handoffVersion: 1, includeContext: true },
  });
  assert.equal(
    (context.structuredContent as { context: { goal: string } }).context.goal,
    update.context.goal,
  );
});
test("read-only MCP configuration exposes status without an update tool", async (t) => {
  const f = fixture(t);
  const client = await connect(t, f.service(false));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("handoff_status"));
  assert.equal(names.includes("handoff_update"), false);
  assert.equal(existsSync(join(f.workspaceRoot, ".agent")), false);
});
test("the CLI serves handoff tools from a private host configuration file over stdio", async (t) => {
  const f = fixture(t);
  const configPath = join(f.scratch, "private state", "handoff.json");
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const client = new Client({ name: "stdio-handoff", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "serve",
      "--handoff-config",
      configPath,
    ],
    stderr: "pipe",
  });
  t.after(async () => client.close());
  await client.connect(transport);
  const updated = await client.callTool({
    name: "handoff_update",
    arguments: input(),
  });
  assert.equal(updated.isError, undefined);
  assert.ok(
    readFileSync(f.document, "utf8").includes("## 1. Active Goal / Task"),
  );
});
test("two connections with the same expected revision cannot both commit", (t) => {
  const f = fixture(t);
  const first = f.service();
  const second = f.service();
  assert.equal(first.update(input()).revision, 1);
  assert.throws(() => second.update(input()), errorCode("revision_conflict"));
  assert.equal(second.status(statusInput).revision, 1);
  assert.equal(
    f
      .database()
      .prepare("SELECT count(*) AS count FROM handoff_snapshots")
      .get()?.count,
    1,
  );
});
test(
  "a failed projection stays pending and an identical retry reconciles it",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  (t) => {
    const f = fixture(t);
    const service = f.service();
    const agent = join(f.workspaceRoot, ".agent");
    mkdirSync(agent, { mode: 0o700 });
    chmodSync(agent, 0o500);
    t.after(() => {
      if (existsSync(agent)) chmodSync(agent, 0o700);
    });
    const update = input();
    assert.throws(() => service.update(update), errorCode("unavailable"));
    const pending = service.status(statusInput);
    assert.equal(pending.state, "pending");
    assert.equal(pending.revision, 1);
    assert.equal(existsSync(f.document), false);
    chmodSync(agent, 0o700);
    // The live service bound the earlier directory mode and keeps failing closed.
    assert.throws(() => service.update(update), errorCode("unavailable"));
    const retried = f.service().update(update);
    assert.equal(retried.state, "synchronized");
    assert.equal(retried.revision, 1);
    assert.equal(
      readdirSync(agent).filter((name) => name.startsWith(".handoff-")).length,
      0,
    );
    assert.equal(
      f
        .database()
        .prepare("SELECT count(*) AS count FROM handoff_snapshots")
        .get()?.count,
      1,
    );
  },
);
test(
  "symlinked and hard-linked projection targets are refused without touching their targets",
  { skip: process.platform === "win32" },
  (t) => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const f = fixture(t);
      mkdirSync(join(f.workspaceRoot, ".agent"), { mode: 0o700 });
      const target = join(f.scratch, `outside-${kind}.md`);
      writeFileSync(target, "outside stays\n", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, f.document);
      else linkSync(target, f.document);
      const service = f.service();
      assert.equal(service.status(statusInput).state, "unavailable", kind);
      assert.throws(
        () => service.update(input()),
        errorCode("unavailable"),
        kind,
      );
      assert.equal(readFileSync(target, "utf8"), "outside stays\n", kind);
      assert.equal(
        f
          .database()
          .prepare("SELECT count(*) AS count FROM handoff_snapshots")
          .get()?.count,
        0,
        kind,
      );
    }
  },
);
test("serve shares a fresh runtime database reached through an alias and binds its plans", async (t) => {
  const f = fixture(t);
  const state = join(f.scratch, "private state");
  // An aliased ancestor, as macOS /var -> /private/var gives temp paths.
  const alias = join(f.scratch, "..", `${basename(f.scratch)}-alias`);
  symlinkSync(
    f.scratch,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  t.after(() => {
    rmSync(alias, { force: true });
  });
  const artifactPath = join(state, "downstream.mjs");
  const fixtureUrl = pathToFileURL(
    fileURLToPath(new URL("./fixtures/downstream-server.js", import.meta.url)),
  ).href;
  writeFileSync(artifactPath, `await import(${JSON.stringify(fixtureUrl)});\n`);
  const artifactDigest = await sha256File(artifactPath);
  const runtimeConfigPath = join(state, "runtime.json");
  writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
      configVersion: 1,
      // A different spelling of the handoff database, which does not exist yet.
      databasePath: join(alias, "private state", "context.sqlite"),
      catalog: [
        {
          toolRef: "configured.publish",
          serverRef: "configured",
          toolName: "publish",
          description: "Configured integration fixture",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
          effects: ["local_write"],
          filesystemRoots: [f.workspaceRoot],
          artifactDigest,
        },
      ],
      policy: demoPolicy,
      backends: {
        configured: {
          transport: "stdio",
          command: process.execPath,
          args: [artifactPath],
          cwd: state,
          environment: { inherit: "safe", from: {} },
          artifact: { path: artifactPath, digest: artifactDigest },
        },
      },
      observer: { kind: "filesystem_manifest", roots: [f.workspaceRoot] },
      secrets: {
        capabilitySecretEnv: "TEST_CAPABILITY_SECRET",
        receiptSecretEnv: "TEST_RECEIPT_SECRET",
        receiptKeyId: "test-key-1",
      },
    }),
  );
  const handoffConfigPath = join(state, "handoff.json");
  writeFileSync(handoffConfigPath, JSON.stringify(f.config), { mode: 0o600 });
  const client = new Client({ name: "shared-handoff", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "serve",
      "--config",
      runtimeConfigPath,
      "--handoff-config",
      handoffConfigPath,
    ],
    env: {
      ...process.env,
      TEST_CAPABILITY_SECRET: "configured-capability-secret-at-least-32-bytes",
      TEST_RECEIPT_SECRET: "configured-receipt-secret-different-32-bytes",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  t.after(async () => client.close());
  await client.connect(transport).catch((error: unknown) => {
    throw new Error(`serve failed: ${stderr}`, { cause: error });
  });
  const planned = await client.callTool({
    name: "action.plan",
    arguments: { toolRef: "configured.publish", arguments: { content: "x" } },
  });
  const actionId = (
    planned.structuredContent as { envelope: { actionId: string } }
  ).envelope.actionId;
  const update = input();
  update.actionIds.push(actionId);
  const updated = await client.callTool({
    name: "handoff_update",
    arguments: update,
  });
  assert.equal(updated.isError, undefined, JSON.stringify(updated.content));
  const status = await client.callTool({
    name: "handoff_status",
    arguments: { handoffVersion: 1, includeContext: true },
  });
  assert.equal(
    (status.structuredContent as { references: { actionId: string }[] })
      .references[0]?.actionId,
    actionId,
  );
  if (process.platform !== "win32")
    assert.equal(statSync(f.config.databasePath).mode & 0o777, 0o600);
});
const worker = fileURLToPath(
  new URL("./fixtures/handoff-worker.js", import.meta.url),
);
function runWorker(args: string[]) {
  const child = spawn(process.execPath, [worker, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 30_000);
  return {
    done: once(child, "exit").then(([code]) => {
      clearTimeout(timer);
      return { code: code as number | null, stdout, stderr };
    }),
  };
}
function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
test("two processes racing from one revision commit exactly one snapshot", async (t) => {
  const f = fixture(t);
  const state = join(f.scratch, "private state");
  const configPath = writeJson(join(state, "worker-config.json"), f.config);
  const barrier = join(state, "go");
  const workers = [0, 1].map((index) =>
    runWorker([
      "update",
      configPath,
      writeJson(join(state, `update-${String(index)}.json`), input()),
      barrier,
    ]),
  );
  writeFileSync(barrier, "");
  const results = await Promise.all(workers.map(({ done }) => done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const outcomes = results
    .map(
      ({ stdout }) =>
        JSON.parse(stdout) as { revision?: number; code?: string },
    )
    .map((outcome) => outcome.code ?? `revision ${String(outcome.revision)}`)
    .sort();
  assert.deepEqual(outcomes, ["revision 1", "revision_conflict"]);
  const status = f.service(false).status(statusInput);
  assert.equal(status.state, "synchronized");
  assert.equal(status.revision, 1);
  assert.equal(
    f
      .database()
      .prepare("SELECT count(*) AS count FROM handoff_snapshots")
      .get()?.count,
    1,
  );
});
test("a process crash inside projection leaves a pending snapshot that an identical retry reconciles", async (t) => {
  const f = fixture(t);
  const state = join(f.scratch, "private state");
  const update = input();
  const updatePath = writeJson(join(state, "update.json"), update);
  const crashed = await runWorker([
    "crash-in-projection",
    writeJson(join(state, "worker-config.json"), f.config),
    updatePath,
  ]).done;
  assert.equal(crashed.code, 86, crashed.stderr);
  const service = f.service();
  const pending = service.status(statusInput);
  assert.equal(pending.state, "pending");
  assert.equal(pending.revision, 1);
  assert.equal(existsSync(f.document), false);
  assert.equal(
    f
      .database()
      .prepare("SELECT count(*) AS count FROM handoff_projection_events")
      .get()?.count,
    0,
  );
  assert.equal(service.update(update).state, "synchronized");
});
test("snapshot timestamps come from the injected clock", (t) => {
  const f = fixture(t);
  const service = createHandoffService(f.config, {
    now: () => new Date("2026-01-02T03:04:05.006Z"),
  });
  t.after(() => {
    service.close();
  });
  service.update(input());
  assert.ok(
    readFileSync(f.document, "utf8").includes(
      "- **Last Updated**: 2026-01-02T03:04:05.006Z",
    ),
  );
  const snapshot = f
    .database()
    .prepare("SELECT snapshot_json FROM handoff_snapshots")
    .get()?.snapshot_json;
  assert.equal(
    (JSON.parse(String(snapshot)) as { createdAt: string }).createdAt,
    "2026-01-02T03:04:05.006Z",
  );
});
test("terminal escapes and bidi overrides are rejected before effects", (t) => {
  const f = fixture(t);
  const service = f.service();
  for (const goal of [
    "link \u001b]8;;https://example.invalid\u0007click",
    "spoof ‮gnp.exe",
    "isolate ⁦text⁩",
    "nul \u0000 byte",
    "c1 \u009b control",
  ]) {
    const update = input();
    update.context.goal = goal;
    assert.throws(() => service.update(update), errorCode("invalid_input"));
  }
  const allowed = input();
  allowed.context.goal = "tab\tand\r\nline breaks stay";
  assert.equal(service.update(allowed).state, "synchronized");
});
test("a database anywhere inside .agent is refused", (t) => {
  const f = fixture(t);
  const agent = join(f.workspaceRoot, ".agent");
  mkdirSync(agent, { mode: 0o700 });
  for (const name of ["context.sqlite", "HANDOFF.md", "handoff.md"]) {
    assert.throws(
      () =>
        createHandoffService({ ...f.config, databasePath: join(agent, name) }),
      errorCode("unavailable"),
      name,
    );
  }
  assert.deepEqual(readdirSync(agent), []);
});
test("history keeps only this database's newest archives", (t) => {
  const f = fixture(t);
  const service = f.service();
  let status = service.update(input());
  for (let revision = 1; revision <= MAX_HANDOFF_HISTORY + 3; revision++) {
    status = service.update(input(revision, status.documentDigest));
  }
  const revisions = readdirSync(
    join(f.workspaceRoot, ".agent", "handoff-history"),
  )
    .map((name) => Number(name.split("-")[1]))
    .sort((a, b) => a - b);
  assert.equal(revisions.length, MAX_HANDOFF_HISTORY);
  // The archive for revision N holds the document revision N replaced.
  assert.equal(revisions[0], 5);
  assert.equal(revisions.at(-1), MAX_HANDOFF_HISTORY + 4);
});
test("a replaced database never prunes the archive it just wrote or another database's archives", (t) => {
  const f = fixture(t);
  const first = f.service();
  let status = first.update(input());
  for (let revision = 1; revision <= MAX_HANDOFF_HISTORY + 1; revision++) {
    status = first.update(input(revision, status.documentDigest));
  }
  first.close();
  const history = join(f.workspaceRoot, ".agent", "handoff-history");
  const before = readdirSync(history).sort();
  const manual = Buffer.from("HUMAN MANUAL NOTES\n");
  writeFileSync(f.document, manual, { mode: 0o600 });
  const replaced = createHandoffService({
    ...f.config,
    databasePath: join(f.scratch, "private state", "replacement.sqlite"),
  });
  t.after(() => {
    replaced.close();
  });
  const fresh = replaced.update(input(0, sha256(manual)));
  assert.equal(fresh.state, "synchronized");
  const after = readdirSync(history).sort();
  for (const name of before) assert.ok(after.includes(name), name);
  const added = after.filter((name) => !before.includes(name));
  assert.equal(added.length, 1);
  assert.deepEqual(readFileSync(join(history, added[0] ?? "")), manual);
});
test("database verification inside a transaction keeps SQLite's cross-process lock", (t) => {
  const f = fixture(t);
  const service = f.service();
  service.update(input());
  const holder = f.database();
  holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    // Verifies the database file and sidecars while this process holds the lock.
    assert.equal(service.status(statusInput).state, "synchronized");
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA busy_timeout = 0");
         try { db.exec("BEGIN IMMEDIATE"); process.stdout.write("acquired"); }
         catch (error) { process.stdout.write(error.errstr ?? String(error)); }`,
        f.config.databasePath,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(probe.stdout, "database is locked", probe.stderr);
  } finally {
    holder.exec("ROLLBACK");
  }
});
test("published JSON schemas accept real handoff values and reject the same invalid inputs", (t) => {
  const f = fixture(t);
  const ajv = new Ajv2020({ strict: true });
  const base = "https://github.com/adimalkar/mcp-repro-gate/schemas/";
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
  const check = (ref: string, value: unknown) => {
    const validate = ajv.getSchema(`${base}${ref}`);
    assert.ok(validate, ref);
    return validate(value) === true;
  };
  assert.ok(check("handoff-config.schema.json", f.config));
  const service = f.service();
  assert.ok(
    check("handoff.schema.json#/$defs/status", service.status(statusInput)),
  );
  const update = input();
  assert.ok(check("handoff.schema.json#/$defs/update", update));
  service.update(update);
  assert.ok(
    check(
      "handoff.schema.json#/$defs/status",
      service.status({ handoffVersion: 1, includeContext: true }),
    ),
  );
  const record = JSON.parse(
    String(
      f.database().prepare("SELECT snapshot_json FROM handoff_snapshots").get()
        ?.snapshot_json,
    ),
  ) as unknown;
  assert.ok(check("handoff.schema.json", record));
  const invalid = [
    { ...input(), target: f.document },
    { ...input(), context: { ...input().context, goal: "esc \u001b[2J" } },
    {
      ...input(),
      context: { ...input().context, touchedFiles: ["../escape"] },
    },
    {
      ...input(),
      context: { ...input().context, touchedFiles: ["/absolute"] },
    },
  ];
  for (const value of invalid) {
    assert.equal(check("handoff.schema.json#/$defs/update", value), false);
    assert.throws(() => parseHandoffUpdate(value), errorCode("invalid_input"));
  }
});
