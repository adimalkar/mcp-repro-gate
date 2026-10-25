import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as z from "zod/v4";

import { canonicalJson } from "./canonical-json.js";
import type { GitApprovalAuthority } from "./git-approval-store.js";
import { digestSchema } from "./git-change-contract.js";
import type { GitChangeProposal } from "./git-change-proposal.js";
import { digestCanonical, sha256 } from "./digest.js";
import {
  authenticateGitOperatorReview,
  gitOperatorKeyId,
  gitOperatorReviewDigest,
  parseGitOperatorReview,
  parseGitOperatorReviewTrust,
  PUBLIC_PEM_PATTERN,
  signatureSchema,
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

const trustSchema = z.strictObject({
  evidenceTrustVersion: z.literal(1),
  hostKeys: z
    .array(
      z.strictObject({
        keyId: digestSchema,
        publicKeyPem: z.string().max(4096).regex(PUBLIC_PEM_PATTERN),
      }),
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
  manifest: z.unknown(),
  manifestDigest: digestSchema,
  signature: z.strictObject({
    algorithm: z.literal("ed25519"),
    value: signatureSchema,
  }),
});
// Keys JSON.parse keeps as own properties but object schemas may drop.
const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype"];

export type GitPromotionEvidenceResult =
  "verified" | "unchecked_effect" | "not_promoted" | "indeterminate" | "failed";

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
 * the first failure. The effect checks run in a disposable repository that
 * borrows the trusted repository's object store, so no working tree,
 * attributes or repository configuration of that clone is involved.
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
      const b = bundleSchema.parse(bundle);
      const manifest = b.manifest;
      if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest) ||
        PROTOTYPE_KEYS.some((key) => Object.hasOwn(manifest, key))
      )
        throw new Error("Manifest must be a plain object");
      return { ...b, manifest: manifest as Record<string, unknown> };
    });
    report.manifestDigest = parsed.manifestDigest;
    // The digest covers the manifest exactly as received, not a parsed copy.
    check(
      "manifest_digest",
      attemptTo(
        "manifest_digest",
        () => digestCanonical(parsed.manifest) === parsed.manifestDigest,
      ),
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
        // The reservation's deadline never outlives the approval.
        Date.parse(attempt.admissionDeadline) <=
          Date.parse(review.payload.expiresAt),
    );
    // The review must have been valid when the host reserved the attempt
    // and, if it was admitted, at the admission the host recorded.
    const times = [
      attempt.reservedAt,
      ...(admission === undefined ? [] : [admission.admittedAt]),
    ];
    check(
      "operator_review",
      times.every(
        (time) =>
          authenticateGitOperatorReview(
            review,
            // The verifier only reads these frozen snapshots.
            attempt.proposal as GitChangeProposal,
            attempt.authority as GitApprovalAuthority,
            attempt.effectDigest,
            trust.review,
            Date.parse(time),
          ) !== undefined,
      ),
    );

    if (outcome.state !== "confirmed") {
      report.result =
        outcome.state === "failed" ? "not_promoted" : "indeterminate";
      return report;
    }
    if (options.patch !== undefined)
      check(
        "patch_digest",
        sha256(options.patch) === attempt.proposal.patchDigest,
      );
    if (options.repositoryPath === undefined) {
      // A patch digest alone says nothing about the resulting commit.
      report.result = "unchecked_effect";
      return report;
    }
    const prepared = attempt.prepared;
    const patch = options.patch;
    withBorrowedObjects(options.repositoryPath, (repo) => {
      attemptTo("candidate_commit", () => {
        const raw = runGit([
          "-C",
          repo,
          "cat-file",
          "commit",
          prepared.candidateCommitOid,
        ]);
        const header = raw.toString("utf8").split("\n\n", 1)[0] ?? "";
        const parents = header
          .split("\n")
          .filter((line) => line.startsWith("parent "));
        const rehashed = runGit(
          ["-C", repo, "hash-object", "-t", "commit", "--stdin"],
          raw,
        )
          .toString("utf8")
          .trim();
        if (
          rehashed !== prepared.candidateCommitOid ||
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
        // Exactly the staging computation: the candidate tree in an index,
        // diffed against the base commit.
        runGit(["-C", repo, "read-tree", prepared.candidateTreeOid]);
        const diff = runGit([
          "-C",
          repo,
          "diff",
          "--cached",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          prepared.baseCommit,
          "--",
        ]);
        if (sha256(diff) !== prepared.staged.stagedPatchDigest)
          throw new Error("Diff does not match the staged patch digest");
        checks.push({ check: "staged_diff", ok: true });
      });
      if (patch !== undefined)
        attemptTo("patch_applies", () => {
          runGit(["-C", repo, "read-tree", prepared.baseCommit]);
          runGit(["-C", repo, "apply", "--cached", "--binary", "-"], patch);
          const tree = runGit(["-C", repo, "write-tree"])
            .toString("utf8")
            .trim();
          if (tree !== prepared.candidateTreeOid)
            throw new Error("Patch does not reproduce the staged tree");
          checks.push({ check: "patch_applies", ok: true });
        });
    });
    report.result = "verified";
    return report;
  } catch (error) {
    if (!(error instanceof CheckFailed)) throw error;
    report.result = "failed";
    return report;
  }
}

/**
 * Run with an empty disposable repository that borrows the trusted
 * repository's objects through alternates: every object is visible, but no
 * working tree, attributes, index or repository configuration of the trusted
 * clone takes part.
 */
function withBorrowedObjects(
  repositoryPath: string,
  run: (repo: string) => void,
): void {
  const root = realpathSync.native(repositoryPath);
  const common = runGit([
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
    .toString("utf8")
    .trim();
  const format = runGit(["-C", root, "rev-parse", "--show-object-format"])
    .toString("utf8")
    .trim();
  if (format !== "sha1" && format !== "sha256")
    throw new Error("Unsupported Git object format");
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-evidence-"));
  try {
    const repo = join(scratch, "repo");
    runGit(["init", "--quiet", `--object-format=${format}`, "--", repo]);
    writeFileSync(
      join(repo, ".git", "objects", "info", "alternates"),
      `${join(common, "objects")}\n`,
    );
    run(repo);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
