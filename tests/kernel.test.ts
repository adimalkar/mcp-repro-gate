import assert from "node:assert/strict";
import test from "node:test";

import { createDemoKernel } from "../src/server.js";

test("catalog search returns a stable, bounded facade", () => {
  const kernel = createDemoKernel();
  assert.deepEqual(
    kernel.search("publish", 1).map((tool) => tool.toolRef),
    ["demo.publish"],
  );
});

test("planning binds trusted catalog schema and policy to arguments", () => {
  const kernel = createDemoKernel();
  const first = kernel.plan({
    toolRef: "demo.publish",
    arguments: { content: "one" },
    runId: "run",
    now: new Date("2026-09-07T00:00:00.000Z"),
  });
  const second = kernel.plan({
    toolRef: "demo.publish",
    arguments: { content: "two" },
    runId: "run",
    now: new Date("2026-09-07T00:00:00.000Z"),
  });
  assert.equal(first.policy.decision, "approval_required");
  assert.notEqual(first.envelope.actionId, second.envelope.actionId);
  assert.equal(first.envelope.tool.trustSource, "operator_catalog");
});

test("unknown tools are rejected instead of being planned from caller metadata", () => {
  assert.throws(
    () =>
      createDemoKernel().plan({
        toolRef: "caller.supplied",
        arguments: {},
      }),
    /Unknown catalog tool/,
  );
});
