import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { issueCapabilityToken } from "../src/capability-token.js";
import { demoCatalog, demoPolicy } from "../src/demo-config.js";
import { StdioMcpConnector } from "../src/downstream.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import {
  ExecutionIndeterminateError,
  ReproGateExecutor,
} from "../src/executor.js";
import { ReproGateKernel } from "../src/kernel.js";

const capabilitySecret = "capability-secret-with-at-least-32-bytes";
const receiptSecret = "receipt-secret-with-at-least-thirty-two-bytes";
const worker = fileURLToPath(
  new URL("./fixtures/execution-worker.js", import.meta.url),
);
const downstream = fileURLToPath(
  new URL("./fixtures/downstream-server.js", import.meta.url),
);

interface WorkerResult {
  outcome?: string;
  error?: string;
  indeterminate?: boolean;
}

function setup(context: test.TestContext, jti: string) {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-races-"));
  const databasePath = join(directory, "reprogate.sqlite");
  const store = new SqliteExecutionStore(databasePath);
  // `after` hooks run in registration order, so every store a test opens is
  // closed here, before the directory goes: Windows cannot remove an open
  // database.
  const opened = [store];
  const open = (options?: { leaseMs?: number }) => {
    const another = new SqliteExecutionStore(databasePath, options);
    opened.push(another);
    return another;
  };
  context.after(() => {
    for (const entry of opened) entry.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const now = new Date();
  const plan = new ReproGateKernel(demoCatalog, demoPolicy, store).plan({
    toolRef: "demo.publish",
    arguments: { content: "race" },
    runId: `race-${jti}`,
    now,
    ttlMs: 10 * 60 * 1000,
  });
  const token = issueCapabilityToken(
    {
      actionId: plan.envelope.actionId,
      envelopeDigest: plan.envelopeDigest,
      scopes: plan.envelope.authority.scopes,
      issuedAt: now.toISOString(),
      expiresAt: plan.envelope.expiresAt,
      jti,
    },
    capabilitySecret,
  );
  const effects = join(directory, "effects.log");
  return { directory, databasePath, store, open, plan, token, effects };
}

type Setup = ReturnType<typeof setup>;

function startWorker(
  fixture: Setup,
  name: string,
  options: {
    barrier?: string;
    leaseMs?: number;
    downstreamEnv?: Record<string, string>;
  } = {},
): { child: ChildProcess; result: Promise<WorkerResult> } {
  const job = join(fixture.directory, `${name}.json`);
  writeFileSync(
    job,
    JSON.stringify({
      databasePath: fixture.databasePath,
      actionId: fixture.plan.envelope.actionId,
      token: fixture.token,
      capabilitySecret,
      receiptSecret,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.barrier === undefined ? {} : { barrier: options.barrier }),
      downstreamEnv: {
        REPROGATE_TEST_EFFECTS: fixture.effects,
        ...options.downstreamEnv,
      },
    }),
  );
  const child = spawn(process.execPath, [worker, job], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const line = stdout.trim().split("\n").at(-1);
      if (code === 0 && line !== undefined && line !== "")
        resolve(JSON.parse(line) as WorkerResult);
      else
        reject(
          new Error(
            `worker ${name} ended with ${String(code ?? signal)}: ${stderr}`,
          ),
        );
    });
  });
  return { child, result };
}

function effectLines(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function executionStates(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare("SELECT state FROM executions ORDER BY started_at")
      .all()
      .map((row) => String(row.state));
  } finally {
    database.close();
  }
}

test("processes racing one capability run the downstream call once", async (context) => {
  const fixture = setup(context, "raced-once");
  const barrier = join(fixture.directory, "go");
  const workers = Array.from({ length: 6 }, (_, index) =>
    startWorker(fixture, `racer-${String(index)}`, { barrier }),
  );
  writeFileSync(barrier, "");
  const results = await Promise.all(workers.map((entry) => entry.result));

  assert.deepEqual(
    results.filter((result) => result.outcome === "succeeded").length,
    1,
  );
  const refused = results.filter((result) => result.outcome === undefined);
  assert.equal(refused.length, 5);
  for (const result of refused) {
    assert.match(result.error ?? "", /already been consumed/u);
    assert.equal(result.indeterminate, false);
  }
  assert.equal(effectLines(fixture.effects).length, 1);
  assert.deepEqual(executionStates(fixture.databasePath), ["succeeded"]);
});

test("recovery leaves a live process's execution alone, and it completes", async (context) => {
  const fixture = setup(context, "live-owner");
  const release = join(fixture.directory, "release");
  const live = startWorker(fixture, "live", {
    leaseMs: 1000,
    downstreamEnv: {
      REPROGATE_TEST_PUBLISH: "wait",
      REPROGATE_TEST_RELEASE: release,
    },
  });
  await waitFor(
    () => effectLines(fixture.effects).length === 1,
    "the downstream effect",
  );

  // A second `serve` starting now must not declare the call indeterminate,
  // even after the lease would have lapsed without renewal.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const restarted = fixture.open();
  assert.equal(restarted.recoverIncomplete(), 0);
  assert.equal(restarted.countIncomplete(), 1);

  writeFileSync(release, "");
  assert.deepEqual(await live.result, { outcome: "succeeded" });
  assert.deepEqual(executionStates(fixture.databasePath), ["succeeded"]);
});

