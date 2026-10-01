import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

function fixture(context: TestContext, temporaryParent = tmpdir()) {
  const scratch = realpathSync.native(
    mkdtempSync(join(temporaryParent, "reprogate-review-paths-")),
  );
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
  const gitdir = realpathSync.native(
    resolve(linked, git(linked, "rev-parse", "--git-dir")),
  );
  const common = realpathSync.native(
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
  const paths = resolveGitReviewStatePaths(config, options);
  // The database need not exist; canonicalize its existing parent instead.
  const physicalStatePath = (path: string) =>
    join(realpathSync.native(dirname(path)), basename(path));
  assert.equal(
    paths.planDatabasePath,
    physicalStatePath(config.planDatabasePath),
  );
  assert.equal(
    paths.approvalDatabasePath,
    physicalStatePath(config.approvalDatabasePath),
  );
  for (const directory of [f.gitdir, f.common, f.state]) {
    for (const name of [
      "approval.sqlite",
      "approvals.sqlite",
      "plans.sqlite",
    ]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        assert.equal(existsSync(join(directory, name + suffix)), false);
      }
    }
  }
}

test("an aliased temporary parent resolves state paths to native physical paths", (context) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "reprogate-review-alias-"));
  const physicalParent = join(temporaryRoot, "physical");
  const alias = join(temporaryRoot, "alias");
  mkdirSync(physicalParent);
  symlinkSync(
    physicalParent,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const f = fixture(context, alias);
  context.after(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });
  assert.equal(f.scratch, realpathSync.native(f.scratch));
  const linked = join(alias, basename(f.scratch), "linked");
  const state = join(alias, basename(f.scratch), "state");
  const aliasedFixture = {
    ...f,
    linked,
    state,
    config: (repositoryPath: string): GitReviewConfigV1 => ({
      ...f.config(repositoryPath),
      planDatabasePath: join(state, "plans.sqlite"),
      approvalDatabasePath: join(state, "approvals.sqlite"),
    }),
  };
  const before = protectedState(aliasedFixture);
  rejectsMetadataState(aliasedFixture, linked);
  const config = aliasedFixture.config(linked);
  const paths = resolveGitReviewStatePaths(config, {
    requirePlanDatabase: false,
  });
  assert.notEqual(paths.planDatabasePath, config.planDatabasePath);
  assert.notEqual(paths.approvalDatabasePath, config.approvalDatabasePath);
  const roots = gitReviewProtectedRoots(linked);
  for (const root of [linked, f.gitdir, f.common]) {
    assert.ok(roots.includes(realpathSync.native(root)));
  }
  assert.deepEqual(protectedState(aliasedFixture), before);
});

function protectedState(f: ReturnType<typeof fixture>) {
  return {
    head: git(f.linked, "rev-parse", "HEAD"),
    worktree: readFileSync(join(f.linked, "value.txt")),
    metadata: [f.gitdir, f.common].map((directory) =>
      readdirSync(directory, { recursive: true, withFileTypes: true })
        .map((entry) => ({
          entry,
          name: relative(directory, join(entry.parentPath, entry.name)),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ entry, name }) => {
          // Windows cannot open directories for reading. Keep their names in
          // the snapshot, then inspect/read files through one descriptor.
          if (entry.isDirectory()) return [name, null];
          const descriptor = openSync(join(directory, name), "r");
          try {
            return [
              name,
              fstatSync(descriptor).isFile() ? readFileSync(descriptor) : null,
            ];
          } finally {
            closeSync(descriptor);
          }
        }),
    ),
  };
}

test("protected metadata snapshots retain directory names and exact nested file bytes", (context) => {
  const f = fixture(context);
  const directoryName = "snapshot-directory";
  const fileName = join(directoryName, "snapshot.bin");
  const directory = join(f.gitdir, directoryName);
  const file = join(f.gitdir, fileName);
  const contents = Buffer.from([0, 10, 13, 128, 255]);
  mkdirSync(directory);
  writeFileSync(file, contents);
  const before = protectedState(f);
  const entries = before.metadata[0];
  assert.ok(entries);
  assert.deepEqual(
    entries.find(([name]) => name === directoryName),
    [directoryName, null],
  );
  assert.deepEqual(
    entries.find(([name]) => name === fileName),
    [fileName, contents],
  );
  writeFileSync(file, Buffer.from([255, 128, 13, 10, 0]));
  assert.notDeepEqual(protectedState(f).metadata, before.metadata);
  renameSync(file, join(directory, "renamed.bin"));
  const after = protectedState(f).metadata[0];
  assert.ok(after);
  assert.equal(
    after.some(([name]) => name === fileName),
    false,
  );
  assert.deepEqual(
    after.find(([name]) => name === join(directoryName, "renamed.bin")),
    [join(directoryName, "renamed.bin"), Buffer.from([255, 128, 13, 10, 0])],
  );
});

