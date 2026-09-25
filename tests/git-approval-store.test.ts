import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { digestCanonical, sha256 } from "../src/digest.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import { createGitChangeProposal } from "../src/git-change-proposal.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function fixture(context: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-approval-test-"));
  context.after(() => {
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
  const proposal = createGitChangeProposal({
    repositoryPath,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/main",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch,
    allowedPaths: ["src/value.txt"],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  const authority = {
    repositoryId: proposal.repositoryId,
    actionId: proposal.actionId,
    policyDigest: proposal.policyDigest,
    workspaceRootDigest: proposal.workspace.rootDigest,
    destinationRef: proposal.workspace.destinationRef,
    maxExpiresAt: proposal.expiresAt,
  };
  return {
    repositoryPath,
    databasePath: join(scratch, "approvals.sqlite"),
    patch,
    proposal,
    authority,
    reviewedEffectDigest: digestCanonical(
      stageGitChangeProposal(proposal, repositoryPath, patch),
    ),
  };
}

test("an exact staged effect is durably approved without changing Git", (context) => {
  const input = fixture(context);
  const head = git(input.repositoryPath, "rev-parse", "HEAD").trim();
  const store = new SqliteGitApprovalStore(input.databasePath);
  const approval = store.grant({
    ...input,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(approval.proposalId, input.proposal.proposalId);
  assert.match(approval.effectDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    store.matchesActiveApproval({ ...input, approvalId: approval.approvalId }),
    true,
  );
  store.close();

  const reopened = new SqliteGitApprovalStore(input.databasePath);
  assert.equal(
    reopened.matchesActiveApproval({
      ...input,
      approvalId: approval.approvalId,
    }),
    true,
  );
  assert.equal(git(input.repositoryPath, "rev-parse", "HEAD").trim(), head);
  assert.equal(git(input.repositoryPath, "status", "--porcelain"), "");
  reopened.close();
});

test("a changed proposal, patch, workspace, or approval ID does not match", (context) => {
  const input = fixture(context);
  const store = new SqliteGitApprovalStore(input.databasePath);
  const approval = store.grant({
    ...input,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const check = { ...input, approvalId: approval.approvalId };
  assert.equal(
    store.matchesActiveApproval({ ...check, patch: Buffer.from("other") }),
    false,
  );
  assert.equal(
    store.matchesActiveApproval({
      ...check,
      proposal: { ...input.proposal, policyDigest: sha256("different") },
    }),
    false,
  );
  assert.equal(
    store.matchesActiveApproval({
      ...check,
      authority: { ...input.authority, policyDigest: sha256("new policy") },
    }),
    false,
  );
  assert.equal(
    store.matchesActiveApproval({ ...check, approvalId: "not-an-id" }),
    false,
  );
  writeFileSync(join(input.repositoryPath, "untracked.txt"), "dirty\n");
  assert.equal(store.matchesActiveApproval(check), false);
  store.close();
});

test("revocation is durable and a proposal cannot be approved twice", (context) => {
  const input = fixture(context);
  const first = new SqliteGitApprovalStore(input.databasePath);
  const second = new SqliteGitApprovalStore(input.databasePath);
  const request = {
    ...input,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const approval = first.grant(request);
  assert.throws(() => second.grant(request), /UNIQUE constraint failed/u);
  assert.equal(second.revoke(approval.approvalId), true);
  assert.equal(
    first.matchesActiveApproval({ ...input, approvalId: approval.approvalId }),
    false,
  );
  assert.equal(first.revoke(approval.approvalId), false);
  first.close();
  second.close();
});

test("approval expiry must be bounded by the proposal expiry", (context) => {
  const input = fixture(context);
  const store = new SqliteGitApprovalStore(input.databasePath);
  assert.throws(
    () =>
      store.grant({
        ...input,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    /Approval expiry/u,
  );
  assert.throws(
    () =>
      store.grant({
        ...input,
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      }),
    /Approval expiry/u,
  );
  store.close();
});

test("a grant rejects unreviewed effects and mismatched authority", (context) => {
  const input = fixture(context);
  const store = new SqliteGitApprovalStore(input.databasePath);
  const request = {
    ...input,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.throws(
    () =>
      store.grant({ ...request, reviewedEffectDigest: sha256("other effect") }),
    /operator-reviewed effect/u,
  );
  assert.throws(
    () =>
      store.grant({
        ...request,
        authority: { ...input.authority, repositoryId: "wrong/repository" },
      }),
    /trusted approval authority/u,
  );
  assert.equal(
    store.matchesActiveApproval({ ...input, approvalId: "not-granted" }),
    false,
  );
  store.close();
});
