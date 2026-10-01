import { createPublicKey, KeyObject, sign, verify } from "node:crypto";

import { z } from "zod/v4";

import { canonicalJson } from "./canonical-json.js";
import { digestCanonical, sha256 } from "./digest.js";
import type { GitApprovalAuthority } from "./git-approval-store.js";
import {
  verifyGitChangeProposal,
  type GitChangeProposalV1,
} from "./git-change-proposal.js";
import type { Digest } from "./types.js";

export interface GitOperatorReviewPayloadV1 {
  reviewVersion: 1;
  audience: string;
  operatorId: string;
  keyId: Digest;
  decision: "approve" | "deny";
  proposalId: Digest;
  authorityDigest: Digest;
  effectDigest: Digest;
  issuedAt: string;
  expiresAt: string;
}

export interface GitOperatorReviewV1 {
  payload: GitOperatorReviewPayloadV1;
  signature: { algorithm: "ed25519"; value: string };
}

export interface GitOperatorReviewTrustV1 {
  audience: string;
  maxReviewTtlMs: number;
  operators: {
    operatorId: string;
    enabled: boolean;
    keys: { keyId: Digest; publicKeyPem: string; enabled: boolean }[];
    permissions: {
      repositoryId: string;
      workspaceRootDigest: Digest;
      destinationRef: string;
    }[];
  }[];
}

const DOMAIN = "ReproGate/GitOperatorReview/v1\0";
// The negative lookahead requires the actual end of input, not before a newline.
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$(?![\s\S])/u;
const REF_PATTERN =
  /^refs\/heads\/(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|\.(?:\/|$)))(?!.*\/$)[A-Za-z0-9_+@-][A-Za-z0-9_./+@-]*$(?![\s\S])/u;
const TIMESTAMP_PATTERN =
  /^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$(?![\s\S])/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$(?![\s\S])/u;
const PUBLIC_PEM_PATTERN =
  /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----(?:\r?\n)?$(?![\s\S])/u;

const digestSchema = z
  .string()
  .length(71)
  .regex(DIGEST_PATTERN)
  .transform((value) => value as Digest);
const identifierSchema = z.string().min(1).max(256).regex(IDENTIFIER_PATTERN);
const refSchema = z.string().min(12).max(1024).regex(REF_PATTERN);
const timestampSchema = z
  .string()
  .min(24)
  .max(27)
  .regex(TIMESTAMP_PATTERN)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, "Timestamp must be canonical UTC ISO-8601");
const signatureSchema = z
  .string()
  .length(86)
  .regex(SIGNATURE_PATTERN)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 && decoded.toString("base64url") === value;
  }, "Signature must encode exactly 64 bytes as canonical unpadded base64url");

const payloadSchema = z.strictObject({
  reviewVersion: z.literal(1),
  audience: identifierSchema,
  operatorId: identifierSchema,
  keyId: digestSchema,
  decision: z.enum(["approve", "deny"]),
  proposalId: digestSchema,
  authorityDigest: digestSchema,
  effectDigest: digestSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
});
const reviewSchema = z.strictObject({
  payload: payloadSchema,
  signature: z.strictObject({
    algorithm: z.literal("ed25519"),
    value: signatureSchema,
  }),
});
const trustSchema = z.strictObject({
  audience: identifierSchema,
  maxReviewTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operators: z
    .array(
      z.strictObject({
        operatorId: identifierSchema,
        enabled: z.boolean(),
        keys: z
          .array(
            z.strictObject({
              keyId: digestSchema,
              publicKeyPem: z
                .string()
                .min(1)
                .max(4096)
                .regex(PUBLIC_PEM_PATTERN),
              enabled: z.boolean(),
            }),
          )
          .max(64),
        permissions: z
          .array(
            z.strictObject({
              repositoryId: identifierSchema,
              workspaceRootDigest: digestSchema,
              destinationRef: refSchema,
            }),
          )
          .max(256),
      }),
    )
    .max(256),
});
const authoritySchema = z.strictObject({
  repositoryId: identifierSchema,
  actionId: digestSchema,
  policyDigest: digestSchema,
  workspaceRootDigest: digestSchema,
  destinationRef: refSchema,
  maxExpiresAt: timestampSchema,
});
const oidSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/u);
// The existing proposal integrity helper hashes arbitrary fields. Validate its
// required structure here as well, without treating self-hashing as authority.
const proposalSchema = z.strictObject({
  proposalVersion: z.literal(1),
  proposalId: digestSchema,
  repositoryId: identifierSchema,
  actionId: digestSchema,
  policyDigest: digestSchema,
  workspace: z.strictObject({
    source: z.literal("git_observed"),
    rootDigest: digestSchema,
    headCommit: oidSchema,
    headTree: oidSchema,
    destinationRef: refSchema,
    destinationOid: oidSchema,
    status: z.literal("clean"),
  }),
  patchDigest: digestSchema,
  allowedPaths: z.array(z.string().min(1).max(4096)).min(1).max(256),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
});

