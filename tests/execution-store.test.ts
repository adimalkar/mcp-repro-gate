import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteExecutionStore } from "../src/execution-store.js";
import { ReproGateKernel } from "../src/kernel.js";
import { demoCatalog, demoPolicy } from "../src/demo-config.js";

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-store-"));
  return { directory, path: join(directory, "reprogate.sqlite") };
}

test("SQLite persists plans and atomically consumes a capability", (context) => {
  const { directory, path } = temporaryDatabase();
  const first = new SqliteExecutionStore(path);
  const plan = new ReproGateKernel(demoCatalog, demoPolicy, first).plan({
    toolRef: "demo.publish",
    arguments: { content: "hello" },
    runId: "durable-plan",
    now: new Date("2026-09-20T00:00:00.000Z"),
  });
  const second = new SqliteExecutionStore(path);
  context.after(() => {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(
    second.get(plan.envelope.actionId)?.envelopeDigest,
    plan.envelopeDigest,
  );
  first.beginExecution({
    actionId: plan.envelope.actionId,
    envelopeDigest: plan.envelopeDigest,
    capabilityId: "one-use-capability",
    startedAt: "2026-09-20T00:01:00.000Z",
    executionId: "execution-one",
  });
  assert.throws(
    () =>
      second.beginExecution({
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        capabilityId: "one-use-capability",
        startedAt: "2026-09-20T00:01:00.000Z",
        executionId: "execution-two",
      }),
    /already been consumed/,
  );
});

test("restart recovery marks write-ahead records indeterminate", (context) => {
  const { directory, path } = temporaryDatabase();
  const beforeCrash = new SqliteExecutionStore(path);
  const plan = new ReproGateKernel(demoCatalog, demoPolicy, beforeCrash).plan({
    toolRef: "demo.publish",
    arguments: { content: "hello" },
    runId: "crash-plan",
    now: new Date("2026-09-20T00:00:00.000Z"),
  });
  beforeCrash.beginExecution({
    actionId: plan.envelope.actionId,
    envelopeDigest: plan.envelopeDigest,
    capabilityId: "crashed-capability",
    startedAt: "2026-09-20T00:01:00.000Z",
    executionId: "crashed-execution",
  });
  beforeCrash.close();

  const afterRestart = new SqliteExecutionStore(path);
  context.after(() => {
    afterRestart.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(afterRestart.recoverIncomplete("2026-09-20T00:02:00.000Z"), 1);
  assert.equal(
    afterRestart.getExecution("crashed-execution")?.state,
    "indeterminate",
  );
});
