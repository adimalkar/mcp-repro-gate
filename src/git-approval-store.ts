import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  deriveGitApprovalAuthorityFromPlan,
  type GitPlanBindingContext,
} from "./git-plan-binding.js";
import {
  capturePromotionData,
  gitPromotionTimestampEpoch,
  parseGitPromotionStatus,
  parsePreparedGitPromotionObjects,
  parseGitPromotionAttempt,
  promotionUuidSchema,
  type GitPromotionAdmissionV1,
  type GitPromotionAttemptV1,
  type GitPromotionFailedReason,
  type GitPromotionOutcomeV1,
  type GitPromotionStatusV1,
  type ImmutablePromotion,
} from "./git-promotion-contract.js";
import {
  createGitPromotionHostControl,
  parseGitPromotionFenceOwner,
  type GitPromotionFenceOwnerV1,
  type GitPromotionHostControl,
  type GitPromotionHostControlConfig,
} from "./git-promotion-host-control.js";
import { runGit } from "./git-runner.js";
import type { PreparedGitPromotionObjectsV1 } from "./git-promotion-objects.js";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import { digestCanonical } from "./digest.js";
import {
  oidSchema,
  ownGitChangeProposal,
  parseGitChangeProposalStructure,
  parseGitWorktreeList,
  type GitChangeProposalVersions,
} from "./git-change-contract.js";
import {
  verifyGitChangeProposal,
  type GitChangeProposal,
  type GitChangeProposalV1,
  type GitChangeProposalV2,
} from "./git-change-proposal.js";
import {
  stageGitChangeProposal,
  verifyInstalledGitPromotionObjects,
} from "./git-change-stage.js";
import {
  authenticateGitOperatorReview,
  gitOperatorReviewDigest,
  parseGitOperatorReview,
  type GitOperatorReviewV1,
} from "./git-operator-review.js";
import type { Digest } from "./types.js";

export interface GitChangeApprovalV1 {
  approvalVersion: 1;
  approvalId: string;
  proposalId: Digest;
  authorityDigest: Digest;
  effectDigest: Digest;
  candidateTreeOid: string;
  grantedAt: string;
  expiresAt: string;
}

/** Must come from trusted host policy, repository configuration, and plan state. */
export interface GitApprovalAuthority {
  repositoryId: string;
  actionId: Digest;
  policyDigest: Digest;
  workspaceRootDigest: Digest;
  destinationRef: string;
  maxExpiresAt: string;
}

/** The first authenticated decision recorded for a proposal in this ledger. */
export type RecordedGitOperatorReviewDecision =
  | {
      decision: "approve";
      proposalId: Digest;
      reviewDigest: Digest;
      approval: GitChangeApprovalV1;
    }
  | { decision: "deny"; proposalId: Digest; reviewDigest: Digest };

/**
 * Trusted-host inputs for importing a signed operator decision. `trust` is
 * revalidated on every authentication. `revalidateAuthority` must rederive the
 * current authority from host state after staging; it is not a generic hook.
 */
export interface RecordGitOperatorReviewInput {
  proposal: GitChangeProposal;
  repositoryPath: string;
  patch: Uint8Array;
  authority: GitApprovalAuthority;
  trust: unknown;
  review: unknown;
  revalidateAuthority: () => GitApprovalAuthority;
}

export interface MatchOperatorReviewedApprovalInput {
  approvalId: string;
  proposal: GitChangeProposal;
  repositoryPath: string;
  patch: Uint8Array;
  authority: GitApprovalAuthority;
  trust: unknown;
  revalidateAuthority: () => GitApprovalAuthority;
}

/**
 * Read an untrusted proposal exactly once into an owned, strictly shaped copy
 * and check its integrity. This does not establish authority. The default is
 * the legacy version 1 shape; pass 2 or "any" to accept version 2 proposals.
 */
export function snapshotGitChangeProposal(
  value: unknown,
  versions?: 1,
): GitChangeProposalV1;
export function snapshotGitChangeProposal(
  value: unknown,
  versions: 2,
): GitChangeProposalV2;
export function snapshotGitChangeProposal(
  value: unknown,
  versions: GitChangeProposalVersions,
): GitChangeProposal;
export function snapshotGitChangeProposal(
  value: unknown,
  versions: GitChangeProposalVersions = 1,
): GitChangeProposal {
  const proposal = parseGitChangeProposalStructure(value, "snapshot", versions);
  if (!verifyGitChangeProposal(proposal)) {
    throw new Error("Git change proposal failed its integrity check");
  }
  return proposal;
}

function ownedPatch(patch: unknown): Uint8Array {
  if (!(patch instanceof Uint8Array)) {
    throw new TypeError("Git change patch must be bytes");
  }
  return new Uint8Array(patch);
}

function ownedAuthority(authority: GitApprovalAuthority): GitApprovalAuthority {
  // Authentication strictly parses this copy; digests are computed from it too.
  return JSON.parse(canonicalJson(authority)) as GitApprovalAuthority;
}

function matchesAuthority(
  proposal: GitChangeProposal,
  authority: GitApprovalAuthority,
): boolean {
  const authorityExpiry = Date.parse(authority.maxExpiresAt);
  return (
    proposal.repositoryId === authority.repositoryId &&
    proposal.actionId === authority.actionId &&
    proposal.policyDigest === authority.policyDigest &&
    proposal.workspace.rootDigest === authority.workspaceRootDigest &&
    proposal.workspace.destinationRef === authority.destinationRef &&
    Number.isFinite(authorityExpiry) &&
    authorityExpiry > Date.now()
  );
}

const PROMOTION_COLUMNS = {
  attempt_id: "attemptId",
  approval_id: "approvalId",
  proposal_id: "proposalId",
  review_digest: "reviewDigest",
  authority_digest: "authorityDigest",
  effect_digest: "effectDigest",
  state: "state",
  repository_path: "repositoryPath",
  common_directory: "fenceOwner.commonDirectory",
  ledger_path: "fenceOwner.approvalDatabasePath",
  fence_path: "fenceOwner.fencePath",
  fence_token: "fenceOwner.token",
  destination_ref: "proposal.workspace.destinationRef",
  expected_old_oid: "prepared.expectedOldOid",
  base_commit: "prepared.baseCommit",
  candidate_oid: "prepared.candidateCommitOid",
  tree_oid: "prepared.candidateTreeOid",
  metadata_digest: "prepared.hostCommitMetadataDigest",
  reserved_at: "reservedAt",
  prechecked_at: "precheckedAt",
  admission_deadline: "admissionDeadline",
} as const;

/** Host-only input, never supplied through an MCP tool. Host context/trust are
 * trusted policy/configuration sources, not agent-controlled replacements. */
export interface ReserveGitPromotionFromPlanInput {
  proposal: GitChangeProposalV2;
  prepared: PreparedGitPromotionObjectsV1;
  approvalId: string;
  context: GitPlanBindingContext;
  trust: unknown;
  hostControl: GitPromotionHostControlConfig;
  owner: unknown;
}

/** Host-only input, never supplied through an MCP tool. */
export interface PromoteGitPromotionAttemptInput {
  attemptId: string;
  context: GitPlanBindingContext;
  trust: unknown;
  hostControl: GitPromotionHostControlConfig;
  owner: unknown;
}

/** Host-only input; the acknowledgement is a host contract, not proof. */
export interface RecoverGitPromotionAttemptInput {
  attemptId: string;
  hostControl: GitPromotionHostControlConfig;
  acknowledgement: { childrenQuiescent: true };
}

export interface GitPromotionResultV1 {
  status: ImmutablePromotion<GitPromotionStatusV1>;
  /** `not_held`: no fence, or one held by another owner, was left alone. */
  fence: "released" | "retained" | "not_held";
}

// The destination's current direct commit, or undefined when it cannot be
// read exactly. An observation only, never evidence of authorization.
function promotionDestination(
  root: string,
  destinationRef: string,
): string | undefined {
  try {
    const lines = runGit(
      [
        "-C",
        root,
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)",
        destinationRef,
      ],
      undefined,
      1024 * 1024,
    )
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith(`${destinationRef}\t`));
    const [refname, oid, type, symref] = lines[0]?.split("\t") ?? [];
    return lines.length === 1 &&
      refname === destinationRef &&
      type === "commit" &&
      symref === "" &&
      oid !== undefined &&
      oidSchema.safeParse(oid).success
      ? oid
      : undefined;
  } catch {
    return undefined;
  }
}

