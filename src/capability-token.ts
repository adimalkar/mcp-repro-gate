import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { Digest } from "./types.js";

export interface CapabilityClaimsV1 {
  version: 1;
  jti: string;
  actionId: Digest;
  envelopeDigest: Digest;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface CapabilityBinding {
  actionId: Digest;
  envelopeDigest: Digest;
  requiredScopes: string[];
}

export interface TokenUseStore {
  consume(jti: string): boolean;
}

export class InMemoryTokenUseStore implements TokenUseStore {
  readonly #used = new Set<string>();

  consume(jti: string): boolean {
    if (this.#used.has(jti)) return false;
    this.#used.add(jti);
    return true;
  }
}

function keyBytes(secret: string | Uint8Array): Uint8Array {
  const bytes = typeof secret === "string" ? Buffer.from(secret) : secret;
  if (bytes.byteLength < 32) {
    throw new Error("Capability signing secret must contain at least 32 bytes");
  }
  return bytes;
}

function signature(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function validateClaims(value: unknown): CapabilityClaimsV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid capability token claims");
  }
  const claims = value as Partial<CapabilityClaimsV1>;
  const digestPattern = /^sha256:[0-9a-f]{64}$/u;
  if (
    claims.version !== 1 ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    typeof claims.actionId !== "string" ||
    !digestPattern.test(claims.actionId) ||
    typeof claims.envelopeDigest !== "string" ||
    !digestPattern.test(claims.envelopeDigest) ||
    !Array.isArray(claims.scopes) ||
    !claims.scopes.every((scope) => typeof scope === "string") ||
    typeof claims.issuedAt !== "string" ||
    typeof claims.expiresAt !== "string"
  ) {
    throw new Error("Invalid capability token claims");
  }
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new Error("Invalid capability token timestamps");
  }
  if (expiresAt <= issuedAt) {
    throw new Error("Capability token must expire after it is issued");
  }
  return claims as CapabilityClaimsV1;
}

export function issueCapabilityToken(
  input: Omit<CapabilityClaimsV1, "version" | "jti" | "issuedAt"> & {
    issuedAt?: string;
    jti?: string;
  },
  secret: string | Uint8Array,
): string {
  const claims: CapabilityClaimsV1 = {
    version: 1,
    jti: input.jti ?? randomUUID(),
    actionId: input.actionId,
    envelopeDigest: input.envelopeDigest,
    scopes: [...new Set(input.scopes)].sort(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
  validateClaims(claims);
  const payload = Buffer.from(canonicalJson(claims)).toString("base64url");
  const mac = signature(payload, keyBytes(secret)).toString("base64url");
  return `rg1.${payload}.${mac}`;
}

export function verifyCapabilityToken(
  token: string,
  binding: CapabilityBinding,
  secret: string | Uint8Array,
  now = new Date(),
): CapabilityClaimsV1 {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "rg1") {
    throw new Error("Malformed capability token");
  }
  const payload = parts[1];
  const encodedMac = parts[2];
  if (payload === undefined || encodedMac === undefined) {
    throw new Error("Malformed capability token");
  }

  const received = Buffer.from(encodedMac, "base64url");
  const expected = signature(payload, keyBytes(secret));
  if (
    received.byteLength !== expected.byteLength ||
    !timingSafeEqual(received, expected)
  ) {
    throw new Error("Invalid capability token signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid capability token payload");
  }

  const claims = validateClaims(parsed);

  if (claims.actionId !== binding.actionId) {
    throw new Error("Capability token is bound to a different action");
  }
  if (claims.envelopeDigest !== binding.envelopeDigest) {
    throw new Error("Capability token is bound to a different envelope");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Verification time is invalid");
  }
  if (Date.parse(claims.expiresAt) <= now.getTime()) {
    throw new Error("Capability token has expired");
  }
  if (Date.parse(claims.issuedAt) > now.getTime()) {
    throw new Error("Capability token was issued in the future");
  }

  const grantedScopes = new Set(claims.scopes);
  if (binding.requiredScopes.some((scope) => !grantedScopes.has(scope))) {
    throw new Error("Capability token does not grant all required scopes");
  }
  return claims;
}

export function verifyAndConsumeCapabilityToken(
  token: string,
  binding: CapabilityBinding,
  secret: string | Uint8Array,
  useStore: TokenUseStore,
  now = new Date(),
): CapabilityClaimsV1 {
  const claims = verifyCapabilityToken(token, binding, secret, now);
  if (!useStore.consume(claims.jti)) {
    throw new Error("Capability token has already been consumed");
  }
  return claims;
}
