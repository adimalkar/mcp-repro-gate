#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { issueCapabilityToken } from "./capability-token.js";
import { SqliteExecutionStore } from "./execution-store.js";
import { verifyExecutionReceipt, type ExecutionReceiptV1 } from "./receipt.js";
import { createDemoKernel, createReproGateServer } from "./server.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function main(): void {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") {
    serveStdio(() => createReproGateServer());
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
    const databasePath = process.argv[3];
    const actionId = process.argv[4];
    if (databasePath === undefined || actionId === undefined) {
      throw new Error("Usage: reprogate approve <database> <action-id>");
    }
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
          requiredEnvironment("REPROGATE_CAPABILITY_SECRET"),
        )}\n`,
      );
    } finally {
      store.close();
    }
    return;
  }
  if (command === "verify-receipt") {
    const receiptPath = process.argv[3];
    if (receiptPath === undefined) {
      throw new Error("Usage: reprogate verify-receipt <receipt.json>");
    }
    const receipt = JSON.parse(
      readFileSync(receiptPath, "utf8"),
    ) as ExecutionReceiptV1;
    const valid = verifyExecutionReceipt(
      receipt,
      requiredEnvironment("REPROGATE_RECEIPT_SECRET"),
    );
    process.stdout.write(`${JSON.stringify({ valid, receipt })}\n`);
    if (!valid) process.exitCode = 1;
    return;
  }
  process.stderr.write(
    "Usage: reprogate [serve|demo|approve <database> <action-id>|verify-receipt <receipt.json>]\n",
  );
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown command error"}\n`,
  );
  process.exitCode = 1;
}
