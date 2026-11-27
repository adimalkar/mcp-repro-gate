import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod/v4";

import { canonicalJson } from "./canonical-json.js";
import { digestCanonical } from "./digest.js";
import { digestSchema } from "./git-change-contract.js";
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

const rfc3339 = z.iso.datetime({ offset: true });
const timestamp = z
  .string()
  .refine(
    (value) => rfc3339.safeParse(value.toUpperCase()).success,
    "Receipt timestamps must be RFC 3339 date-times",
  );

function timestampsInOrder(receipt: {
  startedAt: string;
  completedAt: string;
}): boolean {
  const start = Date.parse(receipt.startedAt);
  const end = Date.parse(receipt.completedAt);
  if (start !== end) return start < end;
  // Date.parse truncates fractions at milliseconds. Preserve the order of
  // the remaining digits for callers whose clock records finer precision.
  const fraction = (time: string) => /\.(\d+)/u.exec(time)?.[1] ?? "";
  const first = fraction(receipt.startedAt);
  const last = fraction(receipt.completedAt);
  const width = Math.max(first.length, last.length);
  return first.padEnd(width, "0") <= last.padEnd(width, "0");
}

const unsignedSchema = z
  .strictObject({
    receiptVersion: z.literal(1),
    executionId: z.string().min(1),
    actionId: digestSchema,
    envelopeDigest: digestSchema,
    capabilityId: z.string().min(1),
    startedAt: timestamp,
    completedAt: timestamp,
    outcome: z.enum(["succeeded", "failed"]),
    resultDigest: digestSchema,
    observedEffects: z.strictObject({
      beforeDigest: digestSchema,
      afterDigest: digestSchema,
    }),
    errorDigest: digestSchema.exactOptional(),
    signingKeyId: z.string().min(1),
  })
  .refine(timestampsInOrder, "Receipt timestamps are invalid or out of order")
  .refine(
    (receipt) =>
      (receipt.outcome === "failed") === (receipt.errorDigest !== undefined),
    "Failed receipts must contain exactly one error digest",
  );

const receiptSchema = unsignedSchema.safeExtend({
  receiptDigest: digestSchema,
  signature: z.strictObject({
    algorithm: z.literal("hmac-sha256"),
    // A 32-byte MAC encodes into 43 characters. Its last two pad bits are zero.
    value: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
  }),
});

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
  const parsed = unsignedSchema.parse(unsigned);
  const receiptDigest = digestCanonical(parsed);
  return {
    ...parsed,
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
    const {
      receiptDigest,
      signature: signed,
      ...unsigned
    } = receiptSchema.parse(receipt);
    if (digestCanonical(unsigned) !== receiptDigest) return false;
    return timingSafeEqual(
      Buffer.from(signed.value, "base64url"),
      signature(receiptDigest, secret),
    );
  } catch {
    return false;
  }
}

export function serializeReceipt(receipt: ExecutionReceiptV1): string {
  return canonicalJson(receipt);
}
