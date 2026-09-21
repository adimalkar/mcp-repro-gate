#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { issueCapabilityToken } from "./capability-token.js";
import { SqliteExecutionStore } from "./execution-store.js";
import { verifyExecutionReceipt } from "./receipt.js";
import {
  createConfiguredRuntime,
  loadRuntimeConfig,
} from "./runtime-config.js";
import { createDemoKernel, createReproGateServer } from "./server.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function approve(
  databasePath: string,
  actionId: string,
  secretEnvironmentName: string,
): void {
  const store = new SqliteExecutionStore(databasePath);
  try {
    const plan = store.get(actionId);
    if (plan === undefined) throw new Error(`Unknown actionId: ${actionId}`);
    if (plan.policy.decision === "deny") {
      throw new Error("Denied action plans cannot be approved");
    }
    const now = new Date();
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime()) {
      throw new Error("Cannot approve an expired action plan");
    }
    process.stdout.write(
      `${issueCapabilityToken(
        {
          actionId: plan.envelope.actionId,
          envelopeDigest: plan.envelopeDigest,
          scopes: plan.envelope.authority.scopes,
          expiresAt: plan.envelope.expiresAt,
          issuedAt: now.toISOString(),
        },
        requiredEnvironment(secretEnvironmentName),
      )}\n`,
    );
  } finally {
    store.close();
  }
}

function verifyReceiptFile(
  receiptPath: string,
  secretEnvironmentName: string,
  expectedKeyId?: string,
): void {
  const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  const signingKeyId =
    receipt !== null &&
    typeof receipt === "object" &&
    "signingKeyId" in receipt &&
    typeof receipt.signingKeyId === "string"
      ? receipt.signingKeyId
      : undefined;
  const valid =
    (expectedKeyId === undefined || signingKeyId === expectedKeyId) &&
    verifyExecutionReceipt(receipt, requiredEnvironment(secretEnvironmentName));
  process.stdout.write(`${JSON.stringify({ valid, receipt })}\n`);
  if (!valid) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") {
    const option = process.argv[3];
    if (option === undefined) {
      serveStdio(() => createReproGateServer());
      return;
    }
    const configPath = process.argv[4];
    if (option !== "--config" || configPath === undefined) {
      throw new Error("Usage: reprogate serve [--config <absolute-path>]");
    }
    const runtime = await createConfiguredRuntime(configPath);
    if (runtime.recoveredExecutions > 0) {
      process.stderr.write(
        `Recovered ${String(runtime.recoveredExecutions)} incomplete execution(s) as indeterminate\n`,
      );
    }
    const handle = serveStdio(
      () => createReproGateServer(runtime.kernel, runtime.executor),
      {
        onerror: (error) => {
          process.stderr.write(`MCP transport error: ${error.message}\n`);
        },
      },
    );
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void handle.close().finally(() => {
        runtime.close();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("exit", () => {
      runtime.close();
    });
    return;
  }
  if (command === "demo") {
    const gate = createDemoKernel();
    const read = gate.plan({
      toolRef: "demo.read_file",
      arguments: { path: "README.md" },
      runId: "demo-read",
      now: new Date("2026-09-07T00:00:00.000Z"),
    });
    const publish = gate.plan({
      toolRef: "demo.publish",
      arguments: { content: "example" },
      runId: "demo-publish",
      now: new Date("2026-09-07T00:00:00.000Z"),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          note: "Phase 1 plans and binds actions; it does not execute them.",
          read: {
            actionId: read.envelope.actionId,
            decision: read.policy.decision,
          },
          publish: {
            actionId: publish.envelope.actionId,
            decision: publish.policy.decision,
            reasons: publish.policy.reasons,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "approve") {
    if (process.argv[3] === "--config") {
      const configPath = process.argv[4];
      const actionId = process.argv[5];
      if (configPath === undefined || actionId === undefined) {
        throw new Error(
          "Usage: reprogate approve --config <absolute-path> <action-id>",
        );
      }
      const config = loadRuntimeConfig(configPath);
      approve(
        config.databasePath,
        actionId,
        config.secrets.capabilitySecretEnv,
      );
      return;
    }
    const databasePath = process.argv[3];
    const actionId = process.argv[4];
    if (databasePath === undefined || actionId === undefined) {
      throw new Error(
        "Usage: reprogate approve [--config <absolute-path> <action-id>|<database> <action-id>]",
      );
    }
    approve(databasePath, actionId, "REPROGATE_CAPABILITY_SECRET");
    return;
  }
  if (command === "verify-receipt") {
    if (process.argv[3] === "--config") {
      const configPath = process.argv[4];
      const receiptPath = process.argv[5];
      if (configPath === undefined || receiptPath === undefined) {
        throw new Error(
          "Usage: reprogate verify-receipt --config <absolute-path> <receipt.json>",
        );
      }
      const config = loadRuntimeConfig(configPath);
      verifyReceiptFile(
        receiptPath,
        config.secrets.receiptSecretEnv,
        config.secrets.receiptKeyId,
      );
      return;
    }
    const receiptPath = process.argv[3];
    if (receiptPath === undefined) {
      throw new Error("Usage: reprogate verify-receipt <receipt.json>");
    }
    verifyReceiptFile(receiptPath, "REPROGATE_RECEIPT_SECRET");
    return;
  }
  process.stderr.write(
    "Usage: reprogate [serve [--config <absolute-path>]|demo|approve [--config <absolute-path>] <target> <action-id>|verify-receipt [--config <absolute-path>] <receipt.json>]\n",
  );
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown command error"}\n`,
  );
  process.exitCode = 1;
});
