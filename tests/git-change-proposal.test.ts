import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { sha256 } from "../src/digest.js";
import {
  createGitChangeProposal,
  matchesCurrentGitWorkspace,
  observeCleanGitWorkspace,
  verifyGitChangeProposal,
  type CreateGitChangeProposalInput,
} from "../src/git-change-proposal.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function repository(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "reprogate-change-proposal-"));
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

function input(root: string): CreateGitChangeProposalInput {
  return {
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/main",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch: Buffer.from("diff --git a/src/value.txt b/src/value.txt\n"),
    allowedPaths: ["src/value.txt"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("a proposal binds an observed clean Git branch and an exact patch without storing source", (context) => {
  const root = repository(context);
  const requested = input(root);
  const proposal = createGitChangeProposal(requested);

  assert.equal(proposal.workspace.source, "git_observed");
  assert.equal(proposal.workspace.status, "clean");
  assert.equal(
    proposal.workspace.headCommit,
    git(root, "rev-parse", "HEAD").trim(),
  );
  assert.equal(proposal.workspace.destinationRef, "refs/heads/main");
  assert.equal(proposal.patchDigest, sha256(requested.patch));
  assert.equal(verifyGitChangeProposal(proposal), true);
  assert.equal(
    matchesCurrentGitWorkspace(proposal, root, requested.patch),
    true,
  );
  assert.equal(JSON.stringify(proposal).includes("diff --git"), false);

  const schema = JSON.parse(
    readFileSync("schemas/git-change-proposal.schema.json", "utf8"),
  ) as object;
  const validate = new Ajv2020({
    strict: true,
    validateFormats: false,
  }).compile(schema);
  assert.equal(validate(proposal), true, JSON.stringify(validate.errors));
});

test("tampering with a bound field or changing the patch fails the read-only checks", (context) => {
  const root = repository(context);
  const requested = input(root);
  const proposal = createGitChangeProposal(requested);
  assert.equal(
    matchesCurrentGitWorkspace(proposal, root, Buffer.from("different")),
    false,
  );
  assert.equal(
    verifyGitChangeProposal({ ...proposal, allowedPaths: ["other.txt"] }),
    false,
  );
  assert.equal(
    verifyGitChangeProposal({ ...proposal, policyDigest: sha256("policy v2") }),
    false,
  );
});

test("tracked, untracked, and moved-ref drift fail closed", (context) => {
  const root = repository(context);
  const requested = input(root);
  const proposal = createGitChangeProposal(requested);

  writeFileSync(join(root, "src", "value.txt"), "changed\n");
  assert.equal(
    matchesCurrentGitWorkspace(proposal, root, requested.patch),
    false,
  );
  assert.throws(() => createGitChangeProposal(requested), /must be clean/);

  git(root, "restore", "src/value.txt");
  writeFileSync(join(root, "untracked.txt"), "new\n");
  assert.equal(
    matchesCurrentGitWorkspace(proposal, root, requested.patch),
    false,
  );
  assert.throws(() => createGitChangeProposal(requested), /must be clean/);

  git(root, "add", "untracked.txt");
  git(root, "commit", "-q", "-m", "move ref");
  assert.equal(
    matchesCurrentGitWorkspace(proposal, root, requested.patch),
    false,
  );
});

test("unsafe paths, nested roots, and wrong branch refs are rejected", (context) => {
  const root = repository(context);
  for (const path of [
    "../outside.txt",
    "/absolute.txt",
    ".git/config",
    ".GIT/config",
    "a//b",
    "a\\b",
    "a:b",
    "a*.txt",
    "a./b",
    "a /b",
    "a\nb",
  ]) {
    assert.throws(
      () => createGitChangeProposal({ ...input(root), allowedPaths: [path] }),
      /Unsafe or non-exact allowed path/,
    );
  }
  assert.throws(
    () => createGitChangeProposal({ ...input(root), allowedPaths: ["x", "x"] }),
    /duplicates/,
  );
  assert.throws(
    () => observeCleanGitWorkspace(join(root, "src"), "refs/heads/main"),
    /Git worktree root/,
  );
  assert.throws(
    () => observeCleanGitWorkspace(root, "refs/heads/not-main"),
    /checked-out branch/,
  );
});

test("Git observations ignore inherited repository redirection variables", (context) => {
  const root = repository(context);
  const moduleUrl = new URL("../src/git-change-proposal.js", import.meta.url);
  const script = `import { observeCleanGitWorkspace } from ${JSON.stringify(moduleUrl.href)};
    process.stdout.write(observeCleanGitWorkspace(process.argv[1], "refs/heads/main").headCommit);`;
  const observed = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, root],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_DIR: join(root, "not-the-repository"),
        GIT_WORK_TREE: join(root, "src"),
        GIT_INDEX_FILE: join(root, "wrong-index"),
      },
    },
  );
  assert.equal(observed, git(root, "rev-parse", "HEAD").trim());
});
