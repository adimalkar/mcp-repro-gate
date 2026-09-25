import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { digestCanonical, sha256 } from "../src/digest.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import {
  createGitChangeIntent,
  createGitChangeProposal,
} from "../src/git-change-proposal.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";
import {
  deriveGitApprovalAuthorityFromPlan,
  GIT_CHANGE_PROMOTE_SCOPE,
  grantGitChangeFromPlan,
  matchesGitApprovalFromPlan,
  type GitPlanBindingContext,
} from "../src/git-plan-binding.js";
import { InMemoryPlanStore, ReproGateKernel } from "../src/kernel.js";
import type { CatalogTool, PolicyV1 } from "../src/types.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

const tool: CatalogTool = {
  toolRef: "git.change",
  serverRef: "reprogate.git",
  toolName: "promote_patch",
  description: "Plan an exact Git change",
  inputSchema: { type: "object" },
  effects: ["local_write"],
  scopes: [GIT_CHANGE_PROMOTE_SCOPE],
};

const policy: PolicyV1 = {
  version: 1,
  defaults: {
    local_read: "allow",
    local_write: "approval_required",
    process_exec: "deny",
    network_read: "deny",
    network_write: "deny",
    credential_use: "deny",
    destructive: "deny",
  },
  rules: [],
};

function fixture(context: TestContext, planArguments?: unknown) {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-plan-binding-"));
  const handles: {
    plans?: SqliteExecutionStore;
    approvalStore?: SqliteGitApprovalStore;
  } = {};
  context.after(() => {
    handles.approvalStore?.close();
    handles.plans?.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const repositoryPath = join(scratch, "repository");
  mkdirSync(repositoryPath);
  git(repositoryPath, "init", "-q", "-b", "main");
  git(repositoryPath, "config", "user.name", "ReproGate Test");
  git(repositoryPath, "config", "user.email", "test@example.invalid");
  mkdirSync(join(repositoryPath, "src"));
  writeFileSync(join(repositoryPath, "src", "value.txt"), "before\n");
  git(repositoryPath, "add", "src/value.txt");
  git(repositoryPath, "commit", "-q", "-m", "initial");
  writeFileSync(join(repositoryPath, "src", "value.txt"), "after\n");
  git(repositoryPath, "add", "src/value.txt");
  const patch = Buffer.from(
    git(repositoryPath, "diff", "--cached", "--binary"),
  );
  git(repositoryPath, "reset", "-q", "--hard", "HEAD");

  const repositoryId = "example/repository";
  const destinationRef = "refs/heads/main";
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const intentInput = {
    repositoryPath,
    repositoryId,
    destinationRef,
    patch,
    allowedPaths: ["src/value.txt"],
    expiresAt,
  };
  const intent = createGitChangeIntent(intentInput);
  const plans = new SqliteExecutionStore(join(scratch, "plans.sqlite"));
  handles.plans = plans;
  const kernel = new ReproGateKernel([tool], policy, plans);
  const plan = kernel.plan({
    toolRef: tool.toolRef,
    arguments: planArguments ?? intent,
    ttlMs: 120_000,
  });
  const proposal = createGitChangeProposal({
    ...intentInput,
    actionId: plan.envelope.actionId,
    policyDigest: plan.policy.policyDigest,
  });
  const contextBinding: GitPlanBindingContext = {
    repositoryPath,
    repositoryId,
    destinationRef,
    catalogTool: tool,
    currentPolicy: policy,
    plans,
  };
  const approvalStore = new SqliteGitApprovalStore(
    join(scratch, "approvals.sqlite"),
  );
  handles.approvalStore = approvalStore;
  return {
    repositoryPath,
    patch,
    proposal,
    contextBinding,
    approvalStore,
    reviewedEffectDigest: digestCanonical(
      stageGitChangeProposal(proposal, repositoryPath, patch),
    ),
  };
}

test("a persisted exact-action plan binds the Git intent before approval", (context) => {
  const input = fixture(context);
  const authority = deriveGitApprovalAuthorityFromPlan(
    input.proposal,
    input.contextBinding,
  );
  assert.equal(authority.actionId, input.proposal.actionId);
  assert.equal(authority.policyDigest, input.proposal.policyDigest);
  const approval = grantGitChangeFromPlan(input.approvalStore, {
    proposal: input.proposal,
    patch: input.patch,
    reviewedEffectDigest: input.reviewedEffectDigest,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    context: input.contextBinding,
  });
  assert.equal(
    matchesGitApprovalFromPlan(input.approvalStore, {
      approvalId: approval.approvalId,
      proposal: input.proposal,
      patch: input.patch,
      context: input.contextBinding,
    }),
    true,
  );
  assert.equal(git(input.repositoryPath, "status", "--porcelain"), "");
});

test("a plan for different arguments cannot approve the Git proposal", (context) => {
  const input = fixture(context, { unrelated: "arguments" });
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, input.contextBinding),
    /exact Git change intent/u,
  );
});

test("missing or corrupted persisted plans fail closed", (context) => {
  const input = fixture(context);
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, {
        ...input.contextBinding,
        plans: new InMemoryPlanStore(),
      }),
    /No persisted action plan/u,
  );
  const original = input.contextBinding.plans.get(input.proposal.actionId);
  assert.ok(original);
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, {
        ...input.contextBinding,
        plans: {
          save: () => undefined,
          get: () => ({ ...original, envelopeDigest: sha256("wrong") }),
        },
      }),
    /exact Git change intent/u,
  );
});

test("repository, catalog, and current policy drift fail closed", (context) => {
  const input = fixture(context);
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, {
        ...input.contextBinding,
        repositoryId: "wrong/repository",
      }),
    /configured repository/u,
  );
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, {
        ...input.contextBinding,
        catalogTool: { ...tool, toolName: "different_tool" },
      }),
    /configured Git catalog tool/u,
  );
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, {
        ...input.contextBinding,
        catalogTool: { ...tool, scopes: [] },
      }),
    /configured Git catalog tool/u,
  );
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, {
        ...input.contextBinding,
        currentPolicy: {
          ...policy,
          defaults: { ...policy.defaults, local_write: "deny" },
        },
      }),
    /policy has changed/u,
  );
  writeFileSync(join(input.repositoryPath, "untracked.txt"), "drift\n");
  assert.throws(
    () =>
      deriveGitApprovalAuthorityFromPlan(input.proposal, input.contextBinding),
    /must be clean/u,
  );
});

test("a later policy change invalidates an existing approval match", (context) => {
  const input = fixture(context);
  const approval = grantGitChangeFromPlan(input.approvalStore, {
    proposal: input.proposal,
    patch: input.patch,
    reviewedEffectDigest: input.reviewedEffectDigest,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    context: input.contextBinding,
  });
  const changedContext = {
    ...input.contextBinding,
    currentPolicy: {
      ...policy,
      defaults: { ...policy.defaults, local_write: "deny" as const },
    },
  };
  assert.equal(
    matchesGitApprovalFromPlan(input.approvalStore, {
      approvalId: approval.approvalId,
      proposal: input.proposal,
      patch: input.patch,
      context: changedContext,
    }),
    false,
  );
});
