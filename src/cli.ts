#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { issueCapabilityToken } from "./capability-token.js";
import { SqliteExecutionStore } from "./execution-store.js";
import { runArtifactDigest, runCatalogImport } from "./catalog-cli.js";
import { runGitReviewCli } from "./git-review-cli.js";
import { runHeldApproval } from "./held-approval-cli.js";
import { createHandoffService, type HandoffService } from "./handoff.js";
import {
  loadHandoffConfig,
  prepareHandoffDatabase,
  sameHandoffDatabase,
} from "./handoff-filesystem.js";
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
    const usage =
      "Usage: reprogate serve [--config <absolute-path>] [--handoff-config <absolute-path>]";
    const options = new Map<string, string>();
    const rest = process.argv.slice(3);
    for (let index = 0; index < rest.length; index += 2) {
      const option = rest[index];
      const value = rest[index + 1];
      if (
        (option !== "--config" && option !== "--handoff-config") ||
        value === undefined ||
        options.has(option)
      )
        throw new Error(usage);
      options.set(option, value);
    }
    const configPath = options.get("--config");
    const handoffConfigPath = options.get("--handoff-config");
    const handoffConfig =
      handoffConfigPath === undefined
        ? undefined
        : loadHandoffConfig(handoffConfigPath);
    // Share the runtime connection only for the same physical database, so
    // plan references resolve against the plans this server records. Prepare
    // the private database file before the runtime's SQLite connection
    // could create it with default permissions.
    const shareDatabase =
      handoffConfig !== undefined &&
      configPath !== undefined &&
      sameHandoffDatabase(
        handoffConfig.databasePath,
        loadRuntimeConfig(configPath).databasePath,
      );
    if (shareDatabase) prepareHandoffDatabase(handoffConfig.databasePath);
    const runtime =
      configPath === undefined
        ? undefined
        : await createConfiguredRuntime(configPath);
    let handoff: HandoffService | undefined;
    try {
      if (handoffConfig !== undefined) {
        handoff = createHandoffService(handoffConfig, {
          ...(shareDatabase && runtime !== undefined
            ? { store: runtime.store }
            : {}),
        });
      }
    } catch (error) {
      runtime?.close();
      throw error;
    }
    if (runtime !== undefined && runtime.recoveredExecutions > 0) {
      process.stderr.write(
        `Recovered ${String(runtime.recoveredExecutions)} incomplete execution(s) as indeterminate\n`,
      );
    }
    const handle = serveStdio(
      () =>
        createReproGateServer(
          runtime?.kernel ?? createDemoKernel(),
          runtime?.executor,
          handoff,
          runtime?.mediator,
        ),
      {
        onerror: (error) => {
          process.stderr.write(`MCP transport error: ${error.message}\n`);
        },
      },
    );
    let closed = false;
    const closeResources = (): void => {
      if (closed) return;
      closed = true;
      handoff?.close();
      runtime?.close();
    };
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void handle.close().finally(closeResources);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("exit", closeResources);
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
    const args = process.argv.slice(3);
    const usage =
      "Usage: reprogate approve [--config <absolute-path> <action-id> [--hold [--expires-in <seconds>]|--revoke-held]|<database> <action-id>]";
    // Any extra or mistyped argument is an error: falling through to the
    // token-printing path would do the opposite of the operator's intent.
    if (args.length > 3 && args[0] === "--config") {
      runHeldApproval(args, {
        stdout: (text) => process.stdout.write(text),
      });
      return;
    }
    if (args[0] === "--config") {
      const [, configPath, actionId] = args;
      if (configPath === undefined || actionId === undefined)
        throw new Error(usage);
      const config = loadRuntimeConfig(configPath);
      approve(
        config.databasePath,
        actionId,
        config.secrets.capabilitySecretEnv,
      );
      return;
    }
    const [databasePath, actionId] = args;
    if (
      databasePath === undefined ||
      actionId === undefined ||
      args.length !== 2
    )
      throw new Error(usage);
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
  if (command === "catalog" && process.argv[3] === "import") {
    await runCatalogImport(process.argv.slice(4), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
    return;
  }
  if (command === "artifact" && process.argv[3] === "digest") {
    await runArtifactDigest(process.argv.slice(4), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
    return;
  }
  if (command === "git-review") {
    process.exitCode = runGitReviewCli(process.argv.slice(3), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
    return;
  }
  process.stderr.write(
    "Usage: reprogate [serve [--config <absolute-path>] [--handoff-config <absolute-path>]|demo|approve [--config <absolute-path>] <target> <action-id>|verify-receipt [--config <absolute-path>] <receipt.json>|catalog import --config <absolute-path> --backend <name> --effects <effects> ...|artifact digest <absolute-path>|git-review <prepare|sign|import|check|revoke> ...]\n",
  );
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown command error"}\n`,
  );
  process.exitCode = 1;
});
