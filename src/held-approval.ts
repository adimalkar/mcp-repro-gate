import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { PlannedAction } from "./kernel.js";
import type { Digest } from "./types.js";

// Domain separation: a held approval's MAC input can never be a capability
// token payload, and a token can never verify as a held approval.
const DOMAIN = "reprogate.held-approval.v1\n";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface HeldApprovalV1 {
  version: 1;
  approvalId: string;
  actionId: Digest;
  envelopeDigest: Digest;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  mac: string;
}

type UnsignedHeldApproval = Omit<HeldApprovalV1, "mac">;

function keyBytes(secret: string | Uint8Array): Uint8Array {
  const bytes = typeof secret === "string" ? Buffer.from(secret) : secret;
  if (bytes.byteLength < 32)
    throw new Error("Capability secret must contain at least 32 bytes");
  return bytes;
}

function mac(
  record: UnsignedHeldApproval,
  secret: string | Uint8Array,
): Buffer {
  return createHmac("sha256", keyBytes(secret))
    .update(DOMAIN + canonicalJson(record))
    .digest();
}

function unsigned(record: HeldApprovalV1): UnsignedHeldApproval {
  return {
    version: record.version,
    approvalId: record.approvalId,
    actionId: record.actionId,
    envelopeDigest: record.envelopeDigest,
    scopes: record.scopes,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
}

/** A host-side approval of one exact plan, signed with the capability secret. */
export function createHeldApproval(
  plan: PlannedAction,
  secret: string | Uint8Array,
  now: Date = new Date(),
): HeldApprovalV1 {
  const record: UnsignedHeldApproval = {
    version: 1,
    approvalId: randomUUID(),
    actionId: plan.envelope.actionId,
    envelopeDigest: plan.envelopeDigest,
    scopes: [...new Set(plan.envelope.authority.scopes)].sort(),
    issuedAt: now.toISOString(),
    expiresAt: plan.envelope.expiresAt,
  };
  return { ...record, mac: mac(record, secret).toString("base64url") };
}

/** Parse untrusted stored JSON into a structurally valid record, or throw. */
export function parseHeldApproval(json: string): HeldApprovalV1 {
  const value: unknown = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Held approval is malformed");
  const record = value as Partial<HeldApprovalV1>;
  const keys = Object.keys(record).sort().join(",");
  if (
    keys !==
      "actionId,approvalId,envelopeDigest,expiresAt,issuedAt,mac,scopes,version" ||
    record.version !== 1 ||
    typeof record.approvalId !== "string" ||
    !UUID.test(record.approvalId) ||
    typeof record.actionId !== "string" ||
    !DIGEST.test(record.actionId) ||
    typeof record.envelopeDigest !== "string" ||
    !DIGEST.test(record.envelopeDigest) ||
    !Array.isArray(record.scopes) ||
    !record.scopes.every((scope) => typeof scope === "string") ||
    typeof record.issuedAt !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.mac !== "string" ||
    !Number.isFinite(Date.parse(record.issuedAt)) ||
    !Number.isFinite(Date.parse(record.expiresAt))
  )
    throw new Error("Held approval is malformed");
  return record as HeldApprovalV1;
}

/**
 * Whether a held approval authorizes this exact plan now. A store writer
 * without the capability secret cannot forge or alter one.
 */
export function heldApprovalMatches(
  record: HeldApprovalV1,
  plan: PlannedAction,
  secret: string | Uint8Array,
  now: Date,
): boolean {
  let presented: Buffer;
  try {
    presented = Buffer.from(record.mac, "base64url");
  } catch {
    return false;
  }
  const expected = mac(unsigned(record), secret);
  return (
    presented.length === expected.length &&
    timingSafeEqual(presented, expected) &&
    record.actionId === plan.envelope.actionId &&
    record.envelopeDigest === plan.envelopeDigest &&
    canonicalJson(record.scopes) ===
      canonicalJson([...new Set(plan.envelope.authority.scopes)].sort()) &&
    Date.parse(record.expiresAt) > now.getTime() &&
    Date.parse(record.expiresAt) <= Date.parse(plan.envelope.expiresAt)
  );
}
