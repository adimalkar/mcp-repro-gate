import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { issueCapabilityToken } from "../src/capability-token.js";
import type {
  DownstreamConnector,
  DownstreamSession,
} from "../src/downstream.js";
import { StdioMcpConnector } from "../src/downstream.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import { ReproGateExecutor } from "../src/executor.js";
import { ReproGateKernel } from "../src/kernel.js";
import { verifyExecutionReceipt } from "../src/receipt.js";
import { demoCatalog, demoPolicy } from "../src/demo-config.js";

const capabilitySecret = "capability-secret-with-at-least-32-bytes";
const receiptSecret = "receipt-secret-with-at-least-thirty-two-bytes";
const startedAt = new Date("2026-09-20T00:01:00.000Z");
const completedAt = new Date("2026-09-20T00:02:00.000Z");

function setup(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-executor-"));
  const store = new SqliteExecutionStore(join(directory, "reprogate.sqlite"));
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const kernel = new ReproGateKernel(demoCatalog, demoPolicy, store);
  const plan = kernel.plan({
    toolRef: "demo.publish",
    arguments: { content: "hello" },
    runId: "execution-plan",
    now: new Date("2026-09-20T00:00:00.000Z"),
    ttlMs: 10 * 60 * 1000,
  });
  const token = issueCapabilityToken(
    {
      actionId: plan.envelope.actionId,
      envelopeDigest: plan.envelopeDigest,
      scopes: plan.envelope.authority.scopes,
      issuedAt: "2026-09-20T00:00:30.000Z",
      expiresAt: plan.envelope.expiresAt,
      jti: "approved-once",
    },
    capabilitySecret,
  );
  return { store, plan, token };
}

test("executes one real stdio MCP call and emits a verifiable receipt", async (context) => {
  const { store, plan, token } = setup(context);
  let snapshots = 0;
  const connector = new StdioMcpConnector({
    demo: {
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("./fixtures/downstream-server.js", import.meta.url),
        ),
      ],
    },
  });
  const executor = new ReproGateExecutor(
    store,
    connector,
    {
      snapshot: () => Promise.resolve({ sequence: snapshots++ }),
    },
    capabilitySecret,
    receiptSecret,
    "test-receipt-key",
    () => completedAt,
  );

  const result = await executor.execute({
    actionId: plan.envelope.actionId,
    arguments: { content: "hello" },
    capabilityToken: token,
    now: startedAt,
  });

  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(verifyExecutionReceipt(result.receipt, receiptSecret), true);
  assert.equal(
    store.getExecution(result.receipt.executionId)?.state,
    "succeeded",
  );
  await assert.rejects(
    executor.execute({
      actionId: plan.envelope.actionId,
      arguments: { content: "hello" },
      capabilityToken: token,
      now: startedAt,
    }),
    /already been consumed/,
  );
});

test("schema and argument changes fail before consuming approval", async (context) => {
  const { store, plan, token } = setup(context);
  let calls = 0;
  const session: DownstreamSession = {
    getTool: () =>
      Promise.resolve({
        name: "publish",
        inputSchema: {
          type: "object",
          properties: { changed: { type: "string" } },
          required: ["changed"],
          additionalProperties: false,
        },
      }),
    callTool: () => {
      calls += 1;
      return Promise.resolve({ ok: true });
    },
    close: () => Promise.resolve(),
  };
  const connector: DownstreamConnector = {
    connect: () => Promise.resolve(session),
  };
  const executor = new ReproGateExecutor(
    store,
    connector,
    { snapshot: () => Promise.resolve({}) },
    capabilitySecret,
    receiptSecret,
    "test-receipt-key",
    () => completedAt,
  );

  await assert.rejects(
    executor.execute({
      actionId: plan.envelope.actionId,
      arguments: { content: "hello" },
      capabilityToken: token,
      now: startedAt,
    }),
    /schema changed/,
  );
  await assert.rejects(
    executor.execute({
      actionId: plan.envelope.actionId,
      arguments: { content: "changed" },
      capabilityToken: token,
      now: startedAt,
    }),
    /arguments do not match/,
  );
  assert.equal(calls, 0);
  assert.equal(store.consume("approved-once"), true);
});

test("receipt tampering is detected", async (context) => {
  const { store, plan, token } = setup(context);
  const session: DownstreamSession = {
    getTool: () =>
      Promise.resolve({
        name: "publish",
        inputSchema: demoCatalog[1]?.inputSchema,
      }),
    callTool: () => Promise.resolve({ ok: true }),
    close: () => Promise.resolve(),
  };
  const executor = new ReproGateExecutor(
    store,
    { connect: () => Promise.resolve(session) },
    { snapshot: () => Promise.resolve({ observed: true }) },
    capabilitySecret,
    receiptSecret,
    "test-receipt-key",
    () => completedAt,
  );
  const { receipt } = await executor.execute({
    actionId: plan.envelope.actionId,
    arguments: { content: "hello" },
    capabilityToken: token,
    now: startedAt,
  });
  assert.equal(
    verifyExecutionReceipt({ ...receipt, outcome: "failed" }, receiptSecret),
    false,
  );
  assert.equal(verifyExecutionReceipt({}, receiptSecret), false);
});
