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
import { digestCanonical } from "../src/digest.js";
import type { ReproGateExecutor } from "../src/executor.js";
import { actionRunOutputSchema } from "../src/facade.js";
import { sha256File } from "../src/file-digest.js";
import {
  HostMediator,
  MediationError,
  REDACTED,
  mediationConfigSchema,
} from "../src/mediation.js";
import { ReproGateKernel } from "../src/kernel.js";
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

function unitMediator(
  maxTextBytes = 64,
  redactPatterns: string[] = [],
  secrets: [string, string] = [capabilitySecret, receiptSecret],
) {
  return new HostMediator(
    {} as ReproGateExecutor,
    new ReproGateKernel([], demoPolicy),
    mediationConfigSchema.parse({
      effects: ["local_read"],
      result: { maxTextBytes: Math.max(256, maxTextBytes), redactPatterns },
    }),
    ...secrets,
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

async function configuredRuntime(
  context: TestContext,
  mediation?: unknown,
  echoEffects: string[] = ["local_read"],
  policyDefaults: Record<string, string> = {},
) {
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
        tool("echo", echoEffects, textSchema),
        tool("publish", ["local_write"], {
          ...textSchema,
          properties: { content: { type: "string" } },
          required: ["content"],
        }),
      ],
      policy: {
        ...demoPolicy,
        defaults: { ...demoPolicy.defaults, ...policyDefaults },
      },
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

test("plans without declared effects or with unlisted effects are never mediated", async () => {
  // The kernel refuses effect-less tools, so model a tampered store row.
  const kernel = new ReproGateKernel(
    [
      {
        toolRef: "programmatic.network",
        serverRef: "programmatic",
        toolName: "network",
        description: "Network read",
        inputSchema: {},
        effects: ["network_read"],
      },
    ],
    {
      ...demoPolicy,
      defaults: { ...demoPolicy.defaults, network_read: "allow" },
    },
  );
  const network = kernel.plan({
    toolRef: "programmatic.network",
    arguments: {},
  });
  assert.equal(network.policy.decision, "allow");
  const effectless = {
    ...network,
    envelope: {
      ...network.envelope,
      actionId: `sha256:${"1".repeat(64)}`,
      authority: { ...network.envelope.authority, effects: [] },
    },
  };
  const plans = new Map<string, unknown>([
    [network.envelope.actionId, network],
    [effectless.envelope.actionId, effectless],
  ]);
  let executed = 0;
  const executor = {
    store: { get: (actionId: string) => plans.get(actionId) },
    execute: () => {
      executed++;
      return Promise.reject(new Error("must not execute"));
    },
  } as unknown as ReproGateExecutor;
  const mediator = new HostMediator(
    executor,
    kernel,
    mediationConfigSchema.parse({ effects: ["local_read"] }),
    capabilitySecret,
    receiptSecret,
  );
  for (const actionId of plans.keys()) {
    await assert.rejects(
      mediator.run({ actionId, arguments: {} }),
      (error: unknown) =>
        error instanceof MediationError && error.code === "effect_not_mediated",
      actionId,
    );
  }
  assert.equal(executed, 0);
});

test("escaped, split and partial secrets are redacted wherever they appear", () => {
  const awkward = 'cap"secret\\with-quote-and-backslash-0123456789';
  const mediator = unitMediator(4096, [], [awkward, receiptSecret]);
  const half = Math.floor(receiptSecret.length / 2);
  const bounded = mediator.bound({
    content: [
      { type: "text", text: `tail ${receiptSecret.slice(0, half)}` },
      { type: "text", text: `${receiptSecret.slice(half)} head` },
      {
        type: "text",
        text: `nested ${receiptSecret.slice(0, 20)}x${receiptSecret.slice(5)}`,
      },
    ],
    structuredContent: { value: awkward },
  });
  const visible = JSON.stringify(bounded.content);
  for (const fragment of [
    receiptSecret.slice(0, 12),
    receiptSecret.slice(-12),
    awkward.slice(0, 12),
    JSON.stringify(awkward).slice(1, 13),
    JSON.stringify(awkward).slice(-13, -1),
  ])
    assert.equal(visible.includes(fragment), false, fragment);
  assert.ok(bounded.redactions >= 4);
  assert.equal(
    mediator
      .redactMessage(`downstream said ${awkward} and ${receiptSecret}`)
      .includes("secret"),
    false,
  );
});

test("nothing after the first cut is shown", () => {
  const mediator = unitMediator(256);
  const bounded = mediator.bound({
    content: [
      // Cut to 85 three-byte characters, leaving 1 byte that "Z" would fit.
      { type: "text", text: "€".repeat(100) },
      { type: "text", text: "Z" },
    ],
  });
  assert.equal(bounded.truncated, true);
  assert.deepEqual(
    bounded.content.map((item) => item.text),
    ["€".repeat(85)],
  );
});

test("a policy or catalog change since planning withdraws mediation", async () => {
  const tool = {
    toolRef: "programmatic.read",
    serverRef: "programmatic",
    toolName: "read",
    description: "Local read",
    inputSchema: {},
    effects: ["local_read" as const],
  };
  const planning = new ReproGateKernel([tool], demoPolicy);
  const plan = planning.plan({ toolRef: tool.toolRef, arguments: {} });
  assert.equal(plan.policy.decision, "allow");
  const changes = [
    new ReproGateKernel([tool], {
      ...demoPolicy,
      defaults: { ...demoPolicy.defaults, local_read: "approval_required" },
    }),
    new ReproGateKernel(
      [{ ...tool, effects: ["local_write" as const] }],
      demoPolicy,
    ),
    new ReproGateKernel(
      [{ ...tool, inputSchema: { type: "object" } }],
      demoPolicy,
    ),
    new ReproGateKernel([], demoPolicy),
  ];
  for (const live of changes) {
    const executor = {
      store: { get: () => plan, countCapabilityUses: () => 0 },
      execute: () => Promise.reject(new Error("must not execute")),
    } as unknown as ReproGateExecutor;
    const mediator = new HostMediator(
      executor,
      live,
      mediationConfigSchema.parse({ effects: ["local_read"] }),
      capabilitySecret,
      receiptSecret,
    );
    await assert.rejects(
      mediator.run({ actionId: plan.envelope.actionId, arguments: {} }),
      (error: unknown) =>
        error instanceof MediationError && error.code === "stale_plan",
    );
  }
});

test("each plan runs at most maxRunsPerPlan times, even concurrently", async (context) => {
  const { call, plan, counts } = await configuredRuntime(context, {
    effects: ["local_read"],
  });
  const actionId = await plan("configured.echo", { text: "once" });
  const runs = await Promise.all(
    [0, 1, 2].map(() =>
      call("action.run", { actionId, arguments: { text: "once" } }),
    ),
  );
  const outcomes = runs
    .map((run) =>
      run.isError === true
        ? (JSON.parse(run.content[0]?.text ?? "") as { error: string }).error
        : "succeeded",
    )
    .sort();
  assert.deepEqual(outcomes, ["run_limit", "run_limit", "succeeded"]);
  assert.deepEqual(counts(), { executions: 1, tokenUses: 1 });
  const again = await call("action.run", {
    actionId,
    arguments: { text: "once" },
  });
  assert.deepEqual(JSON.parse(again.content[0]?.text ?? ""), {
    error: "run_limit",
  });
});

test("network reads are mediated only when allowlisted, with an open-world hint", async (context) => {
  const network = await configuredRuntime(
    context,
    { effects: ["network_read"], maxRunsPerPlan: 2 },
    ["network_read"],
    { network_read: "allow" },
  );
  const run = (await network.client.listTools()).tools.find(
    (tool) => tool.name === "action.run",
  );
  assert.equal(run?.annotations?.openWorldHint, true);
  const text = "remote";
  const actionId = await network.plan("configured.echo", { text });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await network.call("action.run", {
      actionId,
      arguments: { text },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const summary = actionRunOutputSchema.parse(result.structuredContent);
    const record = network.runtime.store.getExecution(summary.executionId);
    assert.equal(
      record?.capabilityId,
      `host-mediated:${actionId.slice(7)}:${String(attempt + 1)}`,
    );
    // The receipt covers the complete downstream result, not the view.
    assert.equal(
      summary.resultDigest,
      digestCanonical({
        content: [{ type: "text", text }],
        structuredContent: { length: text.length },
      }),
    );
  }

  const localOnly = await configuredRuntime(
    context,
    { effects: ["local_read"] },
    ["network_read"],
    { network_read: "allow" },
  );
  const refused = await localOnly.call("action.run", {
    actionId: await localOnly.plan("configured.echo", { text }),
    arguments: { text },
  });
  assert.deepEqual(JSON.parse(refused.content[0]?.text ?? ""), {
    error: "effect_not_mediated",
  });
});

test("a window cut mid-secret never shows the fragment before the cut", () => {
  const mediator = unitMediator(256);
  // Repeated secrets shrink under redaction, so the window's own end falls
  // inside the budget; shifting a pad moves that end across a secret.
  for (let pad = 0; pad < receiptSecret.length; pad++) {
    const text = `${"p".repeat(pad)}${receiptSecret.repeat(60)}`;
    const visible = mediator
      .bound({ content: [{ type: "text", text }] })
      .content.map((item) => item.text)
      .join("");
    for (let size = 4; size < 12; size++)
      assert.equal(
        visible.includes(receiptSecret.slice(0, size)),
        false,
        `${String(pad)}:${String(size)}`,
      );
  }
});

test("concurrent runs take the next free slot up to the limit", async (context) => {
  const { call, plan, counts } = await configuredRuntime(context, {
    effects: ["local_read"],
    maxRunsPerPlan: 3,
  });
  const actionId = await plan("configured.echo", { text: "slots" });
  const runs = await Promise.all(
    [0, 1, 2, 3].map(() =>
      call("action.run", { actionId, arguments: { text: "slots" } }),
    ),
  );
  assert.equal(runs.filter((run) => run.isError === undefined).length, 3);
  assert.equal(runs.filter((run) => run.isError === true).length, 1);
  assert.deepEqual(counts(), { executions: 3, tokenUses: 3 });
});
