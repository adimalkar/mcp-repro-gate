import { digestCanonical } from "./digest.js";
import { envelopeDigest } from "./envelope.js";
import {
  type GitApprovalAuthority,
  type GitChangeApprovalV1,
  SqliteGitApprovalStore,
} from "./git-approval-store.js";
import {
  gitChangeIntentFromProposal,
  observeCleanGitWorkspace,
  type GitChangeProposalV1,
} from "./git-change-proposal.js";
import type { PlanStore } from "./kernel.js";
import { evaluatePolicy } from "./policy.js";
import type { CatalogTool, PolicyV1 } from "./types.js";

export const GIT_CHANGE_PROMOTE_SCOPE = "git_change:promote";

export interface GitPlanBindingContext {
  repositoryPath: string;
  repositoryId: string;
  destinationRef: string;
  catalogTool: CatalogTool;
  currentPolicy: PolicyV1;
  plans: PlanStore;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Derive authority from operator configuration and a persisted exact-action plan. */
export function deriveGitApprovalAuthorityFromPlan(
  proposal: GitChangeProposalV1,
  context: GitPlanBindingContext,
): GitApprovalAuthority {
  const intent = gitChangeIntentFromProposal(proposal);
  if (
    proposal.repositoryId !== context.repositoryId ||
    proposal.workspace.destinationRef !== context.destinationRef
  ) {
    throw new Error(
      "Proposal does not match configured repository or destination",
    );
  }
  const currentWorkspace = observeCleanGitWorkspace(
    context.repositoryPath,
    context.destinationRef,
  );
  if (
    digestCanonical(currentWorkspace) !== digestCanonical(proposal.workspace)
  ) {
    throw new Error("Git workspace no longer matches the proposed intent");
  }

  const plan = context.plans.get(proposal.actionId);
  if (plan === undefined) {
    throw new Error("No persisted action plan matches the proposal");
  }
  const envelope = plan.envelope;
  if (
    envelopeDigest(envelope) !== plan.envelopeDigest ||
    envelope.actionId !== proposal.actionId ||
    envelope.input.argumentsDigest !== digestCanonical(intent)
  ) {
    throw new Error("Action plan does not bind the exact Git change intent");
  }
  const now = Date.now();
  if (
    !Number.isFinite(Date.parse(envelope.plannedAt)) ||
    Date.parse(envelope.plannedAt) > now ||
    !Number.isFinite(Date.parse(envelope.expiresAt)) ||
    Date.parse(envelope.expiresAt) <= now ||
    Date.parse(proposal.expiresAt) > Date.parse(envelope.expiresAt)
  ) {
    throw new Error("Action plan is not current for the proposal expiry");
  }

  const tool = context.catalogTool;
  const observedTrustSource: unknown = envelope.tool.trustSource;
  if (
    observedTrustSource !== "operator_catalog" ||
    envelope.tool.serverRef !== tool.serverRef ||
    envelope.tool.toolName !== tool.toolName ||
    envelope.tool.schemaDigest !== digestCanonical(tool.inputSchema) ||
    envelope.tool.artifactDigest !== tool.artifactDigest ||
    digestCanonical(envelope.authority.effects) !==
      digestCanonical(sortedUnique(tool.effects)) ||
    digestCanonical(envelope.authority.scopes) !==
      digestCanonical(sortedUnique(tool.scopes ?? [])) ||
    digestCanonical(envelope.authority.filesystemRoots) !==
      digestCanonical(sortedUnique(tool.filesystemRoots ?? [])) ||
    digestCanonical(envelope.authority.networkDestinations) !==
      digestCanonical(sortedUnique(tool.networkDestinations ?? [])) ||
    digestCanonical(envelope.authority.secretHandles) !==
      digestCanonical(sortedUnique(tool.secretHandles ?? [])) ||
    !envelope.authority.scopes.includes(GIT_CHANGE_PROMOTE_SCOPE) ||
    !envelope.authority.effects.includes("local_write")
  ) {
    throw new Error(
      "Action plan does not match the configured Git catalog tool",
    );
  }

  const currentDecision = evaluatePolicy(
    context.currentPolicy,
    tool.toolRef,
    tool.effects,
  );
  if (
    currentDecision.decision === "deny" ||
    digestCanonical(plan.policy) !== digestCanonical(currentDecision) ||
    envelope.authority.policyDigest !== currentDecision.policyDigest ||
    proposal.policyDigest !== currentDecision.policyDigest
  ) {
    throw new Error("Action plan is denied or its policy has changed");
  }
  return {
    repositoryId: context.repositoryId,
    actionId: envelope.actionId,
    policyDigest: currentDecision.policyDigest,
    workspaceRootDigest: currentWorkspace.rootDigest,
    destinationRef: context.destinationRef,
    maxExpiresAt: envelope.expiresAt,
  };
}

/** Host-only grant after displaying the exact patch and staged effect. */
export function grantGitChangeFromPlan(
  store: SqliteGitApprovalStore,
  input: {
    proposal: GitChangeProposalV1;
    patch: Uint8Array;
    reviewedEffectDigest: GitChangeApprovalV1["effectDigest"];
    expiresAt: string;
    context: GitPlanBindingContext;
  },
): GitChangeApprovalV1 {
  const authority = deriveGitApprovalAuthorityFromPlan(
    input.proposal,
    input.context,
  );
  return store.grant({
    proposal: input.proposal,
    repositoryPath: input.context.repositoryPath,
    patch: input.patch,
    authority,
    reviewedEffectDigest: input.reviewedEffectDigest,
    expiresAt: input.expiresAt,
  });
}

/** Re-derive current plan authority before the ledger's read-only match. */
export function matchesGitApprovalFromPlan(
  store: SqliteGitApprovalStore,
  input: {
    approvalId: string;
    proposal: GitChangeProposalV1;
    patch: Uint8Array;
    context: GitPlanBindingContext;
  },
): boolean {
  try {
    const authority = deriveGitApprovalAuthorityFromPlan(
      input.proposal,
      input.context,
    );
    return store.matchesActiveApproval({
      approvalId: input.approvalId,
      proposal: input.proposal,
      repositoryPath: input.context.repositoryPath,
      patch: input.patch,
      authority,
    });
  } catch {
    return false;
  }
}
