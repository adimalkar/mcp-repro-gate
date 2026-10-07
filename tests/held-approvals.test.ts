import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";

import { demoPolicy } from "../src/demo-config.js";
import type { ReproGateExecutor } from "../src/executor.js";
import { sha256File } from "../src/file-digest.js";
import { runHeldApproval } from "../src/held-approval-cli.js";
import { createHeldApproval } from "../src/held-approval.js";
import { ReproGateKernel } from "../src/kernel.js";
import {
  HostMediator,
  MediationError,
  mediationConfigSchema,
} from "../src/mediation.js";
import { verifyExecutionReceipt } from "../src/receipt.js";
import { createConfiguredRuntime } from "../src/runtime-config.js";
import { createReproGateServer } from "../src/server.js";

const capabilitySecret = "held-capability-secret-at-least-32-bytes!!";
const receiptSecret = "held-receipt-secret-different-32-bytes!!!!";
const environment = {
  ...process.env,
  HELD_CAPABILITY_SECRET: capabilitySecret,
  HELD_RECEIPT_SECRET: receiptSecret,
};
const schema = (field: string) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { [field]: { type: "string" } },
  required: [field],
});

async function setup(context: TestContext, mediation: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-held-"));
  const state = join(directory, "state");
  const workspace = join(directory, "workspace");
  mkdirSync(state);
  mkdirSync(workspace);
  const fixtureUrl = pathToFileURL(
    fileURLToPath(new URL("./fixtures/downstream-server.js", import.meta.url)),
  ).href;
  const artifactPath = join(state, "downstream.mjs");
  writeFileSync(artifactPath, `await import(${JSON.stringify(fixtureUrl)});\n`);
  const artifactDigest = await sha256File(artifactPath);
  const tool = (toolName: string, effects: string[], field: string) => ({
    toolRef: `configured.${toolName}`,
    serverRef: "configured",
    toolName,
    description: toolName,
    inputSchema: schema(field),
    effects,
    filesystemRoots: [workspace],
    artifactDigest,
  });
  const configPath = join(state, "runtime.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: 1,
      databasePath: join(state, "reprogate.sqlite"),
      catalog: [
        tool("echo", ["local_read"], "text"),
        tool("publish", ["local_write"], "content"),
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
      observer: { kind: "filesystem_manifest", roots: [workspace] },
      secrets: {
        capabilitySecretEnv: "HELD_CAPABILITY_SECRET",
        receiptSecretEnv: "HELD_RECEIPT_SECRET",
        receiptKeyId: "held-key",
      },
      mediation,
    }),
  );
  const runtime = await createConfiguredRuntime(configPath, environment);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createReproGateServer(
    runtime.kernel,
    runtime.executor,
    undefined,
    runtime.mediator,
  );
  const client = new Client({ name: "held-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
    runtime.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (actionId: string, args: Record<string, unknown>) =>
    (await client.callTool({
      name: "action.run",
      arguments: { actionId, arguments: args },
    })) as {
      isError?: boolean;
      structuredContent?: { executionId: string };
      content: { text?: string }[];
    };
  const code = (result: Awaited<ReturnType<typeof call>>) =>
    result.isError === true
      ? (JSON.parse(result.content[0]?.text ?? "") as { error: string }).error
      : "succeeded";
  const plan = (toolRef: string, args: Record<string, unknown>, now?: Date) =>
    runtime.kernel.plan({
      toolRef,
      arguments: args,
      ...(now === undefined ? {} : { now }),
    }).envelope.actionId;
  const lines: string[] = [];
  const cli = (args: string[], now?: Date) => {
    runHeldApproval(
      args,
      { stdout: (text) => lines.push(text) },
      environment,
      now,
    );
    return JSON.parse(lines.at(-1) ?? "") as { approvalId?: string };
  };
  const raw = () => new DatabaseSync(runtime.config.databasePath);
  const counts = () => {
    const db = raw();
    try {
      const count = (table: string) =>
        Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
      return {
        executions: count("executions"),
        tokenUses: count("token_uses"),
      };
    } finally {
      db.close();
    }
  };
  return { runtime, client, call, code, plan, cli, raw, counts, configPath };
}

test("an operator-held approval runs an approval_required write exactly once", async (context) => {
  const s = await setup(context, { heldApprovals: true });
  const tools = (await s.client.listTools()).tools;
  const run = tools.find((tool) => tool.name === "action.run");
  assert.equal(run?.annotations?.destructiveHint, true);
  assert.equal(run.annotations.openWorldHint, true);

  const args = { content: "approved" };
  const actionId = s.plan("configured.publish", args);
  assert.equal(s.code(await s.call(actionId, args)), "awaiting_approval");
  assert.deepEqual(s.counts(), { executions: 0, tokenUses: 0 });

  const held = s.cli(["--config", s.configPath, actionId, "--hold"]);
  assert.ok(held.approvalId);
  const result = await s.call(actionId, args);
  assert.equal(s.code(result), "succeeded", JSON.stringify(result.content));
  const record = s.runtime.store.getExecution(
    result.structuredContent?.executionId ?? "",
  );
  assert.equal(record?.capabilityId, `host-held:${held.approvalId ?? ""}`);
  assert.ok(record.receipt);
  assert.equal(verifyExecutionReceipt(record.receipt, receiptSecret), true);

  assert.equal(s.code(await s.call(actionId, args)), "approval_consumed");
  assert.throws(
    () => s.cli(["--config", s.configPath, actionId, "--revoke-held"]),
    /already used/u,
  );
  assert.deepEqual(s.counts(), { executions: 1, tokenUses: 1 });
});

test("concurrent runs of one held approval execute once", async (context) => {
  const s = await setup(context, { heldApprovals: true });
  const args = { content: "race" };
  const actionId = s.plan("configured.publish", args);
  s.cli(["--config", s.configPath, actionId, "--hold"]);
  const codes = (await Promise.all([0, 1, 2].map(() => s.call(actionId, args))))
    .map((result) => s.code(result))
    .sort();
  assert.deepEqual(codes, [
    "approval_consumed",
    "approval_consumed",
    "succeeded",
  ]);
  assert.deepEqual(s.counts(), { executions: 1, tokenUses: 1 });
});

test("tampered, transplanted, revoked and expired approvals never run", async (context) => {
  const s = await setup(context, { heldApprovals: true });
  const args = { content: "x" };
  const tampered = s.plan("configured.publish", args);
  s.cli(["--config", s.configPath, tampered, "--hold"]);
  const db = s.raw();
  try {
    const json = String(
      db
        .prepare("SELECT approval_json FROM held_approvals WHERE action_id = ?")
        .get(tampered)?.approval_json,
    );
    const record = JSON.parse(json) as { expiresAt: string };
    record.expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(
      "UPDATE held_approvals SET approval_json = ? WHERE action_id = ?",
    ).run(JSON.stringify(record), tampered);
    // Copy a genuine approval onto a different plan's row.
    const other = s.plan("configured.publish", { content: "other" });
    const source = s.plan("configured.publish", { content: "source" });
    s.cli(["--config", s.configPath, source, "--hold"]);
    const genuine = String(
      db
        .prepare("SELECT approval_json FROM held_approvals WHERE action_id = ?")
        .get(source)?.approval_json,
    );
    const approvalId = (JSON.parse(genuine) as { approvalId: string })
      .approvalId;
    db.prepare(
      "INSERT INTO held_approvals (action_id, approval_id, approval_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(other, `${approvalId}-copy`, genuine, new Date().toISOString());
    assert.equal(s.code(await s.call(tampered, args)), "invalid_approval");
    assert.equal(
      s.code(await s.call(other, { content: "other" })),
      "invalid_approval",
    );
  } finally {
    db.close();
  }

  const revoked = s.plan("configured.publish", { content: "revoke" });
  s.cli(["--config", s.configPath, revoked, "--hold"]);
  s.cli(["--config", s.configPath, revoked, "--revoke-held"]);
  assert.equal(
    s.code(await s.call(revoked, { content: "revoke" })),
    "awaiting_approval",
  );

  const past = new Date(Date.now() - 60 * 60 * 1000);
  const expired = s.plan("configured.publish", { content: "old" }, past);
  s.cli(["--config", s.configPath, expired, "--hold"], past);
  assert.equal(s.code(await s.call(expired, { content: "old" })), "expired");
  assert.deepEqual(s.counts(), { executions: 0, tokenUses: 0 });
});

test("hold refuses disabled config, expired, unknown and repeated approvals", async (context) => {
  const disabled = await setup(context, { effects: ["local_read"] });
  const id = disabled.plan("configured.publish", { content: "x" });
  assert.throws(
    () => disabled.cli(["--config", disabled.configPath, id, "--hold"]),
    /disabled/u,
  );
  assert.throws(
    () => disabled.cli(["--config", disabled.configPath, id]),
    /Usage/u,
  );

  const s = await setup(context, {
    effects: ["local_read"],
    heldApprovals: true,
  });
  const actionId = s.plan("configured.publish", { content: "x" });
  s.cli(["--config", s.configPath, actionId, "--hold"]);
  assert.throws(
    () => s.cli(["--config", s.configPath, actionId, "--hold"]),
    /already has a held approval/u,
  );
  assert.throws(
    () =>
      s.cli(["--config", s.configPath, `sha256:${"0".repeat(64)}`, "--hold"]),
    /Unknown actionId/u,
  );
  assert.throws(
    () =>
      s.cli([
        "--config",
        s.configPath,
        `sha256:${"0".repeat(64)}`,
        "--revoke-held",
      ]),
    /no held approval/u,
  );
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const expired = s.plan("configured.publish", { content: "old" }, past);
  assert.throws(
    () => s.cli(["--config", s.configPath, expired, "--hold"]),
    /expired/u,
  );
  // Allow-decided reads keep auto-mediation alongside held approvals.
  const echo = s.plan("configured.echo", { text: "auto" });
  assert.equal(s.code(await s.call(echo, { text: "auto" })), "succeeded");
});

test("a policy change since planning makes a held approval stale", async () => {
  const tool = {
    toolRef: "programmatic.write",
    serverRef: "programmatic",
    toolName: "write",
    description: "Write",
    inputSchema: {},
    effects: ["local_write" as const],
  };
  const planning = new ReproGateKernel([tool], demoPolicy);
  const plan = planning.plan({ toolRef: tool.toolRef, arguments: {} });
  assert.equal(plan.policy.decision, "approval_required");
  const held = createHeldApproval(plan, capabilitySecret);
  const live = new ReproGateKernel([tool], {
    ...demoPolicy,
    defaults: { ...demoPolicy.defaults, local_write: "deny" },
  });
  const executor = {
    store: { get: () => plan, getHeldApproval: () => held },
    execute: () => Promise.reject(new Error("must not execute")),
  } as unknown as ReproGateExecutor;
  const mediator = new HostMediator(
    executor,
    live,
    mediationConfigSchema.parse({ heldApprovals: true }),
    capabilitySecret,
    receiptSecret,
  );
  await assert.rejects(
    mediator.run({ actionId: plan.envelope.actionId, arguments: {} }),
    (error: unknown) =>
      error instanceof MediationError && error.code === "stale_plan",
  );
  assert.equal(mediationConfigSchema.safeParse({}).success, false);
  assert.equal(
    mediationConfigSchema.safeParse({ heldApprovals: false }).success,
    false,
  );
  assert.equal(
    mediationConfigSchema.safeParse({ heldApprovals: true }).success,
    true,
  );
});

test("the JSON schema matches the held-approval configuration rules", () => {
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../schemas/runtime-config.schema.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { $defs: { mediation: object } };
  const validate = new Ajv2020({ strict: true }).compile(
    schema.$defs.mediation,
  );
  for (const [value, valid] of [
    [{ heldApprovals: true }, true],
    [{ effects: ["local_read"], heldApprovals: true }, true],
    [{ effects: ["local_read"] }, true],
    [{}, false],
    [{ heldApprovals: false }, false],
    [{ heldApprovals: "yes" }, false],
  ] as const) {
    assert.equal(validate(value), valid, JSON.stringify(value));
    assert.equal(
      mediationConfigSchema.safeParse(value).success,
      valid,
      JSON.stringify(value),
    );
  }
});
