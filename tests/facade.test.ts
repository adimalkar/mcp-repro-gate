import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { demoCatalog, demoPolicy } from "../src/demo-config.js";
import type { ReproGateExecutor } from "../src/executor.js";
import {
  actionInspectOutputSchema,
  actionPlanOutputSchema,
  catalogDescribeOutputSchema,
  policyExplainOutputSchema,
} from "../src/facade.js";
import { ReproGateKernel } from "../src/kernel.js";
import { createReproGateServer } from "../src/server.js";

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content: { type: string; text?: string }[];
}

async function connect(
  context: TestContext,
  executor?: ReproGateExecutor,
  kernel = new ReproGateKernel(demoCatalog, demoPolicy),
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createReproGateServer(kernel, executor);
  const client = new Client({ name: "facade-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, kernel, call };
}

function textMirrorsStructured(result: ToolResult): void {
  assert.deepEqual(
    JSON.parse(result.content[0]?.text ?? ""),
    result.structuredContent,
  );
}

test("every facade tool declares an output schema and truthful annotations", async (context) => {
  const { client } = await connect(context);
  const tools = new Map(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  for (const name of [
    "catalog.search",
    "catalog.describe",
    "action.plan",
    "action.inspect",
    "policy.explain",
  ]) {
    assert.ok(tools.get(name)?.outputSchema, name);
  }
  for (const name of [
    "catalog.search",
    "catalog.describe",
    "action.inspect",
    "policy.explain",
  ]) {
    assert.equal(tools.get(name)?.annotations?.readOnlyHint, true, name);
    assert.equal(tools.get(name)?.annotations?.openWorldHint, false, name);
  }
  const plan = tools.get("action.plan")?.annotations;
  assert.equal(plan?.readOnlyHint, false);
  assert.equal(plan.destructiveHint, false);
  const search = tools.get("catalog.search");
  assert.equal(
    JSON.stringify(search?.outputSchema).includes("inputSchema"),
    false,
  );
});

test("catalog.describe returns one schema and the digest a plan binds", async (context) => {
  const { call } = await connect(context);
  const described = await call("catalog.describe", { toolRef: "demo.publish" });
  assert.equal(described.isError, undefined);
  textMirrorsStructured(described);
  const tool = catalogDescribeOutputSchema.parse(described.structuredContent);
  assert.deepEqual(
    tool.inputSchema,
    demoCatalog.find((entry) => entry.toolRef === "demo.publish")?.inputSchema,
  );
  const planned = await call("action.plan", {
    toolRef: "demo.publish",
    arguments: { content: "hello" },
    detail: "full",
  });
  const full = actionPlanOutputSchema.parse(planned.structuredContent);
  assert.equal(full.detail, "full");
  assert.equal(
    (full.envelope as unknown as { tool: { schemaDigest: string } }).tool
      .schemaDigest,
    tool.schemaDigest,
  );
  const unknown = await call("catalog.describe", { toolRef: "missing.tool" });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent, undefined);
});

test("action.plan is compact by default with full evidence on demand", async (context) => {
  const { call, kernel } = await connect(context);
  const planned = await call("action.plan", {
    toolRef: "demo.publish",
    arguments: { content: "hello" },
  });
  textMirrorsStructured(planned);
  const compact = actionPlanOutputSchema.parse(planned.structuredContent);
  assert.equal(compact.detail, "compact");
  assert.deepEqual(Object.keys(compact).sort(), [
    "actionId",
    "decision",
    "detail",
    "envelopeDigest",
    "expiresAt",
    "nextStep",
    "reasonCodes",
    "toolRef",
  ]);
  assert.equal(compact.decision, "approval_required");
  assert.equal(compact.nextStep, "plan_only");
  const stored = kernel.explain(compact.actionId);
  assert.ok(stored);
  assert.deepEqual(compact.reasonCodes, [
    ...new Set(stored.policy.reasons.map((reason) => reason.ruleId)),
  ]);
  assert.ok(
    JSON.stringify(planned).length <
      JSON.stringify({ envelope: stored.envelope, policy: stored.policy })
        .length,
  );

  const inspected = await call("action.inspect", {
    actionId: compact.actionId,
  });
  textMirrorsStructured(inspected);
  const full = actionInspectOutputSchema.parse(inspected.structuredContent);
  assert.deepEqual(full.envelope, stored.envelope);
  assert.equal(full.envelopeDigest, compact.envelopeDigest);
  assert.deepEqual(full.policy, stored.policy);

  const explained = await call("policy.explain", {
    actionId: compact.actionId,
  });
  policyExplainOutputSchema.parse(explained.structuredContent);
  for (const name of ["action.inspect", "policy.explain"]) {
    const missing = await call(name, { actionId: "sha256:missing" });
    assert.equal(missing.isError, true, name);
  }
});

test("nextStep reflects only the decision and executor configuration", async (context) => {
  const planOnly = await connect(context);
  const allowed = await planOnly.call("action.plan", {
    toolRef: "demo.read_file",
    arguments: { path: "README.md" },
  });
  const allowedPlan = actionPlanOutputSchema.parse(allowed.structuredContent);
  assert.equal(allowedPlan.nextStep, "plan_only");

  const denyCatalog = demoCatalog.map((tool) =>
    tool.toolRef === "demo.publish"
      ? { ...tool, effects: ["destructive" as const] }
      : tool,
  );
  const denied = new ReproGateKernel(denyCatalog, {
    ...demoPolicy,
    defaults: { ...demoPolicy.defaults, destructive: "deny" },
    rules: [],
  });
  for (const executor of [undefined, {} as ReproGateExecutor]) {
    const deniedServer = await connect(context, executor, denied);
    const result = await deniedServer.call("action.plan", {
      toolRef: "demo.publish",
      arguments: {},
    });
    const plan = actionPlanOutputSchema.parse(result.structuredContent);
    assert.equal(plan.detail === "compact" && plan.decision, "deny");
    assert.equal(plan.nextStep, "stop");
  }

  const withExecutor = await connect(context, {} as ReproGateExecutor);
  const awaiting = await withExecutor.call("action.plan", {
    toolRef: "demo.publish",
    arguments: { content: "hello" },
  });
  assert.equal(
    actionPlanOutputSchema.parse(awaiting.structuredContent).nextStep,
    "await_capability",
  );
  assert.equal(JSON.stringify(awaiting).includes("capabilityToken"), false);
});
