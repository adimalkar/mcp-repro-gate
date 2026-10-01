import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  gitReviewProtectedRoots,
  resolveGitReviewStatePaths,
  type GitReviewConfigV1,
} from "../src/git-review-config.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function fixture(context: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-review-paths-"));
  context.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const main = join(scratch, "main");
  const state = join(scratch, "state");
  mkdirSync(main);
  mkdirSync(state);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "ReproGate Path Test");
  git(main, "config", "user.email", "paths@example.invalid");
  writeFileSync(join(main, "value.txt"), "stable\n");
  git(main, "add", "value.txt");
  git(main, "commit", "-q", "-m", "initial");
  const linked = join(scratch, "linked");
  git(main, "worktree", "add", "-q", "-b", "linked", linked);
  const gitdir = realpathSync(
    resolve(linked, git(linked, "rev-parse", "--git-dir")),
  );
  const common = realpathSync(
    resolve(linked, git(linked, "rev-parse", "--git-common-dir")),
  );
  const config = (repositoryPath: string): GitReviewConfigV1 => ({
    configVersion: 1,
    repositoryPath,
    repositoryId: "paths/repository",
    destinationRef: "refs/heads/linked",
    planDatabasePath: join(state, "plans.sqlite"),
    approvalDatabasePath: join(state, "approvals.sqlite"),
    catalogTool: {
      toolRef: "git.change",
      serverRef: "reprogate.git",
      toolName: "promote_patch",
      description: "Path validation test",
      inputSchema: { type: "object" },
      effects: ["local_write"],
      scopes: ["git_change:promote"],
    },
    currentPolicy: {
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
    },
    trust: {
      audience: "reprogate:path-test",
      maxReviewTtlMs: 60_000,
      operators: [],
    },
  });
  return { scratch, main, state, linked, gitdir, common, config };
}

function rejectsMetadataState(
  f: ReturnType<typeof fixture>,
  repositoryPath: string,
) {
  const config = f.config(repositoryPath);
  const options = { requirePlanDatabase: false };
  for (const directory of [f.gitdir, f.common]) {
    assert.throws(
      () =>
        resolveGitReviewStatePaths(
          {
            ...config,
            approvalDatabasePath: join(directory, "approval.sqlite"),
          },
          options,
        ),
      /outside the protected repository/u,
    );
    assert.throws(
      () =>
        resolveGitReviewStatePaths(
          { ...config, planDatabasePath: join(directory, "plans.sqlite") },
          options,
        ),
      /outside the protected repository/u,
    );
  }
  assert.equal(
    resolveGitReviewStatePaths(config, options).approvalDatabasePath,
    config.approvalDatabasePath,
  );
}

test("linked worktrees protect their actual Git directory and common directory", (context) => {
  const f = fixture(context);
  const roots = gitReviewProtectedRoots(f.linked);
  assert.ok(roots.includes(realpathSync(f.linked)));
  assert.ok(roots.includes(f.gitdir));
  assert.ok(roots.includes(f.common));
  rejectsMetadataState(f, f.linked);
  assert.equal(git(f.linked, "status", "--porcelain"), "");
});

test(
  "a valid symlinked .git pointer still protects Git and common directories",
  {
    skip: process.platform === "win32",
  },
  (context) => {
    const f = fixture(context);
    const pointer = join(f.state, "git-pointer");
    renameSync(join(f.linked, ".git"), pointer);
    symlinkSync(pointer, join(f.linked, ".git"));
    assert.equal(
      realpathSync(resolve(f.linked, git(f.linked, "rev-parse", "--git-dir"))),
      f.gitdir,
    );
    assert.equal(
      realpathSync(
        resolve(f.linked, git(f.linked, "rev-parse", "--git-common-dir")),
      ),
      f.common,
    );
    const roots = gitReviewProtectedRoots(f.linked);
    assert.ok(roots.includes(f.gitdir));
    assert.ok(roots.includes(f.common));
    rejectsMetadataState(f, f.linked);
    assert.equal(git(f.linked, "status", "--porcelain"), "");
  },
);

test(
  "a symlinked .git directory remains a protected physical root",
  {
    skip: process.platform === "win32",
  },
  (context) => {
    const f = fixture(context);
    const actual = join(f.state, "main-git");
    renameSync(join(f.main, ".git"), actual);
    symlinkSync(actual, join(f.main, ".git"), "dir");
    assert.equal(git(f.main, "rev-parse", "--is-inside-work-tree"), "true");
    assert.ok(gitReviewProtectedRoots(f.main).includes(realpathSync(actual)));
    assert.throws(
      () =>
        resolveGitReviewStatePaths(
          {
            ...f.config(f.main),
            approvalDatabasePath: join(actual, "approval.sqlite"),
          },
          { requirePlanDatabase: false },
        ),
      /outside the protected repository/u,
    );
  },
);

test("a separate Git directory without commondir is accepted but malformed commondir is not", (context) => {
  const f = fixture(context);
  const separate = join(f.scratch, "separate");
  const metadata = join(f.state, "separate-git");
  mkdirSync(separate);
  git(separate, "init", "-q", "--separate-git-dir", metadata);
  assert.ok(gitReviewProtectedRoots(separate).includes(realpathSync(metadata)));
  const commonPath = join(f.gitdir, "commondir");
  const original = readFileSync(commonPath);
  try {
    writeFileSync(commonPath, "unrecognized\nextra line\n");
    assert.throws(() => gitReviewProtectedRoots(f.linked), /commondir/u);
  } finally {
    writeFileSync(commonPath, original);
  }
});
