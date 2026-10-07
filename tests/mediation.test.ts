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
import { actionRunOutputSchema } from "../src/facade.js";
import { sha256File } from "../src/file-digest.js";
import {
  HostMediator,
  REDACTED,
  mediationConfigSchema,
} from "../src/mediation.js";
import { verifyExecutionReceipt } from "../src/receipt.js";
import { createConfiguredRuntime } from "../src/runtime-config.js";
import { createReproGateServer } from "../src/server.js";

const capabilitySecret = "mediation-capability-secret-at-least-32-bytes";
const receiptSecret = "mediation-receipt-secret-different-32-bytes!";
const textSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

function unitMediator(maxTextBytes = 64, redactPatterns: string[] = []) {
  return new HostMediator(
    {} as ReproGateExecutor,
    mediationConfigSchema.parse({
      effects: ["local_read"],
      result: { maxTextBytes: Math.max(256, maxTextBytes), redactPatterns },
    }),
    capabilitySecret,
    receiptSecret,
  );
}

test("mediation configuration admits only read effects and usable patterns", () => {
  assert.ok(
    mediationConfigSchema.safeParse({ effects: ["local_read"] }).success,
  );
  for (const invalid of [
    { effects: [] },
    { effects: ["local_write"] },
    { effects: ["local_read", "local_read"] },
    { effects: ["local_read"], result: { maxTextBytes: 10 } },
    { effects: ["local_read"], result: { redactPatterns: ["(?i)x"] } },
    { effects: ["local_read"], result: { redactPatterns: ["a*"] } },
    { effects: ["local_read"], unknown: true },
  ])
    assert.equal(
      mediationConfigSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});

test("bounded results redact tokens, secrets and host patterns before cutting", () => {
  const mediator = unitMediator(256, ["[Bb]earer [A-Za-z0-9._~+/-]+=*"]);
  const bounded = mediator.bound({
    content: [
      {
        type: "text",
        text: `token rg1.abc_DEF.ghi-JKL secret ${capabilitySecret} ${receiptSecret} Bearer abc.def`,
      },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    structuredContent: { leaked: "rg1.x.y" },
  });
  const text = bounded.content.map((item) => item.text).join("\n");
  assert.equal(text.includes("rg1."), false);
  assert.equal(text.includes(capabilitySecret), false);
  assert.equal(text.includes(receiptSecret), false);
  assert.equal(text.includes("abc.def"), false);
  assert.equal(bounded.redactions, 5);
  assert.equal(bounded.omittedItems, 1);
  assert.equal(bounded.truncated, false);
  assert.ok(text.includes(REDACTED));
});

test("bounding never splits a multi-byte character and reports truncation", () => {
  const mediator = unitMediator(256);
  const bounded = mediator.bound({
    content: [
      { type: "text", text: "é".repeat(200) },
      { type: "text", text: "dropped" },
    ],
  });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.content.length, 1);
  const kept = bounded.content[0]?.text ?? "";
  assert.equal(kept, "é".repeat(128));
  assert.ok(Buffer.byteLength(kept) <= 256);
});

async function configuredRuntime(context: TestContext, mediation?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-mediation-"));
  const workspace = join(directory, "workspace");
  const state = join(directory, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const fixtureUrl = pathToFileURL(
    fileURLToPath(new URL("./fixtures/downstream-server.js", import.meta.url)),
  ).href;
  const artifactPath = join(state, "downstream.mjs");
  writeFileSync(artifactPath, `await import(${JSON.stringify(fixtureUrl)});\n`);
  const artifactDigest = await sha256File(artifactPath);
  const configPath = join(state, "runtime.json");
  const tool = (toolName: string, effects: string[], inputSchema: unknown) => ({
    toolRef: `configured.${toolName}`,
    serverRef: "configured",
    toolName,
    description: `Configured ${toolName}`,
    inputSchema,
    effects,
    filesystemRoots: [workspace],
    artifactDigest,
  });
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: 1,
      databasePath: join(state, "reprogate.sqlite"),
      catalog: [
        tool("echo", ["local_read"], textSchema),
        tool("publish", ["local_write"], {
          ...textSchema,
          properties: { content: { type: "string" } },
          required: ["content"],
        }),
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
        capabilitySecretEnv: "MEDIATION_CAPABILITY_SECRET",
        receiptSecretEnv: "MEDIATION_RECEIPT_SECRET",
        receiptKeyId: "mediation-key",
      },
      ...(mediation === undefined ? {} : { mediation }),
    }),
  );
  const runtime = await createConfiguredRuntime(configPath, {
    ...process.env,
    MEDIATION_CAPABILITY_SECRET: capabilitySecret,
    MEDIATION_RECEIPT_SECRET: receiptSecret,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createReproGateServer(
    runtime.kernel,
    runtime.executor,
    undefined,
    runtime.mediator,
  );
  const client = new Client({ name: "mediation-test", version: "1.0.0" });
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
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content: { type: string; text?: string }[];
    };
  const plan = async (toolRef: string, args: Record<string, unknown>) =>
    (
      (await call("action.plan", { toolRef, arguments: args }))
        .structuredContent as { actionId: string }
    ).actionId;
  const counts = () => {
    const db = new DatabaseSync(runtime.config.databasePath);
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
  return { runtime, client, call, plan, counts };
}

test("action.run executes an allowed read with a host-issued capability and a bounded view", async (context) => {
  const { runtime, client, call, plan } = await configuredRuntime(context, {
    effects: ["local_read"],
    result: {
      maxTextBytes: 256,
      redactPatterns: ["[Bb]earer [A-Za-z0-9._~+/-]+=*"],
    },
  });
  const tools = (await client.listTools()).tools;
  const run = tools.find((tool) => tool.name === "action.run");
  assert.ok(run);
  assert.equal(run.annotations?.openWorldHint, false);
  assert.equal(
    JSON.stringify(run.inputSchema).includes("capabilityToken"),
    false,
  );
  const text = `rg1.aaa.bbb ${capabilitySecret} Bearer xyz.123 ${"é".repeat(300)}`;
  const actionId = await plan("configured.echo", { text });
  const result = await call("action.run", { actionId, arguments: { text } });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const summary = actionRunOutputSchema.parse(result.structuredContent);
  assert.equal(summary.outcome, "succeeded");
  assert.equal(summary.truncated, true);
  assert.ok(summary.redactions >= 3);
  const visible = JSON.stringify(result);
  for (const hidden of ["rg1.aaa", capabilitySecret, "xyz.123"])
    assert.equal(visible.includes(hidden), false, hidden);
  const record = runtime.store.getExecution(summary.executionId);
  assert.ok(record?.receipt);
  assert.equal(record.state, "succeeded");
  assert.ok(record.capabilityId.startsWith("host-mediated:"));
  assert.equal(record.receipt.receiptDigest, summary.receiptDigest);
  assert.equal(record.receipt.resultDigest, summary.resultDigest);
  assert.equal(verifyExecutionReceipt(record.receipt, receiptSecret), true);
});

test("action.run refuses plans outside mediation without executing", async (context) => {
  const { runtime, call, plan, counts } = await configuredRuntime(context, {
    effects: ["local_read"],
  });
  const approval = await plan("configured.publish", { content: "x" });
  const expired = runtime.kernel.plan({
    toolRef: "configured.echo",
    arguments: { text: "old" },
    now: new Date(Date.now() - 60 * 60 * 1000),
  }).envelope.actionId;
  const echo = await plan("configured.echo", { text: "exact" });
  const cases: [string, Record<string, unknown>, string][] = [
    [approval, { content: "x" }, "not_allowed"],
    [expired, { text: "old" }, "expired"],
    [`sha256:${"0".repeat(64)}`, { text: "x" }, "unknown_action"],
  ];
  for (const [actionId, args, code] of cases) {
    const refused = await call("action.run", { actionId, arguments: args });
    assert.equal(refused.isError, true, code);
    assert.deepEqual(JSON.parse(refused.content[0]?.text ?? ""), {
      error: code,
    });
  }
  const changed = await call("action.run", {
    actionId: echo,
    arguments: { text: "different" },
  });
  assert.equal(changed.isError, true);
  assert.match(
    changed.content[0]?.text ?? "",
    /do not match the approved action/u,
  );
  assert.deepEqual(counts(), { executions: 0, tokenUses: 0 });
});

test("action.run is absent without host mediation configured", async (context) => {
  const plain = await configuredRuntime(context);
  assert.equal(
    (await plain.client.listTools()).tools.some(
      (tool) => tool.name === "action.run",
    ),
    false,
  );
});

test("the runtime configuration schema accepts and constrains mediation", () => {
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
  assert.equal(
    validate({
      effects: ["local_read", "network_read"],
      result: { maxTextBytes: 4096, redactPatterns: ["secret-[0-9]+"] },
    }),
    true,
  );
  for (const invalid of [
    { effects: ["local_write"] },
    { effects: [] },
    { effects: ["local_read"], result: { maxTextBytes: 1 } },
  ])
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
});
