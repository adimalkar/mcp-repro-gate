import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDecisionEvidence,
  verifyDecisionEvidenceChain,
  type DecisionEvidenceV1,
} from "../src/evidence.js";
import type { Digest } from "../src/types.js";

const actionId: Digest = `sha256:${"a".repeat(64)}`;
const envelopeDigest: Digest = `sha256:${"b".repeat(64)}`;
const policyDigest: Digest = `sha256:${"c".repeat(64)}`;

test("decision evidence forms a verifiable hash chain", () => {
  const chain: DecisionEvidenceV1[] = [];
  chain.push(
    appendDecisionEvidence(chain, {
      occurredAt: "2026-09-07T00:00:00.000Z",
      actionId,
      envelopeDigest,
      policyDigest,
      decision: "approval_required",
    }),
  );
  chain.push(
    appendDecisionEvidence(chain, {
      occurredAt: "2026-09-07T00:01:00.000Z",
      actionId,
      envelopeDigest,
      policyDigest,
      decision: "allow",
    }),
  );
  assert.equal(verifyDecisionEvidenceChain(chain), true);

  const tampered = chain.map((record) => ({ ...record }));
  const second = tampered[1];
  assert.ok(second);
  second.decision = "deny";
  assert.equal(verifyDecisionEvidenceChain(tampered), false);
});