// After dispatch: the source branch, its HEAD and the worktree list are as
// the proposal observed them, and the destination is still not checked out.
function promotionSourceUnchanged(
  root: string,
  attempt: ImmutablePromotion<GitPromotionAttemptV1>,
): boolean {
  const { headRef, headCommit, destinationRef } = attempt.proposal.workspace;
  try {
    return (
      runGit(
        ["-C", root, "symbolic-ref", "--quiet", "HEAD"],
        undefined,
        4096,
      ).toString("utf8") === `${headRef}\n` &&
      runGit(
        ["-C", root, "rev-parse", "--verify", `${headRef}^{commit}`],
        undefined,
        4096,
      ).toString("utf8") === `${headCommit}\n` &&
      !parseGitWorktreeList(
        runGit(
          ["-C", root, "worktree", "list", "--porcelain", "-z"],
          undefined,
          1024 * 1024,
        ),
      ).some((worktree) => worktree.branch === destinationRef)
    );
  } catch {
    return false;
  }
}

interface ApprovalRow {
  approval_id: string;
  proposal_id: string;
  effect_digest: string;
  approval_json: string;
  status: "active" | "revoked";
}

interface DecisionRow {
  proposal_id: string;
  review_digest: string;
  decision: string;
  review_json: string;
  approval_id: string | null;
  received_at: string;
}

interface ReviewedApproval {
  approval: GitChangeApprovalV1;
  review: GitOperatorReviewV1;
  reviewJson: string;
}

function losslessPromotionPath(bytes: Uint8Array): string {
  if (bytes.length > 4096)
    throw new Error("Promotion locations require bounded lossless UTF-8 paths");
  let path: string;
  try {
    // Retain a genuine leading U+FEFF as part of the filename.
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error("Promotion locations require lossless UTF-8 paths");
  }
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error(
      "Promotion locations require bounded absolute lossless paths",
    );
  return path;
}

function promotionPhysicalPath(path: string): string {
  if (
    Buffer.byteLength(path) > 4096 ||
    Buffer.from(path).toString("utf8") !== path ||
    path.includes("\0")
  )
    throw new Error("Promotion locations require lossless UTF-8 paths");
  return losslessPromotionPath(
    realpathSync.native(path, { encoding: "buffer" }),
  );
}

// SQLite may keep the caller's alias spelling for its WAL namespace even when
// the main file resolves to the pinned inode. Resolve before opening any disk
// connection, including an absent ordinary leaf beneath a physical parent.
function promotionDatabaseOpenPath(path: string): string {
  if (path === "" || path === ":memory:") return path;
  try {
    return promotionPhysicalPath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    try {
      lstatSync(path);
    } catch (leafError) {
      if (!(
        leafError instanceof Error &&
        "code" in leafError &&
        leafError.code === "ENOENT"
      ))
        throw leafError;
      return losslessPromotionPath(
        Buffer.from(join(promotionPhysicalPath(dirname(path)), basename(path))),
      );
    }
    // A dangling link exists: do not create a database through an unresolved
    // alias, whose sidecars could occupy a different namespace.
    throw error;
  }
}

/** Host-side approval ledger. Call grant only after an operator decision. */
export class SqliteGitApprovalStore {
  readonly #database: DatabaseSync;
  readonly #promotionDatabasePath: string | undefined;
  readonly #promotionDatabaseIdentity: BigIntStats | undefined;

