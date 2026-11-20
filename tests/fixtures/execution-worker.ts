import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StdioMcpConnector } from "../../src/downstream.js";
import { SqliteExecutionStore } from "../../src/execution-store.js";
import {
  ExecutionIndeterminateError,
  ReproGateExecutor,
} from "../../src/executor.js";

// Usage: execution-worker <job.json>
// The job names the database, the action and capability token, the
// downstream fixture's environment, an optional start barrier and a lease.
interface Job {
  databasePath: string;
  actionId: string;
  token: string;
  capabilitySecret: string;
  receiptSecret: string;
  leaseMs?: number;
  barrier?: string;
  downstreamEnv: Record<string, string>;
}
const jobPath = process.argv[2];
if (jobPath === undefined) throw new Error("execution worker job is missing");
const job = JSON.parse(readFileSync(jobPath, "utf8")) as Job;
if (job.barrier !== undefined) {
  const deadline = Date.now() + 20_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(job.barrier)) {
    if (Date.now() > deadline) throw new Error("barrier never opened");
    Atomics.wait(pause, 0, 0, 2);
  }
}
const store = new SqliteExecutionStore(job.databasePath, {
  ...(job.leaseMs === undefined ? {} : { leaseMs: job.leaseMs }),
});
const executor = new ReproGateExecutor(
  store,
  new StdioMcpConnector({
    demo: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./downstream-server.js", import.meta.url))],
      env: job.downstreamEnv,
      stderr: "ignore",
    },
  }),
  { snapshot: () => Promise.resolve({}) },
  job.capabilitySecret,
  job.receiptSecret,
  "race-receipt-key",
);
try {
  const result = await executor.execute({
    actionId: job.actionId,
    arguments: { content: "race" },
    capabilityToken: job.token,
  });
  process.stdout.write(
    `${JSON.stringify({ outcome: result.receipt.outcome })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      indeterminate: error instanceof ExecutionIndeterminateError,
    })}\n`,
  );
} finally {
  store.close();
}
