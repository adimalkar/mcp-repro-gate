import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as z from "zod/v4";

import { canonicalJson } from "./canonical-json.js";
import { digestSchema } from "./git-change-contract.js";
import type { GitChangeProposal } from "./git-change-proposal.js";
import { digestCanonical, sha256 } from "./digest.js";
import {
  authenticateGitOperatorReview,
  gitOperatorKeyId,
  gitOperatorReviewDigest,
  parseGitOperatorReview,
  parseGitOperatorReviewTrust,
  type GitOperatorReviewV1,
} from "./git-operator-review.js";
import {
  gitPromotionAttemptEvidence,
  parseGitPromotionAttemptEvidence,
  parseGitPromotionRecords,
  type GitPromotionAdmissionV1,
  type GitPromotionAttemptEvidenceV1,
  type GitPromotionOutcomeV1,
  type GitPromotionStatusV1,
  type ImmutablePromotion,
} from "./git-promotion-contract.js";
import { runGit } from "./git-runner.js";
import type { Digest } from "./types.js";

/**
 * What a promotion bundle's claim covers. The Git ref transition is enforced
 * by the gate's compare-and-swap; the candidate objects are observed; no
 * other effect of the agent or the host is covered.
 */
export const GIT_PROMOTION_EVIDENCE_COVERAGE = Object.freeze({
  gitRef: "enforced",
  candidateObjects: "observed",
  filesystem: "not_covered",
  process: "not_covered",
  network: "not_covered",
  credentials: "not_covered",
} as const);

const SIGNATURE_DOMAIN = "reprogate.git-promotion-evidence.v1\n";
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const timestampSchema = z.iso.datetime({ offset: false, precision: 3 });

export interface GitPromotionEvidenceManifestV1 {
  manifestVersion: 1;
  attemptId: string;
  repositoryId: string;
  destinationRef: string;
  review: GitOperatorReviewV1;
  attempt: ImmutablePromotion<GitPromotionAttemptEvidenceV1>;
  admission?: GitPromotionAdmissionV1;
  outcome: GitPromotionOutcomeV1;
  coverage: typeof GIT_PROMOTION_EVIDENCE_COVERAGE;
  exportedAt: string;
  hostKeyId: Digest;
}

export interface GitPromotionEvidenceV1 {
  bundleVersion: 1;
  manifest: GitPromotionEvidenceManifestV1;
  manifestDigest: Digest;
  signature: { algorithm: "ed25519"; value: string };
}