  constructor(path: string) {
    const openPath = promotionDatabaseOpenPath(path);
    this.#database = new DatabaseSync(openPath);
    try {
      // Wait out another process's lock (including WAL recovery) before the
      // first statement below reads the schema for identity inspection.
      this.#database.exec("PRAGMA busy_timeout = 5000");
      // Register our pure projection on EVERY owned connection; callers cannot
      // supply authorization via a callback or replace this private connection.
      // Raw host connections must register this same projection to insert; absent
      // functions fail closed. Node22 cannot mark a function SQLITE_INNOCUOUS, so
      // trusted_schema=OFF also rejects inserts rather than bypassing the trigger.
      // With SQLite's default trusted_schema=ON it is safe to invoke from schema:
      // bounded canonical scalar parsing only, no policy, I/O or caller hooks.
      this.#database.function(
        "reprogate_promotion_epoch_ms",
        { deterministic: true },
        gitPromotionTimestampEpoch,
      );
      // Node22 has no portable DatabaseSync.location API. SQLite itself reports
      // the file bound to THIS connection. Relative/memory constructors remain
      // supported for legacy APIs; durable reservation requires an absolute file.
      const file = this.#connectionPromotionPath();
      if (file !== undefined && file !== openPath)
        throw new Error(
          "Promotion database physical path changed during opening",
        );
      this.#promotionDatabasePath = isAbsolute(path) ? file : undefined;
      this.#promotionDatabaseIdentity = this.#promotionDatabasePath
        ? statSync(this.#promotionDatabasePath, { bigint: true })
        : undefined;
      // A signed decision is keyed by proposal and, for approve only, linked to
      // the exact approval row for that same proposal.
      this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS git_change_approvals (
        approval_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        effect_digest TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        revoked_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS git_change_approvals_link
        ON git_change_approvals (approval_id, proposal_id);

      CREATE TABLE IF NOT EXISTS git_operator_review_decisions (
        proposal_id TEXT NOT NULL PRIMARY KEY,
        review_digest TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
        review_json TEXT NOT NULL,
        approval_id TEXT UNIQUE,
        received_at TEXT NOT NULL,
        CHECK ((decision = 'approve') = (approval_id IS NOT NULL)),
        FOREIGN KEY (approval_id, proposal_id)
          REFERENCES git_change_approvals (approval_id, proposal_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS git_operator_review_promotion_link
        ON git_operator_review_decisions (approval_id, proposal_id, review_digest);
      -- T1 intent-only slice. Future evidence/transitions need an additive
      -- migration and concrete verifier, never a generic public state setter.
      CREATE TABLE IF NOT EXISTS git_promotion_attempts (
        attempt_id TEXT NOT NULL PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        proposal_id TEXT NOT NULL UNIQUE,
        review_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        effect_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        common_directory TEXT NOT NULL,
        ledger_path TEXT NOT NULL,
        fence_path TEXT NOT NULL,
        fence_token TEXT NOT NULL,
        destination_ref TEXT NOT NULL,
        expected_old_oid TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        candidate_oid TEXT NOT NULL,
        tree_oid TEXT NOT NULL,
        metadata_digest TEXT NOT NULL,
        reserved_at TEXT NOT NULL,
        prechecked_at TEXT NOT NULL,
        admission_deadline TEXT NOT NULL,
        prechecked_epoch_ms INTEGER NOT NULL,
        reserved_epoch_ms INTEGER NOT NULL,
        admission_deadline_epoch_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        CHECK (COALESCE(json_type(record_json, '$.attemptId') = 'text' AND json_extract(record_json, '$.attemptId') = attempt_id, 0)),
        CHECK (COALESCE(json_type(record_json, '$.approvalId') = 'text' AND json_extract(record_json, '$.approvalId') = approval_id, 0)),
        CHECK (COALESCE(json_type(record_json, '$.proposalId') = 'text' AND json_extract(record_json, '$.proposalId') = proposal_id, 0)),
        CHECK (COALESCE(json_type(record_json, '$.reviewDigest') = 'text' AND json_extract(record_json, '$.reviewDigest') = review_digest, 0)),
        CHECK (COALESCE(json_type(record_json, '$.authorityDigest') = 'text' AND json_extract(record_json, '$.authorityDigest') = authority_digest, 0)),
        CHECK (COALESCE(json_type(record_json, '$.effectDigest') = 'text' AND json_extract(record_json, '$.effectDigest') = effect_digest, 0)),
        CHECK (COALESCE(json_type(record_json, '$.state') = 'text' AND json_extract(record_json, '$.state') = state, 0)),
        CHECK (COALESCE(json_type(record_json, '$.repositoryPath') = 'text' AND json_extract(record_json, '$.repositoryPath') = repository_path, 0)),
        CHECK (COALESCE(json_type(record_json, '$.fenceOwner.commonDirectory') = 'text' AND json_extract(record_json, '$.fenceOwner.commonDirectory') = common_directory, 0)),
        CHECK (COALESCE(json_type(record_json, '$.fenceOwner.approvalDatabasePath') = 'text' AND json_extract(record_json, '$.fenceOwner.approvalDatabasePath') = ledger_path, 0)),
        CHECK (COALESCE(json_type(record_json, '$.fenceOwner.fencePath') = 'text' AND json_extract(record_json, '$.fenceOwner.fencePath') = fence_path, 0)),
        CHECK (COALESCE(json_type(record_json, '$.fenceOwner.token') = 'text' AND json_extract(record_json, '$.fenceOwner.token') = fence_token, 0)),
        CHECK (COALESCE(json_type(record_json, '$.proposal.workspace.destinationRef') = 'text' AND json_extract(record_json, '$.proposal.workspace.destinationRef') = destination_ref, 0)),
        CHECK (COALESCE(json_type(record_json, '$.prepared.expectedOldOid') = 'text' AND json_extract(record_json, '$.prepared.expectedOldOid') = expected_old_oid, 0)),
        CHECK (COALESCE(json_type(record_json, '$.prepared.baseCommit') = 'text' AND json_extract(record_json, '$.prepared.baseCommit') = base_commit, 0)),
        CHECK (COALESCE(json_type(record_json, '$.prepared.candidateCommitOid') = 'text' AND json_extract(record_json, '$.prepared.candidateCommitOid') = candidate_oid, 0)),
        CHECK (COALESCE(json_type(record_json, '$.prepared.candidateTreeOid') = 'text' AND json_extract(record_json, '$.prepared.candidateTreeOid') = tree_oid, 0)),
        CHECK (COALESCE(json_type(record_json, '$.prepared.hostCommitMetadataDigest') = 'text' AND json_extract(record_json, '$.prepared.hostCommitMetadataDigest') = metadata_digest, 0)),
        CHECK (COALESCE(json_type(record_json, '$.reservedAt') = 'text' AND json_extract(record_json, '$.reservedAt') = reserved_at, 0)),
        CHECK (COALESCE(json_type(record_json, '$.precheckedAt') = 'text' AND json_extract(record_json, '$.precheckedAt') = prechecked_at, 0)),
        CHECK (COALESCE(json_type(record_json, '$.admissionDeadline') = 'text' AND json_extract(record_json, '$.admissionDeadline') = admission_deadline, 0)),
        CHECK (json_valid(record_json) AND length(CAST(record_json AS BLOB)) <= 16777216),
        CHECK (state IN ('prepared', 'confirmed', 'failed', 'indeterminate')),
        CHECK (COALESCE(json_extract(record_json, '$.attemptVersion') = 1 AND json_extract(record_json, '$.prepared.preparedVersion') = 1 AND json_extract(record_json, '$.proposal.proposalVersion') = 2, 0)),
        CHECK (COALESCE(json_extract(record_json, '$.prepared.attemptId') = attempt_id AND json_extract(record_json, '$.fenceOwner.attemptId') = attempt_id AND json_extract(record_json, '$.prepared.proposalId') = proposal_id AND json_extract(record_json, '$.proposal.proposalId') = proposal_id AND json_extract(record_json, '$.prepared.effectDigest') = effect_digest AND json_extract(record_json, '$.prepared.candidateTreeOid') = json_extract(record_json, '$.prepared.staged.candidateTreeOid') AND json_extract(record_json, '$.prepared.staged.proposalId') = proposal_id AND json_extract(record_json, '$.prepared.staged.baseCommit') = base_commit, 0)),
        CHECK (COALESCE(expected_old_oid = base_commit AND json_extract(record_json, '$.proposal.workspace.headCommit') = base_commit AND json_extract(record_json, '$.proposal.workspace.destinationOid') = base_commit, 0)),
        -- Canonical ISO extended years do not sort chronologically as text.
        -- The insert trigger binds epoch projections to exact canonical JSON
        -- dates; strict readback independently checks the same bindings.
        CHECK (prechecked_epoch_ms <= reserved_epoch_ms AND reserved_epoch_ms < admission_deadline_epoch_ms),
        FOREIGN KEY (approval_id, proposal_id)
          REFERENCES git_change_approvals (approval_id, proposal_id),
        FOREIGN KEY (approval_id, proposal_id, review_digest)
          REFERENCES git_operator_review_decisions (approval_id, proposal_id, review_digest)
      ) STRICT;
      -- Additive also for already-created unpublished Task3B journal tables:
      -- no table rewrite, consumption deletion or readback reinterpretation.
      -- IS NOT rejects NULL projections (SQL CHECK/WHEN != would pass NULL).
      CREATE TRIGGER IF NOT EXISTS git_promotion_epoch_bindings
        BEFORE INSERT ON git_promotion_attempts
        WHEN NEW.prechecked_epoch_ms IS NOT reprogate_promotion_epoch_ms(json_extract(NEW.record_json, '$.precheckedAt'))
          OR NEW.reserved_epoch_ms IS NOT reprogate_promotion_epoch_ms(json_extract(NEW.record_json, '$.reservedAt'))
          OR NEW.admission_deadline_epoch_ms IS NOT reprogate_promotion_epoch_ms(json_extract(NEW.record_json, '$.admissionDeadline'))
        BEGIN SELECT RAISE(ABORT, 'Promotion epoch/canonical timestamp CHECK failed'); END;
      -- Future transition vocabulary is reserved, but ONLY prepared can be
      -- inserted and NO updates are allowed in Task3B. Task3C adds evidence
      -- columns and replaces the immutable-update guard with verified,
      -- immutable-binding-preserving transitions (no table reinterpretation).
      CREATE TRIGGER IF NOT EXISTS git_promotion_prepared_only
        BEFORE INSERT ON git_promotion_attempts WHEN NEW.state != 'prepared'
        BEGIN SELECT RAISE(ABORT, 'Reservation only creates prepared intent'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_no_replacement
        BEFORE INSERT ON git_promotion_attempts
        WHEN EXISTS (SELECT 1 FROM git_promotion_attempts
          WHERE attempt_id = NEW.attempt_id OR approval_id = NEW.approval_id
             OR proposal_id = NEW.proposal_id)
        BEGIN SELECT RAISE(ABORT, 'Promotion consumption is permanent'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_intent_immutable
        BEFORE UPDATE ON git_promotion_attempts
        BEGIN SELECT RAISE(ABORT, 'Promotion intent is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_consumption_permanent
        BEFORE DELETE ON git_promotion_attempts
        BEGIN SELECT RAISE(ABORT, 'Promotion consumption is permanent'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_raw_revocation_guard
        BEFORE UPDATE OF status ON git_change_approvals
        WHEN NEW.status = 'revoked' AND EXISTS (
          SELECT 1 FROM git_promotion_attempts
          WHERE approval_id = OLD.approval_id OR proposal_id = OLD.proposal_id)
        BEGIN SELECT RAISE(ABORT, 'Unresolved promotion prevents raw revocation'); END;
      -- Final gate (additive): the intent row above stays immutable. Admission
      -- is committed BEFORE any ref dispatch, so its absence proves that this
      -- library never dispatched. Both tables are insert-only, one row each.
      CREATE TABLE IF NOT EXISTS git_promotion_admissions (
        attempt_id TEXT NOT NULL PRIMARY KEY
          REFERENCES git_promotion_attempts (attempt_id),
        record_json TEXT NOT NULL,
        CHECK (json_valid(record_json) AND length(CAST(record_json AS BLOB)) <= 65536),
        CHECK (COALESCE(json_extract(record_json, '$.admissionVersion') = 1 AND json_type(record_json, '$.attemptId') = 'text' AND json_extract(record_json, '$.attemptId') = attempt_id, 0))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS git_promotion_outcomes (
        attempt_id TEXT NOT NULL PRIMARY KEY
          REFERENCES git_promotion_attempts (attempt_id),
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        observed_oid TEXT,
        record_json TEXT NOT NULL,
        CHECK (json_valid(record_json) AND length(CAST(record_json AS BLOB)) <= 65536),
        CHECK (COALESCE(json_extract(record_json, '$.outcomeVersion') = 1 AND json_type(record_json, '$.attemptId') = 'text' AND json_extract(record_json, '$.attemptId') = attempt_id AND json_type(record_json, '$.state') = 'text' AND json_extract(record_json, '$.state') = state AND json_type(record_json, '$.reason') = 'text' AND json_extract(record_json, '$.reason') = reason, 0)),
        CHECK (COALESCE((observed_oid IS NULL AND json_type(record_json, '$.observedDestinationOid') = 'null') OR (json_type(record_json, '$.observedDestinationOid') = 'text' AND json_extract(record_json, '$.observedDestinationOid') = observed_oid), 0)),
        CHECK ((state = 'confirmed' AND reason = 'ref_updated' AND observed_oid IS NOT NULL)
          OR (state = 'failed' AND reason IN ('admission_expired', 'authority_rejected', 'approval_rejected', 'candidate_rejected', 'abandoned'))
          OR (state = 'indeterminate' AND reason IN ('dispatch_uncertain', 'readback_mismatch', 'interrupted')))
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS git_promotion_admission_bindings
        BEFORE INSERT ON git_promotion_admissions
        WHEN NOT EXISTS (SELECT 1 FROM git_promotion_attempts a
          WHERE a.attempt_id = NEW.attempt_id
            AND a.authority_digest IS json_extract(NEW.record_json, '$.authorityDigest')
            AND a.review_digest IS json_extract(NEW.record_json, '$.reviewDigest')
            AND a.expected_old_oid IS json_extract(NEW.record_json, '$.expectedOldOid')
            AND a.candidate_oid IS json_extract(NEW.record_json, '$.candidateCommitOid'))
        BEGIN SELECT RAISE(ABORT, 'Promotion admission must bind its exact attempt'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_admission_unresolved
        BEFORE INSERT ON git_promotion_admissions
        WHEN EXISTS (SELECT 1 FROM git_promotion_outcomes WHERE attempt_id = NEW.attempt_id)
        BEGIN SELECT RAISE(ABORT, 'A resolved promotion cannot be admitted'); END;
      -- REPLACE deletes without firing DELETE triggers; refuse it on insert.
      CREATE TRIGGER IF NOT EXISTS git_promotion_admission_no_replacement
        BEFORE INSERT ON git_promotion_admissions
        WHEN EXISTS (SELECT 1 FROM git_promotion_admissions WHERE attempt_id = NEW.attempt_id)
        BEGIN SELECT RAISE(ABORT, 'Promotion admission is permanent'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_outcome_no_replacement
        BEFORE INSERT ON git_promotion_outcomes
        WHEN EXISTS (SELECT 1 FROM git_promotion_outcomes WHERE attempt_id = NEW.attempt_id)
        BEGIN SELECT RAISE(ABORT, 'Promotion outcome is permanent'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_admission_immutable
        BEFORE UPDATE ON git_promotion_admissions
        BEGIN SELECT RAISE(ABORT, 'Promotion admission is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_admission_permanent
        BEFORE DELETE ON git_promotion_admissions
        BEGIN SELECT RAISE(ABORT, 'Promotion admission is permanent'); END;
      -- Dispatch only follows admission: a failure is never admitted, and
      -- confirmation or uncertainty always is. Confirmation names the candidate.
      CREATE TRIGGER IF NOT EXISTS git_promotion_outcome_admission
        BEFORE INSERT ON git_promotion_outcomes
        WHEN (NEW.state = 'failed') = EXISTS (SELECT 1 FROM git_promotion_admissions WHERE attempt_id = NEW.attempt_id)
        BEGIN SELECT RAISE(ABORT, 'Promotion outcome contradicts its admission'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_outcome_candidate
        BEFORE INSERT ON git_promotion_outcomes
        WHEN NEW.state = 'confirmed' AND NOT EXISTS (SELECT 1 FROM git_promotion_attempts
          WHERE attempt_id = NEW.attempt_id AND candidate_oid = NEW.observed_oid)
        BEGIN SELECT RAISE(ABORT, 'Confirmed promotion must observe its candidate'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_outcome_immutable
        BEFORE UPDATE ON git_promotion_outcomes
        BEGIN SELECT RAISE(ABORT, 'Promotion outcome is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS git_promotion_outcome_permanent
        BEFORE DELETE ON git_promotion_outcomes
        BEGIN SELECT RAISE(ABORT, 'Promotion outcome is permanent'); END;
    `);
    } catch (error) {
      // Identity validation precedes schema/WAL setup. Do not leak a live
      // connection when its physical filename cannot be represented safely.
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  /**
   * Re-stage before recording an explicit host-side grant. Never updates Git.
   * Refuses a proposal that already has a recorded signed decision.
   */
  grant(request: {
    proposal: GitChangeProposal;
    repositoryPath: string;
    patch: Uint8Array;
    authority: GitApprovalAuthority;
    reviewedEffectDigest: Digest;
    expiresAt: string;
  }): GitChangeApprovalV1 {
    const input = {
      ...request,
      proposal: ownGitChangeProposal(request.proposal),
    };
    const now = new Date();
    const expiresAt = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now.getTime() ||
      expiresAt > Date.parse(input.proposal.expiresAt) ||
      expiresAt > Date.parse(input.authority.maxExpiresAt)
    ) {
      throw new Error(
        "Approval expiry must be future and within proposal and authority expiry",
      );
    }
    if (!matchesAuthority(input.proposal, input.authority)) {
      throw new Error("Proposal does not match trusted approval authority");
    }
    const staged = stageGitChangeProposal(
      input.proposal,
      input.repositoryPath,
      input.patch,
    );
    if (Date.now() >= expiresAt) {
      throw new Error("Approval expired while staging the patch");
    }
    const effectDigest = digestCanonical(staged);
    if (effectDigest !== input.reviewedEffectDigest) {
      throw new Error(
        "Staged effect differs from the operator-reviewed effect",
      );
    }
    const approval: GitChangeApprovalV1 = {
      approvalVersion: 1,
      approvalId: randomUUID(),
      proposalId: input.proposal.proposalId,
      authorityDigest: digestCanonical(input.authority),
      effectDigest,
      candidateTreeOid: staged.candidateTreeOid,
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.#writeTransaction(() => {
      if (this.#hasDecision(approval.proposalId)) {
        throw new Error(
          "A signed operator decision is already recorded for this proposal",
        );
      }
      this.#insertApproval(approval);
    });
    return approval;
  }

  /**
   * Authenticate a signed operator decision, stage the patch freshly, and
   * record the first decision for the proposal. Approve inserts the approval
   * and its signed evidence in one transaction; deny records a permanent
   * tombstone. Rejects any proposal that already has a decision or approval,
   * including legacy or revoked approvals. Never updates Git.
   */
  recordGitOperatorReview(
    input: RecordGitOperatorReviewInput,
  ): RecordedGitOperatorReviewDecision {
    // Read every caller-owned value once. Decisions below consume only these
    // owned snapshots, never the original inputs.
    const proposal = snapshotGitChangeProposal(input.proposal, "any");
    const patch = ownedPatch(input.patch);
    const repositoryPath = input.repositoryPath;
    const authority = ownedAuthority(input.authority);
    const trust = input.trust;
    const revalidateAuthority = input.revalidateAuthority;
    let claimed: GitOperatorReviewV1;
    try {
      claimed = parseGitOperatorReview(input.review);
    } catch {
      throw new Error("Signed Git operator review failed authentication");
    }

    // The claimed effect is authenticated before any expensive staging.
    const preliminary = authenticateGitOperatorReview(
      claimed,
      proposal,
      authority,
      claimed.payload.effectDigest,
      trust,
    );
    if (preliminary === undefined || !matchesAuthority(proposal, authority)) {
      throw new Error("Signed Git operator review failed authentication");
    }
    this.#assertUndecided(proposal.proposalId);

    // No transaction is open while Git stages or authority is rederived.
    const staged = stageGitChangeProposal(proposal, repositoryPath, patch);
    const effectDigest = digestCanonical(staged);
    if (effectDigest !== preliminary.payload.effectDigest) {
      throw new Error(
        "Staged effect differs from the signed operator-reviewed effect",
      );
    }
    const current = ownedAuthority(revalidateAuthority());
    if (digestCanonical(current) !== digestCanonical(authority)) {
      throw new Error("Trusted approval authority changed during staging");
    }

    return this.#writeTransaction(() => {
      const final = authenticateGitOperatorReview(
        preliminary,
        proposal,
        current,
        effectDigest,
        trust,
      );
      if (final === undefined || !matchesAuthority(proposal, current)) {
        throw new Error(
          "Signed Git operator review is no longer valid under current trust",
        );
      }
      this.#assertUndecided(proposal.proposalId);
      const reviewDigest = gitOperatorReviewDigest(final.payload);
      const receivedAt = new Date().toISOString();
      let approval: GitChangeApprovalV1 | undefined;
      if (final.payload.decision === "approve") {
        approval = {
          approvalVersion: 1,
          approvalId: randomUUID(),
          proposalId: proposal.proposalId,
          authorityDigest: digestCanonical(current),
          effectDigest,
          candidateTreeOid: staged.candidateTreeOid,
          grantedAt: receivedAt,
          // The signed expiry is the approval expiry; there is no extension.
          expiresAt: final.payload.expiresAt,
        };
        this.#insertApproval(approval);
      }
      this.#database
        .prepare(
          `INSERT INTO git_operator_review_decisions
           (proposal_id, review_digest, decision, review_json, approval_id,
            received_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposal.proposalId,
          reviewDigest,
          final.payload.decision,
          canonicalJson(final),
          approval?.approvalId ?? null,
          receivedAt,
        );
      return approval === undefined
        ? { decision: "deny", proposalId: proposal.proposalId, reviewDigest }
        : {
            decision: "approve",
            proposalId: proposal.proposalId,
            reviewDigest,
            approval,
          };
    });
  }

  /** A fresh read-only check, not a reservation or atomic promotion gate. */
  matchesActiveApproval(request: {
    approvalId: string;
    proposal: GitChangeProposal;
    repositoryPath: string;
    patch: Uint8Array;
    authority: GitApprovalAuthority;
  }): boolean {
    try {
      const input = {
        ...request,
        proposal: ownGitChangeProposal(request.proposal),
      };
      if (!matchesAuthority(input.proposal, input.authority)) return false;
      const before = this.#activeApproval(input.approvalId);
      if (
        before?.proposalId !== input.proposal.proposalId ||
        before.authorityDigest !== digestCanonical(input.authority)
      ) {
        return false;
      }
      const staged = stageGitChangeProposal(
        input.proposal,
        input.repositoryPath,
        input.patch,
      );
      const after = this.#activeApproval(input.approvalId);
      return (
        matchesAuthority(input.proposal, input.authority) &&
        after?.proposalId === input.proposal.proposalId &&
        after.authorityDigest === digestCanonical(input.authority) &&
        after.effectDigest === digestCanonical(staged) &&
        after.candidateTreeOid === staged.candidateTreeOid
      );
    } catch {
      return false;
    }
  }

  /**
   * A fresh read-only check that an active approval was recorded with linked
   * signed evidence that still authenticates under current trust. Evidence is
   * loaded from this ledger only. Not a reservation or atomic promotion gate.
   */
  matchesOperatorReviewedApproval(
    input: MatchOperatorReviewedApprovalInput,
  ): boolean {
    try {
      const approvalId = input.approvalId;
      const proposal = snapshotGitChangeProposal(input.proposal, "any");
      const patch = ownedPatch(input.patch);
      const repositoryPath = input.repositoryPath;
      const authority = ownedAuthority(input.authority);
      const trust = input.trust;
      const revalidateAuthority = input.revalidateAuthority;
      if (typeof approvalId !== "string") return false;

      const before = this.#reviewedApproval(approvalId, proposal.proposalId);
      if (
        before === undefined ||
        !this.#authenticates(before, proposal, authority, trust) ||
        !this.matchesActiveApproval({
          approvalId,
          proposal,
          repositoryPath,
          patch,
          authority,
        })
      ) {
        return false;
      }
      const current = ownedAuthority(revalidateAuthority());
      const after = this.#reviewedApproval(approvalId, proposal.proposalId);
      return (
        after?.reviewJson === before.reviewJson &&
        canonicalJson(after.approval) === canonicalJson(before.approval) &&
        digestCanonical(current) === digestCanonical(authority) &&
        this.#authenticates(after, proposal, current, trust)
      );
    } catch {
      return false;
    }
  }

  /**
   * Durable T1 one-use consumption only; objects MUST already be installed.
   * Every replay (including identical attempt) rejects: a readback is not a
   * renewed authorization or permission to dispatch. No refs are written.
   * A thrown COMMIT/readback error is NOT proof of rollback/reusability: retain
   * the fence and inspect the attempt. Recovery/admission are Task3C operations.
   */
  reserveGitPromotionFromPlan(
    input: ReserveGitPromotionFromPlanInput,
  ): ImmutablePromotion<GitPromotionAttemptV1> {
    const {
      proposal: callerProposal,
      prepared: callerPrepared,
      approvalId: callerApprovalId,
      context: callerContext,
      trust,
      hostControl: callerConfig,
      owner: callerOwner,
    } = input;
    const prepared = parsePreparedGitPromotionObjects(callerPrepared);
    const approvalId = promotionUuidSchema.parse(callerApprovalId);
    const owner = parseGitPromotionFenceOwner(callerOwner);
    // Trusted live catalog/policy/PlanStore are retained for current-state checks;
    // top-level locations/references are captured exactly once, never retargeted.
    const context: GitPlanBindingContext = {
      repositoryPath: callerContext.repositoryPath,
      repositoryId: callerContext.repositoryId,
      destinationRef: callerContext.destinationRef,
      catalogTool: callerContext.catalogTool,
      currentPolicy: callerContext.currentPolicy,
      plans: callerContext.plans,
    };
    const config = capturePromotionData(
      callerConfig,
      "config",
    ) as GitPromotionHostControlConfig;
    // Only after owning prepared objects/config/owner do we traverse permitted
    // proposal accessors; they cannot retarget these earlier snapshots.
    const proposal = snapshotGitChangeProposal(callerProposal, 2);
    // Reinstantiate the concrete filesystem latch, never accept a structural
    // fake controller implementing query()/executeUnderApproval().
    const control = createGitPromotionHostControl(config);
    const repositoryPath = promotionPhysicalPath(context.repositoryPath);
    if (
      repositoryPath !== promotionPhysicalPath(config.repositoryPath) ||
      owner.attemptId !== prepared.attemptId
    )
      throw new Error("Promotion repository/attempt ownership mismatch");
    const checkFence = (): void => {
      this.#assertPromotionDatabase(owner.approvalDatabasePath);
      const held = control.query();
      if (
        held.status !== "held" ||
        canonicalJson(held.owner) !== canonicalJson(owner)
      )
        throw new Error("Promotion requires the exact persisted fence owner");
    };
    checkFence();
    const authority = deriveGitApprovalAuthorityFromPlan(proposal, context);
    const before = this.#reviewedApproval(approvalId, proposal.proposalId);
    if (
      !before ||
      !this.#authenticates(before, proposal, authority, trust) ||
      before.approval.effectDigest !== prepared.effectDigest ||
      before.approval.candidateTreeOid !== prepared.candidateTreeOid
    )
      throw new Error(
        "Promotion requires current linked signed approval for the exact candidate",
      );
    // Heavy object/diff interpretation occurs BEFORE acquiring the SQL lock.
    verifyInstalledGitPromotionObjects(proposal, repositoryPath, prepared);
    const current = deriveGitApprovalAuthorityFromPlan(proposal, context);
    if (digestCanonical(current) !== digestCanonical(authority))
      throw new Error("Promotion plan authority changed during precheck");
    checkFence();
    const precheckedAt = new Date().toISOString();
    const expected = this.#writeTransaction(() => {
      // BEGIN IMMEDIATE has completed, including any busy wait. Reload all
      // linked proof/expiry/trust and persisted plan state under this lock.
      checkFence();
      const finalAuthority = deriveGitApprovalAuthorityFromPlan(
        proposal,
        context,
      );
      const final = this.#reviewedApproval(approvalId, proposal.proposalId);
      if (
        !final ||
        digestCanonical(finalAuthority) !== digestCanonical(authority) ||
        canonicalJson(final.approval) !== canonicalJson(before.approval) ||
        final.reviewJson !== before.reviewJson ||
        !this.#authenticates(final, proposal, finalAuthority, trust) ||
        final.approval.effectDigest !== prepared.effectDigest ||
        final.approval.candidateTreeOid !== prepared.candidateTreeOid
      )
        throw new Error("Promotion signed approval is no longer valid");
      if (
        this.#database
          .prepare(
            "SELECT 1 FROM git_promotion_attempts WHERE attempt_id = ? OR approval_id = ? OR proposal_id = ?",
          )
          .get(prepared.attemptId, approvalId, proposal.proposalId)
      )
        throw new Error(
          "Promotion approval/proposal/attempt is permanently consumed",
        );
      checkFence();
      const record = parseGitPromotionAttempt({
        attemptVersion: 1,
        state: "prepared",
        attemptId: prepared.attemptId,
        approvalId,
        proposalId: proposal.proposalId,
        reviewDigest: gitOperatorReviewDigest(final.review.payload),
        authorityDigest: digestCanonical(finalAuthority),
        effectDigest: prepared.effectDigest,
        proposal,
        prepared,
        authority: finalAuthority,
        repositoryPath,
        fenceOwner: owner,
        precheckedAt,
        reservedAt: new Date().toISOString(),
        admissionDeadline: final.approval.expiresAt,
      });
      const columns = [
        ...Object.keys(PROMOTION_COLUMNS),
        "prechecked_epoch_ms",
        "reserved_epoch_ms",
        "admission_deadline_epoch_ms",
      ];
      const values = [
        ...Object.values(PROMOTION_COLUMNS).map((path) =>
          this.#promotionProjection(record, path),
        ),
        Date.parse(record.precheckedAt),
        Date.parse(record.reservedAt),
        Date.parse(record.admissionDeadline),
      ];
      this.#database
        .prepare(
          `INSERT INTO git_promotion_attempts (${columns.join(", ")}, record_json) VALUES (${columns.map(() => "?").join(", ")}, ?)`,
        )
        .run(...values, canonicalJson(record));
      return record;
    });
    // Only report prepared after COMMIT and exact strict canonical readback.
    const durable = this.getGitPromotionAttempt(prepared.attemptId);
    if (!durable || canonicalJson(durable) !== canonicalJson(expected))
      throw new Error("Promotion reservation readback uncertain; retain fence");
    return durable;
  }

  /** Read immutable intent; NOT authorization, a receipt, or recovery. */
  getGitPromotionAttempt(
    attemptId: string,
  ): ImmutablePromotion<GitPromotionAttemptV1> | undefined {
    promotionUuidSchema.parse(attemptId);
    const row = this.#database
      .prepare("SELECT * FROM git_promotion_attempts WHERE attempt_id = ?")
      .get(attemptId);
    if (!row) return undefined;
    if (
      typeof row.record_json !== "string" ||
      Buffer.byteLength(row.record_json) > 16 * 1024 * 1024
    )
      throw new Error("Corrupt promotion journal");
    const record = parseGitPromotionAttempt(JSON.parse(row.record_json));
    if (
      canonicalJson(record) !== row.record_json ||
      row.prechecked_epoch_ms !== Date.parse(record.precheckedAt) ||
      row.reserved_epoch_ms !== Date.parse(record.reservedAt) ||
      row.admission_deadline_epoch_ms !==
        Date.parse(record.admissionDeadline) ||
      Object.entries(PROMOTION_COLUMNS).some(
        ([col, path]) => row[col] !== this.#promotionProjection(record, path),
      )
    )
      throw new Error("Corrupt promotion journal column/canonical bindings");
    return record;
  }

  /**
   * Strict readback of an attempt with its admission and outcome. An
   * idempotent read: NOT authorization, recovery, or proof of who moved a ref.
   */
  getGitPromotionStatus(
    attemptId: string,
  ): ImmutablePromotion<GitPromotionStatusV1> | undefined {
    const attempt = this.getGitPromotionAttempt(attemptId);
    if (!attempt) return undefined;
    // One statement reads both rows from a single snapshot.
    const row = this.#database
      .prepare(
        `SELECT ad.record_json AS admission, o.record_json AS outcome,
                o.state AS state, o.reason AS reason, o.observed_oid AS observed
         FROM git_promotion_attempts a
         LEFT JOIN git_promotion_admissions ad ON ad.attempt_id = a.attempt_id
         LEFT JOIN git_promotion_outcomes o ON o.attempt_id = a.attempt_id
         WHERE a.attempt_id = ?`,
      )
      .get(attempt.attemptId);
    if (!row) throw new Error("Corrupt promotion journal");
    const status = parseGitPromotionStatus(attempt, row.admission, row.outcome);
    const outcome = status.outcome;
    if (
      (row.state ?? undefined) !== outcome?.state ||
      (row.reason ?? undefined) !== outcome?.reason ||
      (row.observed ?? null) !== (outcome?.observedDestinationOid ?? null)
    )
      throw new Error("Corrupt promotion journal outcome columns");
    return status;
  }

  /**
   * Host-only final gate for one prepared attempt held under its exact fence
   * owner. Checks run first outside the SQLite lock (a rejection there records
   * nothing), then again under BEGIN IMMEDIATE, where a rejection records
   * `failed`. Admission is committed BEFORE `update-ref` is dispatched with
   * the expected old OID. Only an exact readback confirms; any uncertainty
   * after admission records `indeterminate` and RETAINS the fence for
   * recovery. Never retries or rewrites refs.
   */
  promoteGitPromotionAttempt(
    input: PromoteGitPromotionAttemptInput,
  ): GitPromotionResultV1 {
    const {
      attemptId: callerAttemptId,
      context: callerContext,
      trust,
      hostControl: callerConfig,
      owner: callerOwner,
    } = input;
    const attemptId = promotionUuidSchema.parse(callerAttemptId);
    const owner = parseGitPromotionFenceOwner(callerOwner);
    const context: GitPlanBindingContext = {
      repositoryPath: callerContext.repositoryPath,
      repositoryId: callerContext.repositoryId,
      destinationRef: callerContext.destinationRef,
      catalogTool: callerContext.catalogTool,
      currentPolicy: callerContext.currentPolicy,
      plans: callerContext.plans,
    };
    const config = capturePromotionData(
      callerConfig,
      "config",
    ) as GitPromotionHostControlConfig;
    const control = createGitPromotionHostControl(config);
    const attempt = this.getGitPromotionAttempt(attemptId);
    if (!attempt) throw new Error("Unknown promotion attempt");
    const repositoryPath = promotionPhysicalPath(context.repositoryPath);
    if (
      repositoryPath !== attempt.repositoryPath ||
      repositoryPath !== promotionPhysicalPath(config.repositoryPath) ||
      canonicalJson(owner) !== canonicalJson(attempt.fenceOwner)
    )
      throw new Error("Promotion repository/attempt ownership mismatch");
    const checkFence = (): void => {
      this.#assertPromotionDatabase(owner.approvalDatabasePath);
      const held = control.query();
      if (
        held.status !== "held" ||
        canonicalJson(held.owner) !== canonicalJson(owner)
      )
        throw new Error("Promotion requires the exact persisted fence owner");
    };
    const assertUnresolved = (): void => {
      const status = this.getGitPromotionStatus(attemptId);
      if (
        !status ||
        canonicalJson(status.attempt) !== canonicalJson(attempt) ||
        status.admission ||
        status.outcome
      )
        throw new Error(
          "Promotion attempt was already admitted or resolved; read its status or recover it",
        );
    };
    checkFence();
    assertUnresolved();
    // Heavy object, plan and workspace checks run BEFORE the SQL lock. Nothing
    // has been dispatched, so a rejection here leaves the attempt retryable.
    const precheck = this.#promotionRejection(
      attempt,
      context,
      trust,
      repositoryPath,
    );
    if (precheck !== undefined)
      throw new Error(`Promotion precheck rejected: ${precheck}`);
    checkFence();

    const rejected = this.#writeTransaction(() => {
      checkFence();
      assertUnresolved();
      const reason = this.#promotionRejection(
        attempt,
        context,
        trust,
        repositoryPath,
      );
      checkFence();
      if (reason !== undefined) {
        this.#insertOutcome({
          outcomeVersion: 1,
          attemptId,
          state: "failed",
          reason,
          decidedAt: new Date().toISOString(),
          observedDestinationOid: null,
        });
        return true;
      }
      this.#insertAdmission({
        admissionVersion: 1,
        attemptId,
        authorityDigest: attempt.authorityDigest,
        reviewDigest: attempt.reviewDigest,
        expectedOldOid: attempt.prepared.expectedOldOid,
        candidateCommitOid: attempt.prepared.candidateCommitOid,
        admittedAt: new Date().toISOString(),
      });
      return false;
    });
    if (rejected) return this.#settle(attempt, control, owner, "release");

    // Admission is durable. From here on, every failure path keeps the fence.
    try {
      this.#writeTransaction(() => {
        checkFence();
        const destinationRef = attempt.proposal.workspace.destinationRef;
        let dispatched = false;
        try {
          runGit([
            "-C",
            repositoryPath,
            "update-ref",
            "--no-deref",
            "-m",
            `reprogate promotion ${attemptId}`,
            destinationRef,
            attempt.prepared.candidateCommitOid,
            attempt.prepared.expectedOldOid,
          ]);
          dispatched = true;
        } catch {
          // A nonzero exit includes a lost compare-and-swap, but the runner
          // does not distinguish it from a write that failed part way.
        }
        const observed = promotionDestination(repositoryPath, destinationRef);
        const exact =
          dispatched &&
          observed === attempt.prepared.candidateCommitOid &&
          promotionSourceUnchanged(repositoryPath, attempt);
        this.#insertOutcome(
          exact
            ? {
                outcomeVersion: 1,
                attemptId,
                state: "confirmed",
                reason: "ref_updated",
                decidedAt: new Date().toISOString(),
                observedDestinationOid: attempt.prepared.candidateCommitOid,
              }
            : {
                outcomeVersion: 1,
                attemptId,
                state: "indeterminate",
                reason: dispatched ? "readback_mismatch" : "dispatch_uncertain",
                decidedAt: new Date().toISOString(),
                observedDestinationOid: observed ?? null,
              },
        );
      });
    } catch (error) {
      throw new Error(
        "Admitted promotion outcome uncertain; fence retained for recovery",
        { cause: error },
      );
    }
    return this.#settle(attempt, control, owner, "confirmed-only");
  }

  /**
   * Host-only recovery after the host has stopped or reaped every process
   * that might still be promoting this attempt (a host assertion, not proof).
   * An admitted attempt without an outcome becomes `indeterminate`; one never
   * admitted becomes `failed`. Existing outcomes are left unchanged. Releases
   * the fence only if the attempt's own persisted owner still holds it.
   */
  recoverGitPromotionAttempt(
    input: RecoverGitPromotionAttemptInput,
  ): GitPromotionResultV1 {
    const {
      attemptId: callerAttemptId,
      hostControl: callerConfig,
      acknowledgement,
    } = input;
    const attemptId = promotionUuidSchema.parse(callerAttemptId);
    const acknowledged =
      typeof acknowledgement === "object" &&
      (acknowledgement as unknown) !== null
        ? Object.getOwnPropertyDescriptor(acknowledgement, "childrenQuiescent")
        : undefined;
    if (
      Object.getPrototypeOf(acknowledgement) !== Object.prototype ||
      Reflect.ownKeys(acknowledgement).length !== 1 ||
      !acknowledged?.enumerable ||
      !("value" in acknowledged) ||
      acknowledged.value !== true
    )
      throw new Error(
        "Recovery requires an explicit trusted-host child quiescence acknowledgement",
      );
    const config = capturePromotionData(
      callerConfig,
      "config",
    ) as GitPromotionHostControlConfig;
    const control = createGitPromotionHostControl(config);
    const attempt = this.getGitPromotionAttempt(attemptId);
    if (!attempt) throw new Error("Unknown promotion attempt");
    if (promotionPhysicalPath(config.repositoryPath) !== attempt.repositoryPath)
      throw new Error("Recovery repository does not match the attempt");
    const owner = attempt.fenceOwner;
    this.#writeTransaction(() => {
      this.#assertPromotionDatabase(owner.approvalDatabasePath);
      const status = this.getGitPromotionStatus(attemptId);
      if (!status || status.outcome) return;
      const observed = promotionDestination(
        attempt.repositoryPath,
        attempt.proposal.workspace.destinationRef,
      );
      this.#insertOutcome(
        status.admission
          ? {
              outcomeVersion: 1,
              attemptId,
              state: "indeterminate",
              reason: "interrupted",
              decidedAt: new Date().toISOString(),
              observedDestinationOid: observed ?? null,
            }
          : {
              outcomeVersion: 1,
              attemptId,
              state: "failed",
              reason: "abandoned",
              decidedAt: new Date().toISOString(),
              observedDestinationOid: observed ?? null,
            },
      );
    });
    return this.#settle(attempt, control, owner, "release");
  }

  // Read the durable status back and release the attempt's fence when allowed.
  // Every child Git process ran synchronously and has exited, so the gate's
  // own quiescence acknowledgement is accurate. A failed release keeps it.
  #settle(
    attempt: ImmutablePromotion<GitPromotionAttemptV1>,
    control: GitPromotionHostControl,
    owner: GitPromotionFenceOwnerV1,
    policy: "release" | "confirmed-only",
  ): GitPromotionResultV1 {
    const status = this.getGitPromotionStatus(attempt.attemptId);
    if (!status?.outcome)
      throw new Error("Promotion outcome readback uncertain; fence retained");
    if (policy === "confirmed-only" && status.outcome.state !== "confirmed")
      return { status, fence: "retained" };
    try {
      const held = control.query();
      if (
        held.status !== "held" ||
        canonicalJson(held.owner) !== canonicalJson(owner)
      )
        return { status, fence: "not_held" };
      control.release(owner, { childrenQuiescent: true });
      return { status, fence: "released" };
    } catch {
      return { status, fence: "retained" };
    }
  }

  // Run every final-gate check and return the first rejection, if any. The
  // same checks serve the unlocked precheck and the locked admission.
  #promotionRejection(
    attempt: ImmutablePromotion<GitPromotionAttemptV1>,
    context: GitPlanBindingContext,
    trust: unknown,
    repositoryPath: string,
  ): GitPromotionFailedReason | undefined {
    const deadline = Date.parse(attempt.admissionDeadline);
    // Expiry also makes the approval and plan checks fail; whichever check
    // notices first, a passed deadline is reported as such.
    const reject = (reason: GitPromotionFailedReason) =>
      Date.now() < deadline ? reason : "admission_expired";
    if (!(Date.now() < deadline)) return "admission_expired";
    const proposal = attempt.proposal as GitChangeProposalV2;
    let authority: GitApprovalAuthority;
    try {
      // Rederiving re-observes the V2 workspace: source HEAD, tree and
      // cleanliness, the destination ref, and every registered worktree.
      authority = deriveGitApprovalAuthorityFromPlan(proposal, context);
    } catch {
      return reject("authority_rejected");
    }
    if (digestCanonical(authority) !== attempt.authorityDigest)
      return reject("authority_rejected");
    try {
      const reviewed = this.#reviewedApproval(
        attempt.approvalId,
        attempt.proposalId,
      );
      if (
        !reviewed ||
        gitOperatorReviewDigest(reviewed.review.payload) !==
          attempt.reviewDigest ||
        reviewed.approval.expiresAt !== attempt.admissionDeadline ||
        reviewed.approval.effectDigest !== attempt.effectDigest ||
        reviewed.approval.candidateTreeOid !==
          attempt.prepared.candidateTreeOid ||
        !this.#authenticates(reviewed, proposal, authority, trust)
      )
        return reject("approval_rejected");
    } catch {
      return reject("approval_rejected");
    }
    try {
      verifyInstalledGitPromotionObjects(
        proposal,
        repositoryPath,
        attempt.prepared as PreparedGitPromotionObjectsV1,
      );
    } catch {
      return reject("candidate_rejected");
    }
    // The checks above take time; the deadline applies when they finish.
    return Date.now() < deadline ? undefined : "admission_expired";
  }

  #insertAdmission(record: GitPromotionAdmissionV1): void {
    this.#database
      .prepare(
        "INSERT INTO git_promotion_admissions (attempt_id, record_json) VALUES (?, ?)",
      )
      .run(record.attemptId, canonicalJson(record));
  }

  #insertOutcome(record: GitPromotionOutcomeV1): void {
    this.#database
      .prepare(
        "INSERT INTO git_promotion_outcomes (attempt_id, state, reason, observed_oid, record_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        record.attemptId,
        record.state,
        record.reason,
        record.observedDestinationOid,
        canonicalJson(record),
      );
  }

  #promotionProjection(
    record: ImmutablePromotion<GitPromotionAttemptV1>,
    path: string,
  ): string {
    let value: unknown = record;
    for (const key of path.split(".")) {
      if (typeof value !== "object" || value === null)
        throw new Error("Missing promotion projection");
      value = Reflect.get(value, key) as unknown;
    }
    if (typeof value !== "string")
      throw new Error("Missing promotion projection");
    return value;
  }

  #connectionPromotionPath(): string | undefined {
    // TEXT results decode invalid VFS filename bytes with U+FFFD. CAST inside
    // SQLite returns the original bytes before Node decodes anything, so an
    // invalid filename can never redirect identity checks to a Unicode twin.
    const file = this.#database
      .prepare(
        "SELECT CAST(file AS BLOB) AS file FROM pragma_database_list WHERE name = 'main'",
      )
      .get()?.file;
    if (!(file instanceof Uint8Array))
      throw new Error("Promotion connection requires lossless filename bytes");
    // In-memory databases report an empty filename and retain legacy APIs.
    if (file.length === 0) return undefined;
    return promotionPhysicalPath(losslessPromotionPath(file));
  }

  #assertPromotionDatabase(path: string): void {
    const bound = this.#promotionDatabasePath;
    const pinned = this.#promotionDatabaseIdentity;
    if (
      !bound ||
      !pinned ||
      path !== bound ||
      promotionPhysicalPath(bound) !== bound
    )
      throw new Error(
        "Durable promotion requires this connection's bound absolute disk ledger",
      );
    const file = this.#connectionPromotionPath();
    const now = statSync(bound, { bigint: true });
    if (
      file !== bound ||
      now.ino === 0n ||
      now.dev !== pinned.dev ||
      now.ino !== pinned.ino ||
      this.#database.prepare("PRAGMA synchronous").get()?.synchronous !== 2 ||
      this.#database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1
    )
      throw new Error("Durable promotion ledger identity/durability changed");
  }

  /** Revocation is durable; no new grant for the same proposal is allowed. */
  revoke(approvalId: string): boolean {
    return this.#writeTransaction(() => {
      // Guard + update are one locked transaction. Any attempt is unresolved in
      // this intent-only version; even corrupt/ambiguous journal JSON cannot
      // manufacture terminal/quiescent evidence and bypass crash fencing.
      const approval = this.#database
        .prepare(
          "SELECT proposal_id FROM git_change_approvals WHERE approval_id = ?",
        )
        .get(approvalId);
      if (
        this.#database
          .prepare(
            "SELECT 1 FROM git_promotion_attempts WHERE approval_id = ? OR proposal_id = ?",
          )
          .get(
            approvalId,
            typeof approval?.proposal_id === "string"
              ? approval.proposal_id
              : "",
          )
      )
        throw new Error("Unresolved promotion prevents raw revocation");
      // A damaged linkage must not disappear from the guard. Validate even
      // unrelated rows before allowing raw revoke; corruption fails closed.
      for (const row of this.#database
        .prepare("SELECT attempt_id FROM git_promotion_attempts")
        .all()) {
        if (
          typeof row.attempt_id !== "string" ||
          !this.getGitPromotionAttempt(row.attempt_id)
        )
          throw new Error("Corrupt promotion journal prevents raw revocation");
      }
      const changed = this.#database
        .prepare(
          `UPDATE git_change_approvals SET status = 'revoked', revoked_at = ? WHERE approval_id = ? AND status = 'active'`,
        )
        .run(new Date().toISOString(), approvalId);
      return Number(changed.changes) === 1;
    });
  }

  #writeTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back the failed transaction.
      }
      throw error;
    }
  }

  #insertApproval(approval: GitChangeApprovalV1): void {
    this.#database
      .prepare(
        `INSERT INTO git_change_approvals
         (approval_id, proposal_id, effect_digest, approval_json, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
      .run(
        approval.approvalId,
        approval.proposalId,
        approval.effectDigest,
        JSON.stringify(approval),
      );
  }

  #hasDecision(proposalId: Digest): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 FROM git_operator_review_decisions WHERE proposal_id = ?",
        )
        .get(proposalId) !== undefined
    );
  }

  #assertUndecided(proposalId: Digest): void {
    const approval = this.#database
      .prepare("SELECT 1 FROM git_change_approvals WHERE proposal_id = ?")
      .get(proposalId);
    if (approval !== undefined || this.#hasDecision(proposalId)) {
      throw new Error(
        "A decision or approval is already recorded for this proposal",
      );
    }
  }

  #authenticates(
    record: ReviewedApproval,
    proposal: GitChangeProposal,
    authority: GitApprovalAuthority,
    trust: unknown,
  ): boolean {
    const authenticated = authenticateGitOperatorReview(
      record.review,
      proposal,
      authority,
      record.approval.effectDigest,
      trust,
    );
    return (
      authenticated?.payload.decision === "approve" &&
      matchesAuthority(proposal, authority) &&
      record.approval.authorityDigest === digestCanonical(authority)
    );
  }

  /** Load and cross-check an active approval and its linked signed evidence. */
  #reviewedApproval(
    approvalId: string,
    proposalId: Digest,
  ): ReviewedApproval | undefined {
    const row = this.#database
      .prepare(
        `SELECT proposal_id, review_digest, decision, review_json, approval_id,
                received_at
         FROM git_operator_review_decisions WHERE approval_id = ?`,
      )
      .get(approvalId) as DecisionRow | undefined;
    if (
      row?.decision !== "approve" ||
      row.approval_id !== approvalId ||
      row.proposal_id !== proposalId
    ) {
      return undefined;
    }
    const approval = this.#activeApproval(approvalId);
    const review = parseGitOperatorReview(JSON.parse(row.review_json));
    const payload = review.payload;
    if (
      approval?.proposalId !== row.proposal_id ||
      canonicalJson(review) !== row.review_json ||
      gitOperatorReviewDigest(payload) !== row.review_digest ||
      payload.decision !== "approve" ||
      payload.proposalId !== row.proposal_id ||
      payload.effectDigest !== approval.effectDigest ||
      payload.authorityDigest !== approval.authorityDigest ||
      payload.expiresAt !== approval.expiresAt ||
      approval.grantedAt !== row.received_at
    ) {
      return undefined;
    }
    return { approval, review, reviewJson: row.review_json };
  }

  #activeApproval(approvalId: string): GitChangeApprovalV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT approval_id, proposal_id, effect_digest, approval_json, status
         FROM git_change_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as ApprovalRow | undefined;
    if (row?.status !== "active") return undefined;
    const approval = JSON.parse(
      row.approval_json,
    ) as Partial<GitChangeApprovalV1>;
    const expiry = Date.parse(approval.expiresAt ?? "");
    if (
      approval.approvalVersion !== 1 ||
      approval.approvalId !== row.approval_id ||
      approval.proposalId !== row.proposal_id ||
      approval.effectDigest !== row.effect_digest ||
      typeof approval.authorityDigest !== "string" ||
      typeof approval.candidateTreeOid !== "string" ||
      typeof approval.grantedAt !== "string" ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    ) {
      return undefined;
    }
    return approval as GitChangeApprovalV1;
  }
}