export function parseGitOperatorReviewPayload(
  value: unknown,
): GitOperatorReviewPayloadV1 {
  return payloadSchema.parse(value);
}

export function parseGitOperatorReview(value: unknown): GitOperatorReviewV1 {
  return reviewSchema.parse(value);
}

/** Public Ed25519 SPKI fingerprint; never silently converts a private key. */
export function gitOperatorKeyId(publicKey: KeyObject): Digest {
  if (
    !(publicKey instanceof KeyObject) ||
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Operator key must be a public Ed25519 KeyObject");
  }
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

/** Validate host configuration, including disabled keys, on every use. */
export function parseGitOperatorReviewTrust(
  value: unknown,
): GitOperatorReviewTrustV1 {
  try {
    const trust = trustSchema.parse(value);
    const operatorIds = new Set<string>();
    const keyIds = new Set<Digest>();
    for (const operator of trust.operators) {
      if (operatorIds.has(operator.operatorId))
        throw new Error("Duplicate operator");
      operatorIds.add(operator.operatorId);
      for (const key of operator.keys) {
        // Only an explicit public SPKI PEM is accepted. createPublicKey alone
        // would also accept private PEM and derive its public half.
        const publicKey = createPublicKey(key.publicKeyPem);
        if (
          gitOperatorKeyId(publicKey) !== key.keyId ||
          keyIds.has(key.keyId)
        ) {
          throw new Error("Mismatched or ambiguous key");
        }
        keyIds.add(key.keyId);
      }
      const permissions = new Set<Digest>();
      for (const permission of operator.permissions) {
        const id = digestCanonical(permission);
        if (permissions.has(id)) throw new Error("Duplicate permission");
        permissions.add(id);
      }
    }
    return trust;
  } catch {
    // Do not propagate parser/crypto diagnostics containing supplied key data.
    throw new Error("Invalid Git operator review host trust");
  }
}

function payloadBytes(payload: GitOperatorReviewPayloadV1): Buffer {
  return Buffer.from(DOMAIN + canonicalJson(payload), "utf8");
}

/** Digest of the exact domain-separated signed payload, not the signature. */
export function gitOperatorReviewDigest(
  payload: GitOperatorReviewPayloadV1,
): Digest {
  return sha256(payloadBytes(parseGitOperatorReviewPayload(payload)));
}

/** Signing establishes key possession only, not permission or human inspection. */
export function signGitOperatorReview(
  payload: unknown,
  privateKey: KeyObject,
): GitOperatorReviewV1 {
  const parsed = parseGitOperatorReviewPayload(payload);
  if (
    !(privateKey instanceof KeyObject) ||
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Review signer must be a private Ed25519 KeyObject");
  }
  try {
    if (gitOperatorKeyId(createPublicKey(privateKey)) !== parsed.keyId) {
      throw new Error("Key mismatch");
    }
    return {
      payload: parsed,
      signature: {
        algorithm: "ed25519",
        value: sign(null, payloadBytes(parsed), privateKey).toString(
          "base64url",
        ),
      },
    };
  } catch {
    throw new Error("Git operator review signing failed or key ID mismatched");
  }
}

/**
 * Fail-closed authentication against current host-owned trust and derived plan
 * authority. Returns the exact parsed snapshot used to verify the signature,
 * deeply frozen and detached from the caller's input, or undefined on failure.
 * Callers making decisions or persisting evidence must consume this snapshot,
 * never reread the original input. An authenticated deny remains a deny; callers
 * must check decision before granting. This proves neither human presence nor
 * inspection of the diff.
 */
export function authenticateGitOperatorReview(
  review: unknown,
  proposal: GitChangeProposalV1,
  authority: GitApprovalAuthority,
  expectedEffectDigest: Digest,
  hostTrust: unknown,
):
  | Readonly<{
      payload: Readonly<GitOperatorReviewPayloadV1>;
      signature: Readonly<GitOperatorReviewV1["signature"]>;
    }>
  | undefined {
  try {
    const parsed = parseGitOperatorReview(review);
    const trust = parseGitOperatorReviewTrust(hostTrust);
    const expectedProposal = proposalSchema.parse(proposal);
    const derivedAuthority = authoritySchema.parse(authority);
    const effectDigest = digestSchema.parse(expectedEffectDigest);
    const payload = parsed.payload;
    if (
      !verifyGitChangeProposal(expectedProposal) ||
      expectedProposal.workspace.destinationOid !==
        expectedProposal.workspace.headCommit ||
      new Set(expectedProposal.allowedPaths).size !==
        expectedProposal.allowedPaths.length ||
      expectedProposal.repositoryId !== derivedAuthority.repositoryId ||
      expectedProposal.actionId !== derivedAuthority.actionId ||
      expectedProposal.policyDigest !== derivedAuthority.policyDigest ||
      expectedProposal.workspace.rootDigest !==
        derivedAuthority.workspaceRootDigest ||
      expectedProposal.workspace.destinationRef !==
        derivedAuthority.destinationRef ||
      payload.proposalId !== expectedProposal.proposalId ||
      payload.authorityDigest !== digestCanonical(derivedAuthority) ||
      payload.effectDigest !== effectDigest ||
      payload.audience !== trust.audience
    )
      return undefined;

    const operator = trust.operators.find(
      (candidate) => candidate.operatorId === payload.operatorId,
    );
    if (!operator?.enabled) return undefined;
    const key = operator.keys.find(
      (candidate) => candidate.keyId === payload.keyId,
    );
    if (!key?.enabled) return undefined;
    if (
      !operator.permissions.some(
        (permission) =>
          permission.repositoryId === derivedAuthority.repositoryId &&
          permission.workspaceRootDigest ===
            derivedAuthority.workspaceRootDigest &&
          permission.destinationRef === derivedAuthority.destinationRef,
      )
    )
      return undefined;

    const createdAt = Date.parse(expectedProposal.createdAt);
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    const now = Date.now();
    if (
      createdAt > issuedAt ||
      issuedAt > now ||
      now >= expiresAt ||
      expiresAt > Date.parse(expectedProposal.expiresAt) ||
      expiresAt > Date.parse(derivedAuthority.maxExpiresAt) ||
      expiresAt - issuedAt > trust.maxReviewTtlMs
    )
      return undefined;

    const publicKey = createPublicKey(key.publicKeyPem);
    if (
      gitOperatorKeyId(publicKey) !== payload.keyId ||
      !verify(
        null,
        payloadBytes(payload),
        publicKey,
        Buffer.from(parsed.signature.value, "base64url"),
      )
    )
      return undefined;

    // The strict review schema has only these two nested objects; all their
    // fields are primitives. Freeze the parsed objects, not caller-owned data.
    Object.freeze(parsed.payload);
    Object.freeze(parsed.signature);
    return Object.freeze(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Boolean authentication convenience only; does not narrow the original input.
 * Callers making decisions or persisting evidence must consume the snapshot
 * returned by authenticateGitOperatorReview, never reread the original input.
 */
export function verifyGitOperatorReview(
  review: unknown,
  proposal: GitChangeProposalV1,
  authority: GitApprovalAuthority,
  expectedEffectDigest: Digest,
  hostTrust: unknown,
): boolean {
  return (
    authenticateGitOperatorReview(
      review,
      proposal,
      authority,
      expectedEffectDigest,
      hostTrust,
    ) !== undefined
  );
}
