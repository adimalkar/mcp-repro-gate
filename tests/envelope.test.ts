import assert from "node:assert/strict";
import test from "node:test";

import { createActionEnvelope, verifyActionEnvelope } from "../src/envelope.js";
import type { UnsignedActionEnvelopeV1 } from "../src/types.js";

function unsigned(): UnsignedActionEnvelopeV1 {
  return {
    envelopeVersion: 1,
    runId: "run-1",
    principal: { host: "test", source: "transport_verified" },
    tool: {
      serverRef: "server",
      toolName: "write",
      schemaDigest: `sha256:${"a".repeat(64)}`,
      trustSource: "operator_catalog",
    },
    input: {
      argumentsDigest: `sha256:${"b".repeat(64)}`,
      sensitivityLabels: [],
    },
    authority: {
      policyDigest: `sha256:${"c".repeat(64)}`,
      effects: ["local_write"],
      scopes: ["repo:write"],
      filesystemRoots: ["/workspace"],
      networkDestinations: [],
      secretHandles: [],
    },
    plannedAt: "2026-09-07T00:00:00.000Z",
    expiresAt: "2026-09-07T00:05:00.000Z",
  };
}

test("an action id is stable for the exact same envelope", () => {
  assert.equal(
    createActionEnvelope(unsigned()).actionId,
    createActionEnvelope(unsigned()).actionId,
  );
});

test("changing any bound argument digest invalidates the action id", () => {
  const original = createActionEnvelope(unsigned());
  const changed = unsigned();
  changed.input.argumentsDigest = `sha256:${"d".repeat(64)}`;
  assert.notEqual(original.actionId, createActionEnvelope(changed).actionId);
});

test("tampering with an envelope is detectable", () => {
  const envelope = createActionEnvelope(unsigned());
  const tampered = {
    ...envelope,
    authority: { ...envelope.authority, scopes: ["admin"] },
  };
  assert.equal(verifyActionEnvelope(tampered), false);
});
