import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { digestCanonical, sha256 } from "../src/digest.js";
import { createGitChangeProposal } from "../src/git-change-proposal.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function repository(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "reprogate-stage-test-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "ReproGate Test");
  git(root, "config", "user.email", "test@example.invalid");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "value.txt"), "before\n");
  git(root, "add", "src/value.txt");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

function proposedPatch(root: string, paths: string[]) {
  const patch = Buffer.from(git(root, "diff", "--cached", "--binary"));
  git(root, "reset", "-q", "--hard", "HEAD");
  const proposal = createGitChangeProposal({
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/main",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch,
    allowedPaths: paths,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { patch, proposal };
}

test("stages an exact patch without changing the protected worktree or ref", (context) => {
  const root = repository(context);
  writeFileSync(join(root, "src", "value.txt"), "after\n");
  git(root, "add", "src/value.txt");
  const { patch, proposal } = proposedPatch(root, ["src/value.txt"]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const staged = stageGitChangeProposal(proposal, root, patch);

  assert.equal(staged.proposalId, proposal.proposalId);
  assert.equal(staged.baseCommit, head);
  assert.deepEqual(staged.changedPaths, ["src/value.txt"]);
  assert.notEqual(staged.candidateTreeOid, proposal.workspace.headTree);
  assert.match(staged.stagedPatchDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("rejects actual edits outside the proposal path list", (context) => {
  const root = repository(context);
  writeFileSync(join(root, "other.txt"), "unexpected\n");
  git(root, "add", "other.txt");
  const { patch, proposal } = proposedPatch(root, ["src/value.txt"]);
  assert.throws(
    () => stageGitChangeProposal(proposal, root, patch),
    /outside the proposal scope/u,
  );
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("requires both old and new rename paths in scope", (context) => {
  const root = repository(context);
  git(root, "mv", "src/value.txt", "src/renamed.txt");
  const { patch, proposal } = proposedPatch(root, ["src/renamed.txt"]);
  assert.throws(
    () => stageGitChangeProposal(proposal, root, patch),
    /outside the proposal scope/u,
  );
  const scoped = createGitChangeProposal({
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/main",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch,
    allowedPaths: ["src/value.txt", "src/renamed.txt"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.deepEqual(stageGitChangeProposal(scoped, root, patch).changedPaths, [
    "src/renamed.txt",
    "src/value.txt",
  ]);
});

test("rejects a symlink effect even when its path is allowed", (context) => {
  const root = repository(context);
  const blob = execFileSync(
    "git",
    ["-C", root, "hash-object", "-w", "--stdin"],
    { input: "src/value.txt", encoding: "utf8" },
  ).trim();
  git(root, "update-index", "--add", "--cacheinfo", `120000,${blob},link.txt`);
  const { patch, proposal } = proposedPatch(root, ["link.txt"]);
  assert.throws(
    () => stageGitChangeProposal(proposal, root, patch),
    /symlink, submodule, or unsupported file mode/u,
  );
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("rejects tampered patches, expired proposals, dirty worktrees, and invalid diffs", (context) => {
  const root = repository(context);
  writeFileSync(join(root, "src", "value.txt"), "after\n");
  git(root, "add", "src/value.txt");
  const { patch, proposal } = proposedPatch(root, ["src/value.txt"]);
  assert.throws(
    () => stageGitChangeProposal(proposal, root, Buffer.from("different")),
    /Patch bytes do not match/u,
  );
  assert.throws(
    () =>
      stageGitChangeProposal(
        { ...proposal, allowedPaths: ["other.txt"] },
        root,
        patch,
      ),
    /integrity check/u,
  );
  const expired = { ...proposal, expiresAt: "2000-01-01T00:00:00.000Z" };
  const unsigned = Object.fromEntries(
    Object.entries(expired).filter(([key]) => key !== "proposalId"),
  );
  expired.proposalId = digestCanonical(unsigned);
  assert.throws(
    () => stageGitChangeProposal(expired, root, patch),
    /has expired/u,
  );
  writeFileSync(join(root, "untracked.txt"), "dirty\n");
  assert.throws(
    () => stageGitChangeProposal(proposal, root, patch),
    /workspace changed before staging/u,
  );
  rmSync(join(root, "untracked.txt"));

  const invalidPatch = Buffer.from("not a Git patch\n");
  const invalid = createGitChangeProposal({
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/main",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch: invalidPatch,
    allowedPaths: ["src/value.txt"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.throws(
    () => stageGitChangeProposal(invalid, root, invalidPatch),
    /Git staging command failed/u,
  );
  assert.equal(git(root, "status", "--porcelain"), "");
});