function signedBytes(manifestDigest: Digest): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}${manifestDigest}`);
}

/**
 * Build and sign a bundle for one resolved promotion. The host signs only
 * records already in its ledger; the signature attests what that ledger
 * holds, not an independent observation.
 */
export function exportGitPromotionEvidence(input: {
  status: ImmutablePromotion<GitPromotionStatusV1>;
  review: GitOperatorReviewV1;
  signingKey: KeyObject;
  exportedAt?: Date;
}): GitPromotionEvidenceV1 {
  const { status, signingKey } = input;
  if (status.outcome === undefined)
    throw new Error("Only a resolved promotion attempt can be exported");
  if (
    signingKey.type !== "private" ||
    signingKey.asymmetricKeyType !== "ed25519"
  )
    throw new Error("Evidence signing key must be an Ed25519 private key");
  const review = parseGitOperatorReview(input.review);
  if (gitOperatorReviewDigest(review.payload) !== status.attempt.reviewDigest)
    throw new Error("Review does not belong to this promotion attempt");
  const attempt = gitPromotionAttemptEvidence(status.attempt);
  const manifest: GitPromotionEvidenceManifestV1 = {
    manifestVersion: 1,
    attemptId: attempt.attemptId,
    repositoryId: attempt.proposal.repositoryId,
    destinationRef: attempt.authority.destinationRef,
    review,
    attempt,
    ...(status.admission === undefined ? {} : { admission: status.admission }),
    outcome: status.outcome,
    coverage: GIT_PROMOTION_EVIDENCE_COVERAGE,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    hostKeyId: gitOperatorKeyId(createPublicKey(signingKey)),
  };
  const manifestDigest = digestCanonical(manifest);
  return {
    bundleVersion: 1,
    manifest,
    manifestDigest,
    signature: {
      algorithm: "ed25519",
      value: sign(null, signedBytes(manifestDigest), signingKey).toString(
        "base64url",
      ),
    },
  };
}

const publicKeyPemSchema = z.string().min(1).max(4096);
const trustSchema = z.strictObject({
  evidenceTrustVersion: z.literal(1),
  hostKeys: z
    .array(
      z.strictObject({ keyId: digestSchema, publicKeyPem: publicKeyPemSchema }),
    )
    .min(1)
    .max(64),
  review: z.unknown(),
});

/** Public keys a verifier accepts: host evidence keys and operator trust. */
export type GitPromotionEvidenceTrustV1 = z.infer<typeof trustSchema>;

function parseTrust(value: unknown) {
  const trust = trustSchema.parse(value);
  const review = parseGitOperatorReviewTrust(trust.review);
  const operatorKeys = new Set(
    review.operators.flatMap((operator) =>
      operator.keys.map((key) => key.keyId),
    ),
  );
  const hostKeys = new Map<string, KeyObject>();
  for (const key of trust.hostKeys) {
    const publicKey = createPublicKey(key.publicKeyPem);
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      gitOperatorKeyId(publicKey) !== key.keyId ||
      hostKeys.has(key.keyId) ||
      operatorKeys.has(key.keyId)
    )
      throw new Error(
        "Evidence trust host keys must be distinct Ed25519 keys, matching their key IDs, and not operator keys",
      );
    hostKeys.set(key.keyId, publicKey);
  }
  return { review: trust.review, hostKeys };
}

const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  attemptId: z.string(),
  repositoryId: z.string(),
  destinationRef: z.string(),
  review: z.unknown(),
  attempt: z.unknown(),
  admission: z.unknown().optional(),
  outcome: z.unknown(),
  coverage: z.unknown(),
  exportedAt: timestampSchema,
  hostKeyId: digestSchema,
});
const bundleSchema = z.strictObject({
  bundleVersion: z.literal(1),
  manifest: z.record(z.string(), z.unknown()),
  manifestDigest: digestSchema,
  signature: z.strictObject({
    algorithm: z.literal("ed25519"),
    value: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  }),
});

export type GitPromotionEvidenceResult =
  "verified" | "unchecked_effect" | "indeterminate" | "failed";

export interface GitPromotionEvidenceCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface GitPromotionEvidenceReport {
  result: GitPromotionEvidenceResult;
  manifestDigest?: Digest;
  attemptId?: string;
  outcome?: GitPromotionOutcomeV1["state"];
  checks: GitPromotionEvidenceCheck[];
}

class CheckFailed extends Error {}

/**
 * Verify a promotion bundle offline with public keys only. Checks stop at
 * the first failure. The effect checks read objects from a repository the
 * verifier trusts (never a working tree) and, with a patch, recompute the
 * staged tree in a disposable clone.
 */
export function verifyGitPromotionEvidence(
  bundle: unknown,
  trustInput: unknown,
  options: { repositoryPath?: string; patch?: Uint8Array } = {},
): GitPromotionEvidenceReport {
  const checks: GitPromotionEvidenceCheck[] = [];
  const report: GitPromotionEvidenceReport = { result: "failed", checks };
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({
      check: name,
      ok,
      ...(detail === undefined ? {} : { detail }),
    });
    if (!ok) throw new CheckFailed(name);
  };
  const attemptTo = <T>(name: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof CheckFailed) throw error;
      check(name, false, error instanceof Error ? error.message : undefined);
      throw new CheckFailed(name);
    }
  };
  try {
    const trust = attemptTo("trust", () => parseTrust(trustInput));
    const parsed = attemptTo("bundle_schema", () => {
      if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES)
        throw new Error("Bundle is too large");
      return bundleSchema.parse(bundle);
    });
    report.manifestDigest = parsed.manifestDigest;
    check(
      "manifest_digest",
      digestCanonical(parsed.manifest) === parsed.manifestDigest,
    );
    const hostKey = trust.hostKeys.get(String(parsed.manifest.hostKeyId));
    check(
      "host_signature",
      hostKey !== undefined &&
        verify(
          null,
          signedBytes(parsed.manifestDigest),
          hostKey,
          Buffer.from(parsed.signature.value, "base64url"),
        ),
      hostKey === undefined ? "host key is not trusted" : undefined,
    );

    const manifest = attemptTo("manifest_schema", () => {
      const m = manifestSchema.parse(parsed.manifest);
      const attempt = parseGitPromotionAttemptEvidence(m.attempt);
      const review = parseGitOperatorReview(m.review);
      const { admission, outcome } = parseGitPromotionRecords(
        attempt,
        m.admission === undefined ? null : canonicalJson(m.admission),
        canonicalJson(m.outcome),
      );
      if (outcome === undefined) throw new Error("Bundle has no outcome");
      if (
        canonicalJson(m.coverage) !==
        canonicalJson(GIT_PROMOTION_EVIDENCE_COVERAGE)
      )
        throw new Error("Unexpected coverage statement");
      if (
        m.attemptId !== attempt.attemptId ||
        m.repositoryId !== attempt.proposal.repositoryId ||
        m.destinationRef !== attempt.authority.destinationRef ||
        Date.parse(m.exportedAt) < Date.parse(outcome.decidedAt)
      )
        throw new Error("Manifest header does not match its records");
      return { ...m, attempt, review, admission, outcome };
    });
    report.attemptId = manifest.attemptId;
    report.outcome = manifest.outcome.state;
    const { attempt, review, admission, outcome } = manifest;

    check(
      "review_links",
      gitOperatorReviewDigest(review.payload) === attempt.reviewDigest &&
        review.payload.decision === "approve" &&
        digestCanonical(attempt.prepared.staged) === attempt.effectDigest,
    );
    // Validity at the moment the host admitted the attempt; an attempt that
    // was never admitted is judged at its reservation.
    const at = Date.parse(admission?.admittedAt ?? attempt.reservedAt);
    check(
      "operator_review",
      authenticateGitOperatorReview(
        review,
        // The verifier only reads these frozen snapshots.
        attempt.proposal as GitChangeProposal,
        attempt.authority,
        attempt.effectDigest,
        trust.review,
        at,
      ) !== undefined,
      admission === undefined
        ? "checked at reservation; the attempt was never admitted"
        : undefined,
    );

    if (outcome.state !== "confirmed") {
      report.result = "indeterminate";
      return report;
    }
    if (options.repositoryPath === undefined && options.patch === undefined) {
      report.result = "unchecked_effect";
      return report;
    }
    if (options.patch !== undefined)
      check(
        "patch_digest",
        sha256(options.patch) === attempt.proposal.patchDigest,
      );
    if (options.repositoryPath !== undefined) {
      const repository = options.repositoryPath;
      const prepared = attempt.prepared;
      attemptTo("candidate_commit", () => {
        const raw = runGit([
          "-C",
          repository,
          "cat-file",
          "commit",
          prepared.candidateCommitOid,
        ]);
        const header = raw.toString("utf8").split("\n\n", 1)[0] ?? "";
        const parents = header
          .split("\n")
          .filter((line) => line.startsWith("parent "));
        if (
          sha256(raw) !== prepared.hostCommitMetadataDigest ||
          !header.startsWith(`tree ${prepared.candidateTreeOid}\n`) ||
          parents.length !== 1 ||
          parents[0] !== `parent ${prepared.expectedOldOid}`
        )
          throw new Error(
            "Candidate commit is not the staged tree on the expected parent",
          );
        checks.push({ check: "candidate_commit", ok: true });
      });
      attemptTo("staged_diff", () => {
        const diff = runGit([
          "-C",
          repository,
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          prepared.baseCommit,
          prepared.candidateTreeOid,
          "--",
        ]);
        if (sha256(diff) !== prepared.staged.stagedPatchDigest)
          throw new Error("Diff does not match the staged patch digest");
        checks.push({ check: "staged_diff", ok: true });
      });
      if (options.patch !== undefined) {
        const patch = options.patch;
        attemptTo("patch_applies", () => {
          if (
            applyPatchTree(repository, prepared.baseCommit, patch) !==
            prepared.candidateTreeOid
          )
            throw new Error("Patch does not reproduce the staged tree");
          checks.push({ check: "patch_applies", ok: true });
        });
      }
      report.result = "verified";
    } else {
      // A patch digest alone says nothing about the resulting commit.
      report.result = "unchecked_effect";
    }
    return report;
  } catch (error) {
    if (!(error instanceof CheckFailed)) throw error;
    report.result = "failed";
    return report;
  }
}

/** Apply a patch to a base commit in a disposable clone; return the tree. */
function applyPatchTree(
  repositoryPath: string,
  baseCommit: string,
  patch: Uint8Array,
): string {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-evidence-"));
  try {
    const clone = join(scratch, "clone");
    runGit([
      "clone",
      "--no-local",
      "--no-checkout",
      "--quiet",
      "--",
      realpathSync.native(repositoryPath),
      clone,
    ]);
    runGit(["-C", clone, "read-tree", baseCommit]);
    runGit(["-C", clone, "apply", "--cached", "--binary", "-"], patch);
    return runGit(["-C", clone, "write-tree"]).toString("utf8").trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
