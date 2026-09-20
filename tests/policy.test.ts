import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePolicy } from "../src/policy.js";
import type { PolicyV1 } from "../src/types.js";

const policy: PolicyV1 = {
  version: 1,
  defaults: {
    local_read: "allow",
    local_write: "approval_required",
    process_exec: "approval_required",
    network_read: "approval_required",
    network_write: "deny",
    credential_use: "deny",
    destructive: "deny",
  },
  rules: [
    {
      id: "approved-publisher",
      priority: 10,
      match: { toolRef: "release.publish", effect: "network_write" },
      decision: "approval_required",
      reason: "Known publisher still requires a person",
    },
  ],
};

test("the most restrictive effect determines the action decision", () => {
  const result = evaluatePolicy(policy, "unknown", [
    "local_read",
    "network_write",
  ]);
  assert.equal(result.decision, "deny");
});

test("a higher-priority exact rule overrides an effect default", () => {
  const result = evaluatePolicy(policy, "release.publish", ["network_write"]);
  assert.equal(result.decision, "approval_required");
  assert.equal(result.reasons[0]?.ruleId, "approved-publisher");
});

test("conflicting rules at one priority fail closed", () => {
  const ambiguous: PolicyV1 = {
    ...policy,
    rules: [
      {
        id: "one",
        priority: 10,
        match: { effect: "local_read" },
        decision: "allow",
        reason: "one",
      },
      {
        id: "two",
        priority: 10,
        match: { effect: "local_read" },
        decision: "deny",
        reason: "two",
      },
    ],
  };
  assert.throws(
    () => evaluatePolicy(ambiguous, "anything", ["local_read"]),
    /Ambiguous policy/,
  );
});
