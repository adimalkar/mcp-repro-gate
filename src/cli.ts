#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { issueCapabilityToken } from "./capability-token.js";
import { SqliteExecutionStore } from "./execution-store.js";
import { runGitReviewCli } from "./git-review-cli.js";
import {
  formatResearchReport,
  measurePage,
  runResearchBenchmark,
} from "./research/benchmark.js";
import {
  type SearchFunction,
  createEndpointSearch,
} from "./research/search.js";
import { createResearchServer } from "./research/server.js";
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
  if (command === "bench" && process.argv[3] === "research") {
    const usage =
      "Usage: reprogate bench research [--html <file> --query <text>] [--json]";
    const rest = process.argv.slice(4);
    let json = false;
    let htmlPath: string | undefined;
    let query: string | undefined;
    for (let index = 0; index < rest.length; index++) {
      const option = rest[index];
      if (option === "--json" && !json) {
        json = true;
        continue;
      }
      const value = rest[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(usage);
      if (option === "--html" && htmlPath === undefined) htmlPath = value;
      else if (option === "--query" && query === undefined) query = value;
      else throw new Error(usage);
    }
    if ((htmlPath === undefined) !== (query === undefined))
      throw new Error(usage);
    const report =
      htmlPath === undefined || query === undefined
        ? await runResearchBenchmark()
        : {
            rows: [await measurePage(readFileSync(htmlPath, "utf8"), query)],
          };
    process.stdout.write(
      json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatResearchReport(report),
    );
    return;
  }
  if (command === "research-server") {
    const usage =
      "Usage: reprogate research-server [--allow-host <host|.domain>]... [--search-endpoint <url-with-{query}> [--search-endpoint-private]]";
    const rest = process.argv.slice(3);
    const allowHosts: string[] = [];
    let searchEndpoint: string | undefined;
    let privateEndpoint = false;
    for (let index = 0; index < rest.length; index++) {
      const option = rest[index];
      if (option === "--search-endpoint-private" && !privateEndpoint) {
        privateEndpoint = true;
        continue;
      }
      const value = rest[++index];
      if (
        option === "--search-endpoint" &&
        value !== undefined &&
        !value.startsWith("--") &&
        searchEndpoint === undefined
      ) {
        searchEndpoint = value;
        continue;
      }
      if (
        option !== "--allow-host" ||
        value === undefined ||
        // A DNS hostname with an optional leading "." for subdomains;
        // ".", ".." and lone hyphens are refused.
        !/^\.?(?=[A-Za-z0-9.-]{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u.test(
          value,
        )
      )
        throw new Error(usage);
      allowHosts.push(value);
    }
    if (privateEndpoint && searchEndpoint === undefined) throw new Error(usage);
    let search: SearchFunction | undefined;
    if (searchEndpoint !== undefined) {
      try {
        search = createEndpointSearch({
          endpoint: searchEndpoint,
          allowPrivateEndpoint: privateEndpoint,
        });
      } catch {
        throw new Error(
          `${usage}\nThe search endpoint must be an http(s) URL without credentials, with {query} after the host.`,
        );
      }
    }
    serveStdio(() =>
      createResearchServer({
        allowHosts,
        ...(search === undefined ? {} : { search }),
      }),
    );
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
    "Usage: reprogate [serve [--config <absolute-path>] [--handoff-config <absolute-path>]|demo|approve [--config <absolute-path>] <target> <action-id>|verify-receipt [--config <absolute-path>] <receipt.json>|research-server [--allow-host <host>]... [--search-endpoint <url> [--search-endpoint-private]]|bench research [--html <file> --query <text>] [--json]|git-review <prepare|sign|import|check|revoke> ...]\n",
  );
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown command error"}\n`,
  );
  process.exitCode = 1;
});