test("a hard-killed execution is recovered indeterminate and its capability stays spent", async (context) => {
  const fixture = setup(context, "hard-killed");
  const release = join(fixture.directory, "never");
  const victim = startWorker(fixture, "victim", {
    leaseMs: 300,
    downstreamEnv: {
      REPROGATE_TEST_PUBLISH: "wait",
      REPROGATE_TEST_RELEASE: release,
    },
  });
  await waitFor(
    () => effectLines(fixture.effects).length === 1,
    "the downstream effect",
  );
  victim.child.kill("SIGKILL");
  await assert.rejects(victim.result, /ended with/u);

  const restarted = fixture.open();
  // The killed process cannot release its lease; recovery waits it out.
  let recovered = 0;
  await waitFor(() => {
    recovered += restarted.recoverIncomplete();
    return recovered === 1;
  }, "the lapsed lease");
  assert.deepEqual(executionStates(fixture.databasePath), ["indeterminate"]);

  const retry = startWorker(fixture, "retry");
  const result = await retry.result;
  assert.match(result.error ?? "", /already been consumed/u);
  assert.equal(effectLines(fixture.effects).length, 1);
});

test("a downstream that exits after its effect leaves the run indeterminate", async (context) => {
  const fixture = setup(context, "lost-response");
  const executor = new ReproGateExecutor(
    fixture.store,
    new StdioMcpConnector({
      demo: {
        command: process.execPath,
        args: [downstream],
        env: {
          REPROGATE_TEST_EFFECTS: fixture.effects,
          REPROGATE_TEST_PUBLISH: "exit-before-reply",
        },
        stderr: "ignore",
      },
    }),
    { snapshot: () => Promise.resolve({}) },
    capabilitySecret,
    receiptSecret,
    "race-receipt-key",
  );
  const run = () =>
    executor.execute({
      actionId: fixture.plan.envelope.actionId,
      arguments: { content: "race" },
      capabilityToken: fixture.token,
    });

  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof ExecutionIndeterminateError);
  assert.equal(
    fixture.store.getExecution(error.executionId)?.state,
    "indeterminate",
  );
  assert.equal(effectLines(fixture.effects).length, 1);
  // The effect may have happened, so the approval is never reusable.
  await assert.rejects(run(), /already been consumed/u);
  assert.equal(effectLines(fixture.effects).length, 1);
});

test("leases: a closed owner's and a legacy execution are recovered, the store's own are not", (context) => {
  const fixture = setup(context, "lease-unit");
  const begin = (store: SqliteExecutionStore, capabilityId: string) =>
    store.beginExecution({
      actionId: fixture.plan.envelope.actionId,
      envelopeDigest: fixture.plan.envelopeDigest,
      capabilityId,
      startedAt: new Date().toISOString(),
      executionId: capabilityId,
    });

  const owner = fixture.open();
  // A first attempt that rolls back (spent capability) must not leave the
  // owner's later executions without a live owner.
  fixture.store.consume("spent");
  assert.throws(() => begin(owner, "spent"), /already been consumed/u);
  assert.equal(owner.executionOwnerId, undefined);
  begin(owner, "owned");
  begin(fixture.store, "own");
  assert.notEqual(owner.executionOwnerId, undefined);

  // Neither the live owner's execution nor this store's own is recovered.
  assert.equal(fixture.store.recoverIncomplete(), 0);
  owner.close();
  assert.equal(fixture.store.recoverIncomplete(), 1);
  assert.equal(fixture.store.getExecution("owned")?.state, "indeterminate");
  assert.equal(fixture.store.getExecution("own")?.state, "prepared");

  // A row written before ownership existed has no owner: abandoned.
  const raw = new DatabaseSync(fixture.databasePath);
  raw.exec(
    "INSERT INTO token_uses (capability_id, consumed_at) VALUES ('legacy', '2026-01-01T00:00:00.000Z')",
  );
  raw
    .prepare(
      "INSERT INTO executions (execution_id, action_id, envelope_digest, capability_id, state, started_at) VALUES ('legacy', ?, ?, 'legacy', 'prepared', '2026-01-01T00:00:00.000Z')",
    )
    .run(fixture.plan.envelope.actionId, fixture.plan.envelopeDigest);
  raw.close();
  assert.equal(fixture.store.recoverIncomplete(), 1);
  assert.equal(fixture.store.getExecution("legacy")?.state, "indeterminate");
  assert.equal(fixture.store.countIncomplete(), 1);
  assert.throws(() => fixture.open({ leaseMs: 1 }), /at least 30 ms/u);
});

test("a database from before execution ownership opens and recovers as before", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-legacy-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "reprogate.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE plans (action_id TEXT PRIMARY KEY, envelope_digest TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE token_uses (capability_id TEXT PRIMARY KEY, consumed_at TEXT NOT NULL) STRICT;
    CREATE TABLE executions (
      execution_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, envelope_digest TEXT NOT NULL,
      capability_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'succeeded', 'failed', 'indeterminate')),
      started_at TEXT NOT NULL, completed_at TEXT, receipt_json TEXT,
      FOREIGN KEY (action_id) REFERENCES plans(action_id),
      FOREIGN KEY (capability_id) REFERENCES token_uses(capability_id)
    ) STRICT;
    INSERT INTO plans VALUES ('a', 'sha256:x', '{}', '2026-01-01T00:00:00.000Z');
    INSERT INTO token_uses VALUES ('c', '2026-01-01T00:00:00.000Z');
    INSERT INTO executions (execution_id, action_id, envelope_digest, capability_id, state, started_at)
      VALUES ('e', 'a', 'sha256:x', 'c', 'prepared', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const store = new SqliteExecutionStore(path);
  try {
    assert.equal(store.recoverIncomplete(), 1);
    assert.equal(store.getExecution("e")?.state, "indeterminate");
  } finally {
    store.close();
  }
});
