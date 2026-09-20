#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createDemoKernel, createReproGateServer } from "./server.js";

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
  process.stderr.write("Usage: reprogate [serve|demo]\n");
  process.exitCode = 2;
}

main();
