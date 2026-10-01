import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { digestCanonical } from "./digest.js";
import type { GitChangeProposalV1 } from "./git-change-proposal.js";
import { stageGitChangeProposal } from "./git-change-stage.js";
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

/** Host-side approval ledger. Call grant only after an operator decision. */
export class SqliteGitApprovalStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS git_change_approvals (
        approval_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        effect_digest TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        revoked_at TEXT
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  /** Re-stage before recording an explicit host-side grant. Never updates Git. */
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
    return approval;
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
