import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryTokenUseStore,
  issueCapabilityToken,
  verifyAndConsumeCapabilityToken,
} from "../src/capability-token.js";
import type { Digest } from "../src/types.js";

const secret = "correct horse battery staple plus entropy";
const actionId: Digest = `sha256:${"a".repeat(64)}`;
const envelopeDigest: Digest = `sha256:${"b".repeat(64)}`;

function token(expiresAt = "2026-09-07T01:00:00.000Z"): string {
  return issueCapabilityToken(
    {
      actionId,
      envelopeDigest,
      scopes: ["repo:write"],
      issuedAt: "2026-09-07T00:00:00.000Z",
      expiresAt,
      jti: "token-1",
    },
    secret,
  );
}

const binding = {
  actionId,
  envelopeDigest,
  requiredScopes: ["repo:write"],
};

test("a correctly bound capability is accepted exactly once", () => {
  const store = new InMemoryTokenUseStore();
  const value = token();
  assert.equal(
    verifyAndConsumeCapabilityToken(
      value,
      binding,
      secret,
      store,
      new Date("2026-09-07T00:30:00.000Z"),
    ).actionId,
    actionId,
  );
  assert.throws(
    () =>
      verifyAndConsumeCapabilityToken(
        value,
        binding,
        secret,
        store,
        new Date("2026-09-07T00:30:00.000Z"),
      ),
    /already been consumed/,
  );
});

test("a capability cannot authorize a different action", () => {
  assert.throws(
    () =>
      verifyAndConsumeCapabilityToken(
        token(),
        { ...binding, actionId: `sha256:${"c".repeat(64)}` },
        secret,
        new InMemoryTokenUseStore(),
        new Date("2026-09-07T00:30:00.000Z"),
      ),
    /different action/,
  );
});

test("expired and under-scoped capabilities are rejected", () => {
  assert.throws(
    () =>
      verifyAndConsumeCapabilityToken(
        token("2026-09-07T00:10:00.000Z"),
        binding,
        secret,
        new InMemoryTokenUseStore(),
        new Date("2026-09-07T00:30:00.000Z"),
      ),
    /expired/,
  );
  assert.throws(
    () =>
      verifyAndConsumeCapabilityToken(
        token(),
        { ...binding, requiredScopes: ["repo:write", "network:write"] },
        secret,
        new InMemoryTokenUseStore(),
        new Date("2026-09-07T00:30:00.000Z"),
      ),
    /required scopes/,
  );
});

test("payload tampering breaks the signature", () => {
  const value = token();
  const parts = value.split(".");
  assert.equal(parts.length, 3);
  const prefix = parts[0];
  const payload = parts[1];
  const mac = parts[2];
  assert.ok(prefix && payload && mac);
  assert.throws(
    () =>
      verifyAndConsumeCapabilityToken(
        `${prefix}.${payload}A.${mac}`,
        binding,
        secret,
        new InMemoryTokenUseStore(),
        new Date("2026-09-07T00:30:00.000Z"),
      ),
    /signature/,
  );
});

test("the issuer rejects invalid or non-increasing timestamps", () => {
  assert.throws(() => token("not-a-date"), /timestamps/);
  assert.throws(() => token("2026-09-07T00:00:00.000Z"), /expire after/);
});
