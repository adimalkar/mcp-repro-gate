// Test-only subprocess: imports one signed review through the real plan-bound
// API so concurrent processes race on the same approval database.
import { readFileSync } from "node:fs";

import { SqliteExecutionStore } from "../../src/execution-store.js";
import { SqliteGitApprovalStore } from "../../src/git-approval-store.js";
import type { GitChangeProposalV1 } from "../../src/git-change-proposal.js";
import type { GitOperatorReviewTrustV1 } from "../../src/git-operator-review.js";
import { applyGitOperatorReviewFromPlan } from "../../src/git-operator-review-plan.js";
import type { CatalogTool, PolicyV1 } from "../../src/types.js";

interface WorkerInput {
  plansPath: string;
  approvalsPath: string;
  repositoryPath: string;
  repositoryId: string;
  destinationRef: string;
  catalogTool: CatalogTool;
  currentPolicy: PolicyV1;
  proposal: GitChangeProposalV1;
  patchBase64: string;
  trust: GitOperatorReviewTrustV1;
  review: unknown;
  startAt: number;
}

const inputPath = process.argv[2];
if (inputPath === undefined) throw new Error("Worker input path is required");
const input = JSON.parse(readFileSync(inputPath, "utf8")) as WorkerInput;
const plans = new SqliteExecutionStore(input.plansPath);
const store = new SqliteGitApprovalStore(input.approvalsPath);
try {
  const delay = input.startAt - Date.now();
  if (delay > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  try {
    const result = applyGitOperatorReviewFromPlan(store, {
      proposal: input.proposal,
      patch: Buffer.from(input.patchBase64, "base64"),
      context: {
        repositoryPath: input.repositoryPath,
        repositoryId: input.repositoryId,
        destinationRef: input.destinationRef,
        catalogTool: input.catalogTool,
        currentPolicy: input.currentPolicy,
        plans,
      },
      trust: input.trust,
      review: input.review,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        decision: result.decision,
        reviewDigest: result.reviewDigest,
        approvalId:
          result.decision === "approve" ? result.approval.approvalId : null,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      })}\n`,
    );
    process.exitCode = 1;
  }
} finally {
  store.close();
  plans.close();
}
