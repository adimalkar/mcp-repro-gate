import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { issueCapabilityToken } from "../src/capability-token.js";
import { demoPolicy } from "../src/demo-config.js";
import type { DownstreamSession } from "../src/downstream.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import {
  ExecutionIndeterminateError,
  ReproGateExecutor,
} from "../src/executor.js";
import {
  createHeldApproval,
  heldApprovalMatches,
} from "../src/held-approval.js";
import { ReproGateKernel } from "../src/kernel.js";
import { HostMediator, MediationError } from "../src/mediation.js";
import type { CatalogTool } from "../src/types.js";

const secret = "test-secret-at-least-thirty-two-bytes-long";
const receiptSecret = "separate-receipt-secret-at-least-thirty-two-bytes-long";
const tool: CatalogTool = {
  toolRef: "echo",
  serverRef: "fixture",
  toolName: "echo",
  description: "echo",
  effects: ["local_read"],
  inputSchema: {
    $id: "https://example.invalid/echo",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

function fixture(
  t: TestContext,
  afterPreflight?: () => void,
  result: unknown = {},
) {
  const store = new SqliteExecutionStore(":memory:");
  t.after(() => {
    store.close();
  });
  const catalog = structuredClone(tool);
  const kernel = new ReproGateKernel([catalog], demoPolicy, store);
  const args = { text: "hello" };
  const plan = kernel.plan({ toolRef: tool.toolRef, arguments: args });
  let time = Date.parse(plan.envelope.plannedAt);
  const issue = (expiresAt = plan.envelope.expiresAt) => {
    const jti = randomUUID();
    const token = issueCapabilityToken(
      {
        jti,
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        scopes: [],
        issuedAt: plan.envelope.plannedAt,
        expiresAt,
      },
      secret,
    );
    return { jti, token };
  };
  const calls: Record<string, unknown>[] = [];
  const session: DownstreamSession = {
    getTool: () =>
      Promise.resolve({
        name: tool.toolName,
        inputSchema: structuredClone(tool.inputSchema),
      }),
    callTool: (_, args) => {
      calls.push(args);
      return Promise.resolve(result);
    },
    close: () => Promise.resolve(),
  };
  const clock = () => new Date(time);
  const executor = new ReproGateExecutor(
    store,
    { connect: () => Promise.resolve(session) },
    {
      snapshot: () => {
        afterPreflight?.();
        return Promise.resolve({});
      },
    },
    secret,
    receiptSecret,
    "test",
    clock,
  );
  const run = (token: string) =>
    executor.execute({
      actionId: plan.envelope.actionId,
      arguments: args,
      capabilityToken: token,
    });
  return {
    catalog,
    kernel,
    store,
    plan,
    calls,
    executor,
    clock,
    issue,
    run,
    args,
    setTime: (at: number) => {
      time = at;
    },
  };
}

for (const deadline of ["plan", "token", "held approval"] as const) {
  test(`admission rejects a ${deadline} that expires during a snapshot`, async (t) => {
    const f = fixture(t, () => {
      f.setTime(end);
    });
    const end =
      Date.parse(f.plan.envelope.expiresAt) - (deadline === "plan" ? 0 : 1000);
    if (deadline === "held approval") {
      const held = createHeldApproval(f.plan, secret, f.clock(), new Date(end));
      f.store.holdApproval(held);
      const mediator = new HostMediator(
        f.executor,
        f.kernel,
        { heldApprovals: true },
        secret,
        receiptSecret,
        f.clock,
      );
      await assert.rejects(
        mediator.run({ actionId: f.plan.envelope.actionId, arguments: f.args }),
        /expired|invalid_approval/u,
      );
      assert.equal(
        f.store.hasCapabilityUse(`host-held:${held.approvalId}`),
        false,
      );
    } else {
      const approval = f.issue(
        new Date(deadline === "plan" ? end + 1000 : end).toISOString(),
      );
      await assert.rejects(
        f.run(approval.token),
        deadline === "plan" ? /plan has expired/u : /token has expired/u,
      );
      assert.equal(f.store.hasCapabilityUse(approval.jti), false);
    }
    assert.equal(f.calls.length, 0);
  });
}

test("all catalog authority fields invalidate stale guidance and authorization", async (t) => {
  const f = fixture(t);
  const mediator = new HostMediator(
    f.executor,
    f.kernel,
    { effects: ["local_read"] },
    secret,
    receiptSecret,
    f.clock,
  );
  for (const delta of [
    { filesystemRoots: ["/fixture"] },
    { networkDestinations: ["fixture.invalid"] },
    { secretHandles: ["fixture"] },
    { sensitivityLabels: ["internal"] },
    { artifactDigest: `sha256:${"0".repeat(64)}` as const },
  ]) {
    Object.assign(f.catalog, delta);
    assert.equal(mediator.nextStep(f.plan), "stop");
    await assert.rejects(
      mediator.run({ actionId: f.plan.envelope.actionId, arguments: f.args }),
      (error) => error instanceof MediationError && error.code === "stale_plan",
    );
    for (const key of Object.keys(delta))
      Reflect.deleteProperty(f.catalog, key);
  }
  assert.equal(f.calls.length, 0);
});

test("authorization drift during preflight prevents a mediated dispatch", async (t) => {
  const f = fixture(t, () => {
    f.catalog.secretHandles = ["new"];
  });
  const mediator = new HostMediator(
    f.executor,
    f.kernel,
    { effects: ["local_read"] },
    secret,
    receiptSecret,
    f.clock,
  );
  await assert.rejects(
    mediator.run({ actionId: f.plan.envelope.actionId, arguments: f.args }),
    (error) => error instanceof MediationError && error.code === "stale_plan",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.countCapabilityUses("host-mediated:"), 0);
});

test("repeated $id schemas validate and dispatch only the approved argument snapshot", async (t) => {
  const f = fixture(t, () => {
    f.args.text = "caller changed";
  });
  for (const i of [1, 2]) {
    f.args.text = "hello";
    assert.equal((await f.run(f.issue().token)).receipt.outcome, "succeeded");
    assert.deepEqual(f.calls[i - 1], { text: "hello" });
  }
});

test("a result that cannot be journaled becomes indeterminate with a recoverable execution ID", async (t) => {
  const f = fixture(t);
  const impossible = fixture(t, undefined, BigInt(1));
  const capability = impossible.issue();
  await assert.rejects(
    impossible.run(capability.token),
    (error) =>
      error instanceof ExecutionIndeterminateError &&
      impossible.store.getExecution(error.executionId)?.state ===
        "indeterminate",
  );
  assert.equal(impossible.calls.length, 1);
  assert.equal(impossible.store.hasCapabilityUse(capability.jti), true);
  // A receipt committed before its acknowledgement failed keeps its durable outcome.
  const complete = f.store.completeExecution.bind(f.store);
  t.mock.method(
    f.store,
    "completeExecution",
    (receipt: Parameters<typeof complete>[0]) => {
      complete(receipt);
      throw new Error("completion readback failed");
    },
  );
  await assert.rejects(
    f.run(f.issue().token),
    (error) =>
      error instanceof ExecutionIndeterminateError &&
      f.store.getExecution(error.executionId)?.state === "succeeded",
  );
});

test("held approvals are usable only from their issue time onward", (t) => {
  const f = fixture(t);
  const at = new Date(f.clock().getTime() + 1000);
  const held = createHeldApproval(f.plan, secret, at);
  assert.equal(heldApprovalMatches(held, f.plan, secret, f.clock()), false);
  assert.equal(heldApprovalMatches(held, f.plan, secret, at), true);
});

test("aliases of one downstream identity must agree on policy for the same bound authority", () => {
  const alias = { ...tool, toolRef: "other-name" };
  const plan = new ReproGateKernel([tool], demoPolicy).plan({
    toolRef: tool.toolRef,
    arguments: { text: "hello" },
  });
  assert.equal(
    new ReproGateKernel([tool, alias], demoPolicy).currentDecision(
      plan.envelope,
    ),
    "allow",
  );
  const policy = {
    ...demoPolicy,
    rules: [
      ...demoPolicy.rules,
      {
        id: "deny-alias",
        priority: 100,
        match: { toolRef: alias.toolRef },
        decision: "deny" as const,
        reason: "disabled for this catalog alias",
      },
    ],
  };
  for (const entries of [
    [tool, alias],
    [alias, tool],
  ]) {
    const kernel = new ReproGateKernel(entries, policy);
    const bound = kernel.plan({
      toolRef: tool.toolRef,
      arguments: { text: "hello" },
    });
    assert.equal(kernel.currentDecision(bound.envelope), undefined);
  }
});
