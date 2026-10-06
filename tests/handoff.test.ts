import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createReproGateServer } from "../src/server.js";
import { createHandoffService, type HandoffService } from "../src/handoff.js";
import { HandoffError, parseHandoffUpdate } from "../src/handoff-contract.js";
import { sha256 } from "../src/digest.js";
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