for (const form of ["directory", "directory symlink"] as const) {
  test(
    `a linked worktree with a .git ${form} protects its common directory`,
    { skip: form === "directory symlink" && process.platform === "win32" },
    (context) => {
      let f = fixture(context);
      const head = git(f.linked, "rev-parse", "HEAD");
      const dotGit = join(f.linked, ".git");
      rmSync(dotGit);
      if (form === "directory symlink") {
        symlinkSync(f.gitdir, dotGit, "dir");
      } else {
        renameSync(f.gitdir, dotGit);
        // Keep the common target valid after moving the linked gitdir.
        writeFileSync(join(dotGit, "commondir"), `${f.common}\n`);
        f = { ...f, gitdir: realpathSync.native(dotGit) };
      }
      assert.equal(git(f.linked, "rev-parse", "--is-inside-work-tree"), "true");
      assert.equal(
        realpathSync.native(
          resolve(f.linked, git(f.linked, "rev-parse", "--git-dir")),
        ),
        f.gitdir,
      );
      assert.equal(
        realpathSync.native(
          resolve(f.linked, git(f.linked, "rev-parse", "--git-common-dir")),
        ),
        f.common,
      );
      assert.equal(git(f.linked, "rev-parse", "HEAD"), head);
      assert.equal(git(f.linked, "status", "--porcelain"), "");
      const before = protectedState(f);
      const roots = gitReviewProtectedRoots(f.linked);
      assert.ok(roots.includes(realpathSync.native(f.linked)));
      assert.ok(roots.includes(f.gitdir));
      assert.ok(
        roots.includes(f.common),
        "common Git directory must be protected",
      );
      rejectsMetadataState(f, f.linked);
      assert.deepEqual(protectedState(f), before);
      assert.equal(git(f.linked, "status", "--porcelain"), "");
    },
  );
}

test("directory-form .git rejects malformed and unreadable existing commondir pointers", (context) => {
  const f = fixture(context);
  const commonPath = join(f.main, ".git", "commondir");
  assert.ok(
    gitReviewProtectedRoots(f.main).includes(
      realpathSync.native(join(f.main, ".git")),
    ),
  );
  for (const contents of ["", "unrecognized\nextra line\n", "x".repeat(4097)]) {
    writeFileSync(commonPath, contents);
    assert.throws(() => gitReviewProtectedRoots(f.main), /commondir/u);
    assert.throws(
      () =>
        resolveGitReviewStatePaths(f.config(f.main), {
          requirePlanDatabase: false,
        }),
      /commondir/u,
    );
  }
  rmSync(commonPath);
  mkdirSync(commonPath);
  assert.throws(() => gitReviewProtectedRoots(f.main), /commondir/u);
  rmSync(commonPath, { recursive: true });
  if (process.platform !== "win32") {
    symlinkSync(join(f.state, "missing-common-pointer"), commonPath);
    assert.throws(() => gitReviewProtectedRoots(f.main), /commondir/u);
    rmSync(commonPath);
  }
  assert.ok(
    gitReviewProtectedRoots(f.main).includes(
      realpathSync.native(join(f.main, ".git")),
    ),
  );
});

test("linked worktrees protect their actual Git directory and common directory", (context) => {
  const f = fixture(context);
  const roots = gitReviewProtectedRoots(f.linked);
  assert.ok(roots.includes(realpathSync.native(f.linked)));
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
      realpathSync.native(
        resolve(f.linked, git(f.linked, "rev-parse", "--git-dir")),
      ),
      f.gitdir,
    );
    assert.equal(
      realpathSync.native(
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
    assert.ok(
      gitReviewProtectedRoots(f.main).includes(realpathSync.native(actual)),
    );
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
  assert.ok(
    gitReviewProtectedRoots(separate).includes(realpathSync.native(metadata)),
  );
  const commonPath = join(f.gitdir, "commondir");
  const original = readFileSync(commonPath);
  try {
    writeFileSync(commonPath, "unrecognized\nextra line\n");
    assert.throws(() => gitReviewProtectedRoots(f.linked), /commondir/u);
  } finally {
    writeFileSync(commonPath, original);
  }
});
