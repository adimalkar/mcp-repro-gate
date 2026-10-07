import { digestCanonical } from "./digest.js";
import {
  snapshotGitChangeProposal,
  type GitApprovalAuthority,
  type RecordedGitOperatorReviewDecision,
  type SqliteGitApprovalStore,
} from "./git-approval-store.js";
import type {
  GitChangeProposal,
  GitChangeProposalV1,
  GitChangeProposalV2,
} from "./git-change-proposal.js";
import {
  stageGitChangeForReview,
  type StagedGitChangeV1,
} from "./git-change-stage.js";
import type { GitOperatorReviewTrustV1 } from "./git-operator-review.js";
import {
  deriveGitApprovalAuthorityFromPlan,
  type GitPlanBindingContext,
} from "./git-plan-binding.js";
import type { Digest } from "./types.js";

/**
 * Deterministic metadata an operator signs over. Contains no patch bytes,
 * key material, or preparation timestamp, so it can be regenerated and
 * compared exactly before signing.
 */
export interface GitOperatorReviewRequestV1 {
  requestVersion: 1;
  proposal: GitChangeProposalV1;
  authority: GitApprovalAuthority;
  staged: StagedGitChangeV1;
  authorityDigest: Digest;
  effectDigest: Digest;
}

/** Same signed metadata as V1, for a proposal with a V2 workspace witness. */
export interface GitOperatorReviewRequestV2 {
  requestVersion: 2;
  proposal: GitChangeProposalV2;
  authority: GitApprovalAuthority;
  staged: StagedGitChangeV1;
  authorityDigest: Digest;
  effectDigest: Digest;
}

export type GitOperatorReviewRequest =
  GitOperatorReviewRequestV1 | GitOperatorReviewRequestV2;

function ownedPatch(patch: unknown): Uint8Array {
  if (!(patch instanceof Uint8Array)) {
    throw new TypeError("Git change patch must be bytes");
  }
  return new Uint8Array(patch);
}

/**
 * Host-only: derive plan authority, stage the exact patch once in isolation,
 * and rederive authority afterwards. Returns the review request and the exact
 * Git-generated staged diff to display. Never updates Git or the ledger.
 */
export function prepareGitOperatorReviewFromPlan(input: {
  proposal: GitChangeProposalV1;
  patch: Uint8Array;
  context: GitPlanBindingContext;
}): { request: GitOperatorReviewRequestV1; stagedPatch: Uint8Array };
export function prepareGitOperatorReviewFromPlan(input: {
  proposal: GitChangeProposalV2;
  patch: Uint8Array;
  context: GitPlanBindingContext;
}): { request: GitOperatorReviewRequestV2; stagedPatch: Uint8Array };
export function prepareGitOperatorReviewFromPlan(input: {
  proposal: GitChangeProposal;
  patch: Uint8Array;
  context: GitPlanBindingContext;
}): { request: GitOperatorReviewRequest; stagedPatch: Uint8Array };
export function prepareGitOperatorReviewFromPlan(input: {
  proposal: GitChangeProposal;
  patch: Uint8Array;
  context: GitPlanBindingContext;
}): { request: GitOperatorReviewRequest; stagedPatch: Uint8Array } {
  const proposal = snapshotGitChangeProposal(input.proposal, "any");
  const patch = ownedPatch(input.patch);
  const context = input.context;
  const authority = deriveGitApprovalAuthorityFromPlan(proposal, context);
  const { staged, stagedPatch } = stageGitChangeForReview(
    proposal,
    context.repositoryPath,
    patch,
  );
  const current = deriveGitApprovalAuthorityFromPlan(proposal, context);
  const authorityDigest = digestCanonical(current);
  if (authorityDigest !== digestCanonical(authority)) {
    throw new Error("Trusted approval authority changed during staging");
  }
  const common = {
    authority: current,
    staged,
    authorityDigest,
    effectDigest: digestCanonical(staged),
  };
  return {
    request:
      proposal.proposalVersion === 2
        ? { requestVersion: 2, proposal, ...common }
        : { requestVersion: 1, proposal, ...common },
    stagedPatch,
  };
}

/**
 * Host-only import of a signed operator decision. Authenticates against
 * current plan authority and host trust before staging, stages freshly,
 * rederives authority, then reauthenticates and records the first decision
 * atomically. Throws when nothing was recorded.
 */
export function applyGitOperatorReviewFromPlan(
  store: SqliteGitApprovalStore,
  input: {
    proposal: GitChangeProposal;
    patch: Uint8Array;
    context: GitPlanBindingContext;
    trust: GitOperatorReviewTrustV1;
    review: unknown;
  },
): RecordedGitOperatorReviewDecision {
  const proposal = snapshotGitChangeProposal(input.proposal, "any");
  const patch = ownedPatch(input.patch);
  const { context, trust, review } = input;
  const authority = deriveGitApprovalAuthorityFromPlan(proposal, context);
  return store.recordGitOperatorReview({
    proposal,
    repositoryPath: context.repositoryPath,
    patch,
    authority,
    trust,
    review,
    revalidateAuthority: () =>
      deriveGitApprovalAuthorityFromPlan(proposal, context),
  });
}

/**
 * Fresh read-only check that an approval carries linked signed evidence that
 * still authenticates under current plan authority and host trust. Not a
 * reservation or atomic promotion gate.
 */
export function matchesOperatorReviewedGitApprovalFromPlan(
  store: SqliteGitApprovalStore,
  input: {
    approvalId: string;
    proposal: GitChangeProposal;
    patch: Uint8Array;
    context: GitPlanBindingContext;
    trust: GitOperatorReviewTrustV1;
  },
): boolean {
  try {
    const proposal = snapshotGitChangeProposal(input.proposal, "any");
    const patch = ownedPatch(input.patch);
    const { approvalId, context, trust } = input;
    const authority = deriveGitApprovalAuthorityFromPlan(proposal, context);
    return store.matchesOperatorReviewedApproval({
      approvalId,
      proposal,
      repositoryPath: context.repositoryPath,
      patch,
      authority,
      trust,
      revalidateAuthority: () =>
        deriveGitApprovalAuthorityFromPlan(proposal, context),
    });
  } catch {
    return false;
  }
}
