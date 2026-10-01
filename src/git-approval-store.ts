import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod/v4";

import { canonicalJson } from "./canonical-json.js";
import { digestCanonical } from "./digest.js";
import {
  verifyGitChangeProposal,
  type GitChangeProposalV1,
} from "./git-change-proposal.js";
import { stageGitChangeProposal } from "./git-change-stage.js";
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
  proposal: GitChangeProposalV1;
  repositoryPath: string;
  patch: Uint8Array;
  authority: GitApprovalAuthority;
  trust: unknown;
  review: unknown;
  revalidateAuthority: () => GitApprovalAuthority;
}

export interface MatchOperatorReviewedApprovalInput {
  approvalId: string;
  proposal: GitChangeProposalV1;
  repositoryPath: string;
  patch: Uint8Array;
  authority: GitApprovalAuthority;
  trust: unknown;
  revalidateAuthority: () => GitApprovalAuthority;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/u;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/u;
const digestSchema = z
  .string()
  .regex(DIGEST_PATTERN)
  .transform((value) => value as Digest);
const oidSchema = z.string().regex(OID_PATTERN);
const proposalSchema = z.strictObject({
  proposalVersion: z.literal(1),
  proposalId: digestSchema,
  repositoryId: z.string().min(1).max(256),
  actionId: digestSchema,
  policyDigest: digestSchema,
  workspace: z.strictObject({
    source: z.literal("git_observed"),
    rootDigest: digestSchema,
    headCommit: oidSchema,
    headTree: oidSchema,
    destinationRef: z.string().min(1).max(1024),
    destinationOid: oidSchema,
    status: z.literal("clean"),
  }),
  patchDigest: digestSchema,
  allowedPaths: z.array(z.string().min(1).max(4096)).min(1).max(256),
  createdAt: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
});

/**
 * Read an untrusted proposal exactly once into an owned, strictly shaped copy
 * and check its integrity. This does not establish authority.
 */
export function snapshotGitChangeProposal(value: unknown): GitChangeProposalV1 {
  const proposal = proposalSchema.parse(value);
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
  proposal: GitChangeProposalV1,
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

/** Host-side approval ledger. Call grant only after an operator decision. */
export class SqliteGitApprovalStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    // A signed decision is keyed by proposal and, for approve only, linked to
    // the exact approval row for that same proposal.
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

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
    `);
  }

  close(): void {
    this.#database.close();
  }

  /**
   * Re-stage before recording an explicit host-side grant. Never updates Git.
   * Refuses a proposal that already has a recorded signed decision.
   */
  grant(input: {
    proposal: GitChangeProposalV1;
    repositoryPath: string;
    patch: Uint8Array;
    authority: GitApprovalAuthority;
    reviewedEffectDigest: Digest;
    expiresAt: string;
  }): GitChangeApprovalV1 {
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
    const proposal = snapshotGitChangeProposal(input.proposal);
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
  matchesActiveApproval(input: {
    approvalId: string;
    proposal: GitChangeProposalV1;
    repositoryPath: string;
    patch: Uint8Array;
    authority: GitApprovalAuthority;
  }): boolean {
    try {
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
      const proposal = snapshotGitChangeProposal(input.proposal);
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

  /** Revocation is durable; no new grant for the same proposal is allowed. */
  revoke(approvalId: string): boolean {
    const changed = this.#database
      .prepare(
        `UPDATE git_change_approvals
         SET status = 'revoked', revoked_at = ?
         WHERE approval_id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), approvalId);
    return Number(changed.changes) === 1;
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
    proposal: GitChangeProposalV1,
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
