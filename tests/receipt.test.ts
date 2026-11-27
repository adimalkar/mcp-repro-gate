import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { digestCanonical, sha256 } from "../src/digest.js";
import {
  signExecutionReceipt,
  verifyExecutionReceipt,
  type UnsignedExecutionReceiptV1,
} from "../src/receipt.js";

const key = "receipt-test-key-at-least-32-bytes";
const digest = sha256("test");
const payload: UnsignedExecutionReceiptV1 = {
  receiptVersion: 1,
  executionId: "one",
  actionId: digest,
  envelopeDigest: digest,
  capabilityId: "cap",
  startedAt: "2026-11-01T12:00:00.000Z",
  completedAt: "2026-11-01T12:00:01.000Z",
  outcome: "succeeded",
  resultDigest: digest,
  observedEffects: { beforeDigest: digest, afterDigest: digest },
  signingKeyId: "test-key",
};

const validateSchema = new Ajv2020({ validateFormats: false }).compile(
  JSON.parse(
    readFileSync(
      new URL("../../schemas/execution-receipt.schema.json", import.meta.url),
      "utf8",
    ),
  ) as object,
);

// Keep authentication valid while testing the independent wire-shape checks.
function authenticateFixture(fields: object) {
  const receiptDigest = digestCanonical(fields);
  return {
    ...fields,
    receiptDigest,
    signature: {
      algorithm: "hmac-sha256",
      value: createHmac("sha256", key)
        .update(receiptDigest)
        .digest("base64url"),
    },
  };
}

test("historical v1 receipts retain their canonical digest and HMAC", () => {
  const historical = {
    ...payload,
    receiptDigest:
      "sha256:871dcee1417349a161047bc2e72700f025b8ee67e43402c9f8d43ca2e502acff",
    signature: {
      algorithm: "hmac-sha256",
      value: "PVP0zyXCz00T4u00p9-oFZ5UXWRRVO7ftDwHOeRPiJU",
    },
  };
  assert.equal(verifyExecutionReceipt(historical, key), true);
  assert.deepEqual(signExecutionReceipt(payload, key), historical);
  const failed = signExecutionReceipt(
    { ...payload, outcome: "failed", errorDigest: digest },
    key,
  );
  assert.equal(verifyExecutionReceipt(failed, key), true);
  assert.equal(validateSchema(failed), true);
  assert.equal(validateSchema(historical), true);
});

test("signed receipts require every v1 field and the outcome's error evidence", () => {
  const { capabilityId, ...missingCapability } = payload;
  assert.ok(capabilityId);
  for (const fields of [
    missingCapability,
    { ...payload, receiptVersion: 2 },
    { ...payload, executionId: "" },
    { ...payload, signingKeyId: 2 },
    { ...payload, resultDigest: "sha256:invalid" },
    { ...payload, observedEffects: { beforeDigest: digest } },
    {
      ...payload,
      observedEffects: { ...payload.observedEffects, detail: "extra" },
    },
    { ...payload, extra: true },
    { ...payload, outcome: "unknown" },
    { ...payload, outcome: "failed" },
    { ...payload, errorDigest: digest },
  ]) {
    const receipt = authenticateFixture(fields);
    assert.equal(verifyExecutionReceipt(receipt, key), false);
    assert.throws(() =>
      signExecutionReceipt(fields as UnsignedExecutionReceiptV1, key),
    );
    assert.equal(validateSchema(receipt), false);
  }
});

test("receipts validate calendar timestamps and order across offsets at the supplied precision", () => {
  for (const [startedAt, completedAt] of [
    ["2026-02-30T00:00:00Z", payload.completedAt],
    ["2026-11-01", payload.completedAt],
    [payload.completedAt, payload.startedAt],
    ["2026-11-01T12:00:00.1239Z", "2026-11-01T07:00:00.12389-05:00"],
  ] as const) {
    const fields = { ...payload, startedAt, completedAt };
    assert.equal(
      verifyExecutionReceipt(authenticateFixture(fields), key),
      false,
    );
    assert.throws(() => signExecutionReceipt(fields, key));
  }
  for (const completedAt of [
    "2026-11-01T07:00:00.1239-05:00",
    "2026-11-01T12:00:00.124Z",
  ]) {
    const fields = {
      ...payload,
      startedAt: "2026-11-01t12:00:00.123900z",
      completedAt,
    };
    assert.equal(
      verifyExecutionReceipt(signExecutionReceipt(fields, key), key),
      true,
    );
  }
});

test("receipt signatures require the exact v1 shape and canonical 32-byte base64url encoding", () => {
  const receipt = signExecutionReceipt(payload, key);
  for (const signature of [
    { ...receipt.signature, extra: 1 },
    { ...receipt.signature, algorithm: "other" },
    { ...receipt.signature, value: receipt.signature.value + "=" },
    { ...receipt.signature, value: receipt.signature.value.replace("-", "+") },
    { ...receipt.signature, value: receipt.signature.value.slice(0, -1) + "V" },
  ]) {
    const alternate = { ...receipt, signature };
    assert.equal(verifyExecutionReceipt(alternate, key), false);
    assert.equal(validateSchema(alternate), false);
  }
});
