import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { digestCanonical, sha256 } from "../src/digest.js";
import { createGitChangeProposal } from "../src/git-change-proposal.js";
import {
  stageGitChangeForReview,
  stageGitChangeProposal,
} from "../src/git-change-stage.js";

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

test("review staging returns exact Git binary diff bytes with compatible metadata and no protected mutations", (context) => {
  const root = repository(context);
  writeFileSync(join(root, "src", "value.txt"), "after\n");
  writeFileSync(join(root, "binary.dat"), Buffer.from([0, 255, 1, 0, 2]));
  git(root, "add", "src/value.txt", "binary.dat");
  const gitPatch = execFileSync("git", [
    "-C",
    root,
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
  ]);
  // Hunk section text is accepted by Git but does not appear in its regenerated diff.
  const patch = Buffer.from(
    gitPatch
      .toString("utf8")
      .replace("@@ -1 +1 @@", "@@ -1 +1 @@ caller-only annotation"),
  );
  git(root, "reset", "-q", "--hard", "HEAD");
  const proposal = createGitChangeProposal({
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/main",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch,
    allowedPaths: ["src/value.txt", "binary.dat"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const head = git(root, "rev-parse", "HEAD");
  const index = readFileSync(join(root, ".git", "index"));
  const file = readFileSync(join(root, "src", "value.txt"));
  // Isolate clone-cleanup assertions from other test-file processes.
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-stage-scratch-"));
  const tempVariables = ["TMPDIR", "TMP", "TEMP"];
  const previous = tempVariables.map((name) => process.env[name]);
  context.after(() => {
    tempVariables.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    });
    rmSync(scratch, { recursive: true, force: true });
  });
  tempVariables.forEach((name) => {
    process.env[name] = scratch;
  });
  const reviewed = stageGitChangeForReview(proposal, root, patch);
  assert.deepEqual(reviewed.stagedPatch, gitPatch);
  assert.notEqual(sha256(reviewed.stagedPatch), proposal.patchDigest);
  assert.match(
    Buffer.from(reviewed.stagedPatch).toString("utf8"),
    /GIT binary patch/u,
  );
  assert.equal(sha256(reviewed.stagedPatch), reviewed.staged.stagedPatchDigest);
  const legacy = stageGitChangeProposal(proposal, root, patch);
  assert.deepEqual(reviewed.staged, legacy);
  assert.equal(digestCanonical(reviewed.staged), digestCanonical(legacy));
  assert.deepEqual(
    Object.keys(legacy).sort(),
    [
      "stageVersion",
      "proposalId",
      "baseCommit",
      "candidateTreeOid",
      "changedPaths",
      "stagedPatchDigest",
    ].sort(),
  );
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "rev-parse", "refs/heads/main"), head);
  assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
  assert.deepEqual(readFileSync(join(root, "src", "value.txt")), file);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.deepEqual(readdirSync(scratch), []);
  const outside = createGitChangeProposal({
    repositoryPath: root,
    repositoryId: proposal.repositoryId,
    destinationRef: proposal.workspace.destinationRef,
    actionId: proposal.actionId,
    policyDigest: proposal.policyDigest,
    patch,
    allowedPaths: ["src/value.txt"],
    expiresAt: proposal.expiresAt,
  });
  assert.throws(
    () => stageGitChangeForReview(outside, root, patch),
    /outside the proposal scope/u,
  );
  assert.deepEqual(readdirSync(scratch), []);
  assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
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
