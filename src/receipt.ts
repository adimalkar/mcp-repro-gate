import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { digestCanonical } from "./digest.js";
import type { Digest } from "./types.js";

export type ExecutionOutcome = "succeeded" | "failed";

export interface UnsignedExecutionReceiptV1 {
  receiptVersion: 1;
  executionId: string;
  actionId: Digest;
  envelopeDigest: Digest;
  capabilityId: string;
  startedAt: string;
  completedAt: string;
  outcome: ExecutionOutcome;
  resultDigest: Digest;
  observedEffects: {
    beforeDigest: Digest;
    afterDigest: Digest;
  };
  errorDigest?: Digest;
  signingKeyId: string;
}

export interface ExecutionReceiptV1 extends UnsignedExecutionReceiptV1 {
  receiptDigest: Digest;
  signature: {
    algorithm: "hmac-sha256";
    value: string;
  };
}

function keyBytes(secret: string | Uint8Array): Uint8Array {
  const bytes = typeof secret === "string" ? Buffer.from(secret) : secret;
  if (bytes.byteLength < 32) {
    throw new Error("Receipt signing secret must contain at least 32 bytes");
  }
  return bytes;
}

function signature(digest: Digest, secret: string | Uint8Array): Buffer {
  return createHmac("sha256", keyBytes(secret)).update(digest).digest();
}

export function signExecutionReceipt(
  unsigned: UnsignedExecutionReceiptV1,
  secret: string | Uint8Array,
): ExecutionReceiptV1 {
  const startedAt = Date.parse(unsigned.startedAt);
  const completedAt = Date.parse(unsigned.completedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt
  ) {
    throw new Error("Receipt timestamps are invalid or out of order");
  }
  if (
    (unsigned.outcome === "failed") !==
    (unsigned.errorDigest !== undefined)
  ) {
    throw new Error("Failed receipts must contain exactly one error digest");
  }
  const receiptDigest = digestCanonical(unsigned);
  return {
    ...unsigned,
    receiptDigest,
    signature: {
      algorithm: "hmac-sha256",
      value: signature(receiptDigest, secret).toString("base64url"),
    },
  };
}

export function verifyExecutionReceipt(
  receipt: unknown,
  secret: string | Uint8Array,
): receipt is ExecutionReceiptV1 {
  try {
    if (receipt === null || typeof receipt !== "object") return false;
    const {
      receiptDigest,
      signature: signed,
      ...unsigned
    } = receipt as Record<string, unknown>;
    if (
      typeof receiptDigest !== "string" ||
      signed === null ||
      typeof signed !== "object"
    ) {
      return false;
    }
    const signedRecord = signed as Record<string, unknown>;
    if (
      signedRecord.algorithm !== "hmac-sha256" ||
      typeof signedRecord.value !== "string"
    ) {
      return false;
    }
    if (digestCanonical(unsigned) !== receiptDigest) return false;

    const received = Buffer.from(signedRecord.value, "base64url");
    const expected = signature(receiptDigest, secret);
    return (
      received.byteLength === expected.byteLength &&
      timingSafeEqual(received, expected)
    );
  } catch {
    return false;
  }
}

export function serializeReceipt(receipt: ExecutionReceiptV1): string {
  return canonicalJson(receipt);
}
