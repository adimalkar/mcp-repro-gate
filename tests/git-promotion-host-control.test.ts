import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
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
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Dynamic import deliberately allows a real-fixture RED run before production exists.
async function controlModule(): Promise<
  typeof import("../src/git-promotion-host-control.js")
> {
  return import("../src/" + "git-promotion-host-control.js") as Promise<
    typeof import("../src/git-promotion-host-control.js")
  >;
}
function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function fixture(t: TestContext) {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate fence é ")),
  );
  const root = join(scratch, "source ü repo");
  const host = join(scratch, "private host");
  mkdirSync(root);
  mkdirSync(host, { mode: 0o700 });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fence Test");
  git(root, "config", "user.email", "fence@example.invalid");
  writeFileSync(join(root, "value.txt"), "before\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const config = {
    repositoryPath: root,
    approvalDatabasePath: join(host, "approval.sqlite"),
    fencePath: join(host, "ownership"),
    statePaths: [] as string[],
  };
  const workers: ChildProcess[] = [];
  // One FIFO after-hook: reap children before deleting their files (also on Windows).
  t.after(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) {
        const done = new Promise<void>((resolve) =>
          worker.once("exit", () => {
            resolve();
          }),
        );
        worker.kill("SIGKILL");
        await done;
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  return { scratch, root, host, config, workers };
}
function snapshot(root: string, host: string) {
  return {
    head: git(root, "symbolic-ref", "HEAD"),
    refs: git(
      root,
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
    ),
    index: readFileSync(join(root, ".git", "index")),
    file: readFileSync(join(root, "value.txt")),
    metadata: readdirSync(join(root, ".git"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => [
        join(entry.parentPath, entry.name),
        snapshotFile(join(entry.parentPath, entry.name)),
      ]),
    ledger: existsSync(join(host, "approval.sqlite"))
      ? readFileSync(join(host, "approval.sqlite"))
      : null,
  };
}
function snapshotFile(path: string): Buffer {
  const flags = constants as Partial<Record<string, number>>;
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0),
  );
  try {
    assert.ok(fstatSync(descriptor).isFile());
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function worker(f: ReturnType<typeof fixture>, mode = "acquire") {
  const child = fork(
    fileURLToPath(
      new URL(
        "./fixtures/git-promotion-host-control-worker.js",
        import.meta.url,
      ),
    ),
    [JSON.stringify(f.config), mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  f.workers.push(child);
  return {
    child,
    message: new Promise<{
      status: string;
      owner: import("../src/git-promotion-host-control.js").GitPromotionFenceOwnerV1;
    }>((resolve, reject) => {
      child.once("message", (message) => {
        resolve(
          message as {
            status: string;
            owner: import("../src/git-promotion-host-control.js").GitPromotionFenceOwnerV1;
          },
        );
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `Worker exited before message: ${String(code)}/${String(signal)}`,
          ),
        );
      });
    }),
  };
}

test("exclusive instances release only exact immutable bound owner after explicit quiescence; no Git/SQLite mutation", async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.config.approvalDatabasePath);
  try {
    db.exec(
      "CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES ('ledger unchanged')",
    );
  } finally {
    db.close();
  }
  // SQLite's default creation mode is not the private host-control contract.
  chmodSync(f.config.approvalDatabasePath, 0o600);
  const before = snapshot(f.root, f.host);
  const { createGitPromotionHostControl } = await controlModule();
  const first = createGitPromotionHostControl(f.config);
  const second = createGitPromotionHostControl(f.config);
  assert.deepEqual(first.query(), { status: "available" });
  const attemptId = randomUUID();
  const owner = first.acquire(attemptId);
  assert.equal(owner.attemptId, attemptId);
  assert.ok(Object.isFrozen(owner));
  assert.deepEqual(second.query(), { status: "held", owner });
  assert.throws(() => second.acquire(randomUUID()), /held/u);
  for (const field of [
    "token",
    "attemptId",
    "commonDirectory",
    "approvalDatabasePath",
    "fencePath",
  ])
    assert.throws(() => {
      second.release(
        {
          ...owner,
          [field]:
            field.endsWith("Id") || field === "token"
              ? randomUUID()
              : join(f.host, "wrong"),
        },
        { childrenQuiescent: true },
      );
    });
  assert.throws(() => {
    first.release(owner, { childrenQuiescent: false } as never);
  });
  assert.throws(() => {
    first.release(owner, {} as never);
  });
  assert.equal(first.query().status, "held");
  second.release(owner, { childrenQuiescent: true });
  const next = first.acquire(randomUUID());
  assert.notEqual(next.token, owner.token);
  first.release(next, { childrenQuiescent: true });
  assert.deepEqual(snapshot(f.root, f.host), before);
});

test("two compiled workers compete, SIGKILL leaves persistent ownership; fresh process never steals", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root, f.host);
  const { createGitPromotionHostControl } = await controlModule();
  const a = worker(f);
  const b = worker(f);
  const results = await Promise.all([a.message, b.message]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["acquired", "held"]);
  const winningIndex = results.findIndex((r) => r.status === "acquired");
  const winner = [a, b][winningIndex];
  const result = results[winningIndex];
  assert.ok(winner);
  assert.ok(result);
  const owner = result.owner;
  assert.equal(winner.child.exitCode, null);
  assert.equal(winner.child.signalCode, null);
  const exited = new Promise<void>((resolve) =>
    winner.child.once("exit", () => {
      resolve();
    }),
  );
  assert.equal(winner.child.kill("SIGKILL"), true);
  await exited;
  // No PID is persisted or treated as authority. Even an ancient canonical time cannot expire a latch.
  writeFileSync(
    join(f.config.fencePath, "owner.json"),
    JSON.stringify({ ...owner, createdAt: "2000-01-01T00:00:00.000Z" }),
    { mode: 0o600 },
  );
  const oldOwner = { ...owner, createdAt: "2000-01-01T00:00:00.000Z" };
  const fresh = worker(f);
  assert.equal((await fresh.message).status, "held");
  const controller = createGitPromotionHostControl(f.config);
  assert.throws(() => {
    controller.release(owner, { childrenQuiescent: true });
  });
  controller.release(oldOwner, { childrenQuiescent: true });
  const next = controller.acquire(randomUUID());
  controller.release(next, { childrenQuiescent: true });
  assert.deepEqual(snapshot(f.root, f.host), before);
});

test("strict record parser rejects unknown, accessor, symbol, inherited, oversized and aliased shapes without getter evaluation", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl, parseGitPromotionFenceOwner } =
    await controlModule();
  const c = createGitPromotionHostControl(f.config);
  const owner = c.acquire(randomUUID());
  const copy = parseGitPromotionFenceOwner(owner);
  assert.notEqual(copy, owner);
  assert.ok(Object.isFrozen(copy));
  let reads = 0;
  const getter = { ...owner };
  Object.defineProperty(getter, "token", {
    enumerable: true,
    get() {
      reads++;
      return owner.token;
    },
  });
  for (const invalid of [
    getter,
    { ...owner, extra: true },
    { ...owner, [Symbol("x")]: 1 },
    Object.create(owner),
    { ...owner, token: owner.token + "\n" },
    { ...owner, commonDirectory: "x".repeat(4097) },
    { ...owner, token: { value: owner.token } },
    { ...owner, createdAt: "2020-02-31T00:00:00.000Z" },
  ]) {
    assert.throws(() => parseGitPromotionFenceOwner(invalid));
    assert.throws(() => {
      c.release(invalid, { childrenQuiescent: true });
    });
  }
  assert.equal(reads, 0);
  c.release(owner, { childrenQuiescent: true });
});

test("empty, partial, noncanonical, oversized and extra-entry latches stay held-invalid without repair", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const c = createGitPromotionHostControl(f.config);
  const owner = c.acquire(randomUUID());
  c.release(owner, { childrenQuiescent: true });
  for (const bytes of [
    null,
    "{",
    JSON.stringify({ ...owner, unknown: 1 }),
    JSON.stringify(owner) + "\n",
    "x".repeat(32769),
    JSON.stringify(owner).replace(
      '"ownerVersion":1',
      '"ownerVersion":1,"ownerVersion":1',
    ),
  ]) {
    mkdirSync(f.config.fencePath, { mode: 0o700 });
    if (bytes !== null)
      writeFileSync(join(f.config.fencePath, "owner.json"), bytes, {
        mode: 0o600,
      });
    assert.deepEqual(c.query(), { status: "held-invalid" });
    assert.throws(() => c.acquire(randomUUID()), /held/u);
    assert.throws(() => {
      c.release(owner, { childrenQuiescent: true });
    });
    assert.ok(existsSync(f.config.fencePath));
    rmSync(f.config.fencePath, { recursive: true });
  }
  mkdirSync(f.config.fencePath, { mode: 0o700 });
  writeFileSync(join(f.config.fencePath, "owner.json"), JSON.stringify(owner), {
    mode: 0o600,
  });
  writeFileSync(join(f.config.fencePath, "unexpected"), "");
  assert.equal(c.query().status, "held-invalid");
  assert.throws(() => {
    c.release(owner, { childrenQuiescent: true });
  });
});

test("canonical physical aliases share fence; protected roots and ledger/state locations reject overlap", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const alias = join(f.scratch, "host alias");
  symlinkSync(f.host, alias, process.platform === "win32" ? "junction" : "dir");
  const c = createGitPromotionHostControl({
    ...f.config,
    fencePath: join(alias, "ownership"),
    approvalDatabasePath: join(alias, "approval.sqlite"),
  });
  const owner = c.acquire(randomUUID());
  assert.equal(owner.fencePath, f.config.fencePath);
  assert.throws(
    () => createGitPromotionHostControl(f.config).acquire(randomUUID()),
    /held/u,
  );
  c.release(owner, { childrenQuiescent: true });
  const linked = join(f.scratch, "linked 中文");
  git(f.root, "worktree", "add", "-qb", "linked", linked);
  const gitdir = realpathSync.native(
    resolve(
      linked,
      git(linked, "rev-parse", "--git-dir").toString("utf8").trim(),
    ),
  );
  for (const path of [
    f.root,
    join(f.root, "latch"),
    join(f.root, ".git", "latch"),
    join(linked, "latch"),
    join(gitdir, "latch"),
    f.config.approvalDatabasePath,
    f.config.approvalDatabasePath + "-wal",
    f.scratch,
  ]) {
    assert.throws(() =>
      createGitPromotionHostControl({ ...f.config, fencePath: path }),
    );
  }
  const otherState = join(f.scratch, "state");
  mkdirSync(otherState, { mode: 0o700 });
  assert.throws(() =>
    createGitPromotionHostControl({
      ...f.config,
      statePaths: [otherState],
      fencePath: join(otherState, "latch"),
    }),
  );
  assert.throws(() =>
    createGitPromotionHostControl({ ...f.config, fencePath: "relative" }),
  );
  assert.throws(() =>
    createGitPromotionHostControl({
      ...f.config,
      approvalDatabasePath: "relative",
    }),
  );
  assert.throws(() =>
    createGitPromotionHostControl({
      ...f.config,
      repositoryPath: join(f.root, ".git"),
    }),
  );
});

for (const layout of [
  "file",
  "symlink-file",
  "symlink-directory",
  "directory-commondir",
] as const) {
  test(`Git metadata layout ${layout} resolves common-directory without cleanliness/ref gates`, async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const linked = join(f.scratch, "linked é");
    git(f.root, "worktree", "add", "-qb", "linked", linked);
    const gitdir = realpathSync.native(
      resolve(
        linked,
        git(linked, "rev-parse", "--git-dir").toString("utf8").trim(),
      ),
    );
    if (layout === "symlink-file") {
      const container = join(f.host, "metadata container");
      mkdirSync(container, { mode: 0o700 });
      renameSync(join(linked, ".git"), join(container, "pointer"));
      symlinkSync(join(container, "pointer"), join(linked, ".git"), "file");
      assert.throws(
        () =>
          createGitPromotionHostControl({
            ...f.config,
            repositoryPath: linked,
            fencePath: container,
          }),
        /overlap/u,
      );
    }
    if (layout === "symlink-directory") {
      rmSync(join(linked, ".git"));
      symlinkSync(
        gitdir,
        join(linked, ".git"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (layout === "directory-commondir") {
      rmSync(join(linked, ".git"));
      renameSync(gitdir, join(linked, ".git"));
      writeFileSync(
        join(linked, ".git", "commondir"),
        join(f.root, ".git") + "\n",
      );
      writeFileSync(
        join(linked, ".git", "gitdir"),
        join(linked, ".git") + "\n",
      );
    }
    writeFileSync(join(linked, "value.txt"), "dirty\n");
    git(linked, "checkout", "--detach", "-q");
    const c = createGitPromotionHostControl({
      ...f.config,
      repositoryPath: linked,
    });
    const owner = c.acquire(randomUUID());
    assert.equal(
      owner.commonDirectory,
      realpathSync.native(join(f.root, ".git")),
    );
    c.release(owner, { childrenQuiescent: true });
    assert.throws(() =>
      createGitPromotionHostControl({
        ...f.config,
        repositoryPath: linked,
        fencePath: join(f.root, ".git", "latch"),
      }),
    );
  });
}

test("unsafe ledger/owner/fence symlinks, hardlinks and nonregular files fail closed", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const target = join(f.host, "target");
  writeFileSync(target, "unchanged", { mode: 0o600 });
  symlinkSync(target, f.config.approvalDatabasePath, "file");
  assert.throws(() => createGitPromotionHostControl(f.config));
  rmSync(f.config.approvalDatabasePath);
  linkSync(target, f.config.approvalDatabasePath);
  assert.throws(() => createGitPromotionHostControl(f.config));
  rmSync(f.config.approvalDatabasePath);
  const c = createGitPromotionHostControl(f.config);
  const owner = c.acquire(randomUUID());
  const ownerPath = join(f.config.fencePath, "owner.json");
  linkSync(ownerPath, join(f.host, "owner alias"));
  assert.equal(c.query().status, "held-invalid");
  assert.throws(() => {
    c.release(owner, { childrenQuiescent: true });
  });
  rmSync(join(f.host, "owner alias"));
  rmSync(ownerPath);
  symlinkSync(target, ownerPath, "file");
  assert.equal(c.query().status, "held-invalid");
  assert.throws(() => {
    c.release(owner, { childrenQuiescent: true });
  });
  rmSync(f.config.fencePath, { recursive: true });
  symlinkSync(
    f.host,
    f.config.fencePath,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => createGitPromotionHostControl(f.config));
  assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test(
  "POSIX private ownership/permissions and FIFOs are enforced (Windows ACLs are a host deployment responsibility)",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    chmodSync(f.host, 0o755);
    assert.throws(() => createGitPromotionHostControl(f.config));
    chmodSync(f.host, 0o700);
    const c = createGitPromotionHostControl(f.config);
    const owner = c.acquire(randomUUID());
    const path = join(f.config.fencePath, "owner.json");
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(lstatSync(f.config.fencePath).mode & 0o777, 0o700);
    chmodSync(path, 0o644);
    assert.equal(c.query().status, "held-invalid");
    chmodSync(path, 0o000);
    assert.equal(c.query().status, "held-invalid");
    chmodSync(path, 0o600);
    chmodSync(f.config.fencePath, 0o755);
    assert.equal(c.query().status, "held-invalid");
    chmodSync(f.config.fencePath, 0o700);
    rmSync(path);
    execFileSync("mkfifo", [path]);
    assert.equal(c.query().status, "held-invalid");
    assert.throws(() => {
      c.release(owner, { childrenQuiescent: true });
    });
    rmSync(path);
    execFileSync("mkfifo", [f.config.approvalDatabasePath]);
    assert.throws(() => createGitPromotionHostControl(f.config));
  },
);

test("captured host inputs are detached and release refuses mismatched repository/ledger records; descriptors close", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const input = { ...f.config, statePaths: [] as string[] };
  const c = createGitPromotionHostControl(input);
  input.fencePath = join(f.host, "replacement");
  input.statePaths.push(f.host);
  const owner = c.acquire(randomUUID());
  assert.equal(owner.fencePath, f.config.fencePath);
  const path = join(f.config.fencePath, "owner.json");
  for (const field of [
    "commonDirectory",
    "approvalDatabasePath",
    "fencePath",
  ]) {
    const forged = { ...owner, [field]: join(f.host, "wrong") };
    writeFileSync(path, JSON.stringify(forged));
    assert.equal(c.query().status, "held-invalid");
    assert.throws(() => {
      c.release(forged, { childrenQuiescent: true });
    });
  }
  writeFileSync(path, JSON.stringify(owner));
  c.release(owner, { childrenQuiescent: true });
  const fdCount = () =>
    process.platform === "linux" ? readdirSync("/proc/self/fd").length : null;
  const before = fdCount();
  for (let i = 0; i < 30; i++) {
    const o = c.acquire(randomUUID());
    c.query();
    c.release(o, { childrenQuiescent: true });
  }
  const malformedOwner = c.acquire(randomUUID());
  writeFileSync(path, "{");
  for (let i = 0; i < 30; i++) {
    assert.equal(c.query().status, "held-invalid");
    assert.throws(() => {
      c.release(malformedOwner, { childrenQuiescent: true });
    });
  }
  writeFileSync(path, JSON.stringify(malformedOwner));
  c.release(malformedOwner, { childrenQuiescent: true });
  assert.equal(fdCount(), before);
  assert.equal(existsSync(input.fencePath), false);
  assert.equal(dirname(owner.fencePath), f.host);
});

test(
  "post-mkdir acquisition failure retains an empty latch; unsafe ancestor permissions fail closed",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const c = createGitPromotionHostControl(f.config);
    assert.throws(() => c.acquire(randomUUID() + "\n"));
    assert.equal(existsSync(f.config.fencePath), false);
    // Deterministically inject a REAL filesystem permissions failure immediately
    // after the real atomic mkdir, without changing Git runner scratch permissions.
    const original = fs.mkdirSync;
    const intercepted = t.mock.method(
      fs,
      "mkdirSync",
      (
        path: Parameters<typeof mkdirSync>[0],
        options: Parameters<typeof mkdirSync>[1],
      ) => {
        const result = original(path, options);
        if (path === f.config.fencePath) chmodSync(f.config.fencePath, 0o000);
        return result;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(() => c.acquire(randomUUID()), /uncertain.*retained/u);
    } finally {
      intercepted.mock.restore();
      syncBuiltinESMExports();
      chmodSync(f.config.fencePath, 0o700);
    }
    assert.deepEqual(c.query(), { status: "held-invalid" });
    assert.throws(() => c.acquire(randomUUID()), /held/u);
    assert.deepEqual(readdirSync(f.config.fencePath), []);
    chmodSync(f.scratch, 0o777);
    try {
      assert.throws(() => c.query(), /ancestor/u);
    } finally {
      chmodSync(f.scratch, 0o700);
    }
  },
);

test(
  "foreign POSIX owner is refused when changing ownership is permitted",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const c = createGitPromotionHostControl(f.config);
    const owner = c.acquire(randomUUID());
    const path = join(f.config.fencePath, "owner.json");
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    assert.notEqual(uid, undefined);
    assert.notEqual(gid, undefined);
    if (uid === undefined || gid === undefined)
      throw new Error("Missing POSIX uid/gid");
    try {
      chownSync(path, uid === 0 ? 1 : 0, gid);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        t.skip(
          "Actual chown probe returned EPERM: no privilege to create a foreign-owner fixture",
        );
        c.release(owner, { childrenQuiescent: true });
        return;
      }
      throw error;
    }
    try {
      assert.deepEqual(c.query(), { status: "held-invalid" });
      assert.throws(() => {
        c.release(owner, { childrenQuiescent: true });
      });
    } finally {
      chownSync(path, uid, gid);
    }
    c.release(owner, { childrenQuiescent: true });
  },
);

test(
  "invalid UTF-8 registered worktree paths fail closed instead of replacement decoding",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const linked = join(f.scratch, "linked");
    git(f.root, "worktree", "add", "-qb", "linked", linked);
    const gitdir = realpathSync.native(
      resolve(
        linked,
        git(linked, "rev-parse", "--git-dir").toString("utf8").trim(),
      ),
    );
    const rawPath = Buffer.concat([
      Buffer.from(join(f.scratch, "invalid ")),
      Buffer.from([0xff]),
    ]);
    renameSync(linked, rawPath);
    writeFileSync(
      join(gitdir, "gitdir"),
      Buffer.concat([rawPath, Buffer.from("/.git\n")]),
    );
    assert.ok(
      git(f.root, "worktree", "list", "--porcelain", "-z").includes(rawPath),
    );
    assert.throws(() => createGitPromotionHostControl(f.config));
    assert.equal(existsSync(f.config.fencePath), false);
  },
);

test("fence configuration observes new linked roots and rejects malformed/unreadable commondir without mutation", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const c = createGitPromotionHostControl(f.config);
  // A newly registered worktree cannot engulf a previously configured latch.
  git(f.root, "worktree", "add", "-qb", "late", f.host);
  assert.throws(() => c.acquire(randomUUID()), /overlap/u);
  assert.equal(existsSync(f.config.fencePath), false);
  const gitdir = realpathSync.native(
    resolve(
      f.host,
      git(f.host, "rev-parse", "--git-dir").toString("utf8").trim(),
    ),
  );
  const commonPointer = join(gitdir, "commondir");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(commonPointer, 0o000);
    try {
      assert.throws(() =>
        createGitPromotionHostControl({ ...f.config, repositoryPath: f.host }),
      );
    } finally {
      chmodSync(commonPointer, 0o644);
    }
  }
  writeFileSync(commonPointer, "missing common directory\n");
  assert.throws(() =>
    createGitPromotionHostControl({ ...f.config, repositoryPath: f.host }),
  );
});

test("host config accessors, sparse state paths, unsafe ledger sidecars, and retargeted parents reject", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  let reads = 0;
  const getter = { ...f.config };
  Object.defineProperty(getter, "fencePath", {
    enumerable: true,
    get() {
      reads++;
      return f.config.fencePath;
    },
  });
  assert.throws(() => createGitPromotionHostControl(getter));
  assert.equal(reads, 0);
  const hidden = { ...f.config };
  Object.defineProperty(hidden, "statePaths", { value: [], enumerable: false });
  for (const invalid of [
    { ...f.config, extra: true },
    { ...f.config, [Symbol("extra")]: true },
    Object.create(f.config) as object,
    hidden,
  ])
    assert.throws(() => createGitPromotionHostControl(invalid as never));
  assert.deepEqual(
    createGitPromotionHostControl(
      Object.assign(Object.create(null) as object, f.config),
    ).query(),
    { status: "available" },
  );
  assert.throws(() =>
    createGitPromotionHostControl({
      ...f.config,
      statePaths: new Array<string>(1),
    }),
  );
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    symlinkSync(
      join(f.root, "value.txt"),
      f.config.approvalDatabasePath + suffix,
      "file",
    );
    assert.throws(() => createGitPromotionHostControl(f.config));
    rmSync(f.config.approvalDatabasePath + suffix);
  }
  const c = createGitPromotionHostControl(f.config);
  const moved = join(f.scratch, "original parent");
  renameSync(f.host, moved);
  mkdirSync(f.host, { mode: 0o700 });
  assert.throws(() => c.query(), /identity changed/u);
  assert.throws(() => c.acquire(randomUUID()));
});

// Task3A specification regressions: exercise real modes, inode replacement and aliases.
for (const target of [
  "ledger-parent",
  "state-parent",
  "state-directory",
  "ledger-file",
  "state-file",
  "ledger-sidecar",
  "file-sidecar",
  "directory-sidecar",
] as const) {
  for (const timing of ["construction", "held"] as const) {
    test(
      `private host locations reject ${target} permission drift at ${timing}`,
      { skip: process.platform === "win32" },
      async (t) => {
        const f = fixture(t);
        const { createGitPromotionHostControl } = await controlModule();
        const ledgerParent = join(f.scratch, "ledger parent");
        const stateParent = join(f.scratch, "state parent");
        mkdirSync(ledgerParent, { mode: 0o700 });
        mkdirSync(stateParent, { mode: 0o700 });
        const stateFile = join(stateParent, "config.json");
        const stateDirectory = join(stateParent, "state directory");
        const ledgerFile = join(ledgerParent, "approval.sqlite");
        mkdirSync(stateDirectory, { mode: 0o700 });
        for (const path of [
          ledgerFile,
          stateFile,
          ledgerFile + "-wal",
          stateFile + "-shm",
          stateDirectory + "-journal",
        ])
          writeFileSync(path, "private state", { mode: 0o600 });
        const config = {
          ...f.config,
          approvalDatabasePath: ledgerFile,
          statePaths: [stateFile, stateDirectory],
        };
        const unsafe = {
          "ledger-parent": ledgerParent,
          "state-parent": stateParent,
          "state-directory": stateDirectory,
          "ledger-file": ledgerFile,
          "state-file": stateFile,
          "ledger-sidecar": ledgerFile + "-wal",
          "file-sidecar": stateFile + "-shm",
          "directory-sidecar": stateDirectory + "-journal",
        }[target];
        const isDirectory = lstatSync(unsafe).isDirectory();
        const controller =
          timing === "held" ? createGitPromotionHostControl(config) : undefined;
        const owner = controller?.acquire(randomUUID());
        const latch = owner
          ? readFileSync(join(f.config.fencePath, "owner.json"))
          : undefined;
        chmodSync(unsafe, isDirectory ? 0o777 : 0o666);
        try {
          if (!controller || !owner) {
            assert.throws(
              () => createGitPromotionHostControl(config),
              /private|ancestor/u,
            );
            assert.equal(existsSync(f.config.fencePath), false);
          } else {
            assert.throws(() => controller.query(), /private|ancestor/u);
            assert.throws(
              () => controller.acquire(randomUUID()),
              /private|ancestor/u,
            );
            assert.throws(() => {
              controller.release(owner, { childrenQuiescent: true });
            }, /private|ancestor/u);
            assert.deepEqual(
              readFileSync(join(f.config.fencePath, "owner.json")),
              latch,
            );
          }
          assert.equal(
            lstatSync(unsafe).mode & 0o777,
            isDirectory ? 0o777 : 0o666,
          );
        } finally {
          chmodSync(unsafe, isDirectory ? 0o700 : 0o600);
        }
        if (controller && owner)
          controller.release(owner, { childrenQuiescent: true });
      },
    );
  }
}

for (const target of [
  "ledger-parent",
  "state-parent",
  "state-directory",
] as const) {
  for (const timing of ["available", "held"] as const) {
    test(`host directory identity pins reject ${target} replacement while ${timing}`, async (t) => {
      const f = fixture(t);
      const { createGitPromotionHostControl } = await controlModule();
      const ledgerParent = join(f.scratch, "ledger parent");
      const stateParent = join(f.scratch, "state parent");
      const stateDirectory = join(stateParent, "state directory");
      mkdirSync(ledgerParent, { mode: 0o700 });
      mkdirSync(stateParent, { mode: 0o700 });
      mkdirSync(stateDirectory, { mode: 0o700 });
      const controller = createGitPromotionHostControl({
        ...f.config,
        approvalDatabasePath: join(ledgerParent, "missing.sqlite"),
        statePaths: [join(stateParent, "missing.json"), stateDirectory],
      });
      const owner =
        timing === "held" ? controller.acquire(randomUUID()) : undefined;
      const latch = owner
        ? readFileSync(join(f.config.fencePath, "owner.json"))
        : undefined;
      const replaced = {
        "ledger-parent": ledgerParent,
        "state-parent": stateParent,
        "state-directory": stateDirectory,
      }[target];
      const identity = lstatSync(replaced, { bigint: true });
      renameSync(replaced, replaced + " old");
      mkdirSync(replaced, { mode: 0o700 });
      if (target === "state-parent") mkdirSync(stateDirectory, { mode: 0o700 });
      assert.notEqual(lstatSync(replaced, { bigint: true }).ino, identity.ino);
      assert.throws(() => controller.query(), /identity changed/u);
      assert.throws(
        () => controller.acquire(randomUUID()),
        /identity changed/u,
      );
      if (owner) {
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /identity changed/u);
        assert.deepEqual(
          readFileSync(join(f.config.fencePath, "owner.json")),
          latch,
        );
      } else assert.equal(existsSync(f.config.fencePath), false);
    });
  }
}

for (const shape of [
  "null",
  "undefined",
  "nonarray",
  "prototype",
  "symbol",
  "extra-accessor",
  "extra-data",
  "nonenumerable-extra",
  "sparse",
  "circular",
  "mixed",
  "index-getter",
  "nonenumerable-index",
  "oversized",
  "proxy-extra",
] as const) {
  test(`strict statePaths rejects ${shape} without evaluating getters`, async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    let reads = 0;
    const getter = () => {
      reads++;
      return join(f.host, "state");
    };
    const array: unknown[] = [];
    let statePaths: unknown = array;
    switch (shape) {
      case "null":
        statePaths = null;
        break;
      case "undefined":
        statePaths = undefined;
        break;
      case "nonarray":
        statePaths = { length: 0 };
        break;
      case "prototype":
        Object.setPrototypeOf(array, Object.create(Array.prototype) as object);
        break;
      case "symbol":
        Object.defineProperty(array, Symbol("extra"), { value: 1 });
        break;
      case "extra-accessor":
        Object.defineProperty(array, "extra", {
          enumerable: true,
          get: getter,
        });
        break;
      case "extra-data":
        Object.defineProperty(array, "extra", { enumerable: true, value: 1 });
        break;
      case "nonenumerable-extra":
        Object.defineProperty(array, "extra", { value: 1 });
        break;
      case "sparse":
        array.length = 1;
        break;
      case "circular":
        array.push(array);
        break;
      case "mixed":
        array.push(join(f.host, "state"), 42);
        break;
      case "index-getter":
        Object.defineProperty(array, "0", { enumerable: true, get: getter });
        break;
      case "nonenumerable-index":
        Object.defineProperty(array, "0", { value: join(f.host, "state") });
        break;
      case "oversized":
        array.length = 257;
        break;
      case "proxy-extra":
        statePaths = new Proxy(array, {
          ownKeys() {
            return ["length", "extra"];
          },
          getOwnPropertyDescriptor(target, key) {
            return key === "extra"
              ? { configurable: true, enumerable: true, get: getter }
              : Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        break;
    }
    assert.throws(() =>
      createGitPromotionHostControl({ ...f.config, statePaths } as never),
    );
    assert.equal(reads, 0);
    assert.equal(existsSync(f.config.fencePath), false);
  });
}

for (const suffix of ["-wal", "-shm", "-journal"]) {
  for (const alias of [
    "fence",
    "metadata",
    "state",
    "dangling",
    "hardlink",
    "directory",
    "fifo",
    "permissions",
  ] as const) {
    test(
      `state directory ${suffix} rejects ${alias} sidecar`,
      {
        skip:
          process.platform === "win32" &&
          (alias === "fifo" || alias === "permissions"),
      },
      async (t) => {
        const f = fixture(t);
        const { createGitPromotionHostControl } = await controlModule();
        const state = join(f.host, "state directory");
        const other = join(f.host, "other state");
        mkdirSync(state, { mode: 0o700 });
        writeFileSync(other, "unchanged", { mode: 0o600 });
        const config = { ...f.config, statePaths: [state, other] };
        // Valid directory bases must remain supported; an absent ledger is never created.
        const controller = createGitPromotionHostControl(config);
        const owner = controller.acquire(randomUUID());
        const latch = readFileSync(join(f.config.fencePath, "owner.json"));
        const path = state + suffix;
        switch (alias) {
          case "fence":
            symlinkSync(
              f.config.fencePath,
              path,
              process.platform === "win32" ? "junction" : "dir",
            );
            break;
          case "metadata":
            symlinkSync(
              join(f.root, ".git"),
              path,
              process.platform === "win32" ? "junction" : "dir",
            );
            break;
          case "state":
            symlinkSync(other, path, "file");
            break;
          case "dangling":
            symlinkSync(join(f.host, "absent"), path, "file");
            break;
          case "hardlink":
            linkSync(other, path);
            break;
          case "directory":
            mkdirSync(path, { mode: 0o700 });
            break;
          case "fifo":
            execFileSync("mkfifo", [path]);
            break;
          case "permissions":
            writeFileSync(path, "unsafe");
            chmodSync(path, 0o666);
            break;
        }
        assert.throws(() => createGitPromotionHostControl(config));
        assert.throws(() => controller.query());
        assert.throws(() => controller.acquire(randomUUID()));
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        });
        assert.deepEqual(
          readFileSync(join(f.config.fencePath, "owner.json")),
          latch,
        );
        assert.equal(existsSync(f.config.approvalDatabasePath), false);
        rmSync(path, { recursive: true });
        controller.release(owner, { childrenQuiescent: true });
        assert.equal(readFileSync(other, "utf8"), "unchanged");
      },
    );
  }
}

test("private state files, directories, sidecars and missing leaves stay valid; optional arrays detach once", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const stateFile = join(f.host, "config.json");
  const stateDirectory = join(f.host, "state directory");
  mkdirSync(stateDirectory, { mode: 0o700 });
  writeFileSync(stateFile, "private", { mode: 0o600 });
  for (const base of [f.config.approvalDatabasePath, stateFile, stateDirectory])
    for (const suffix of ["-wal", "-shm", "-journal"])
      writeFileSync(base + suffix, "private sidecar", { mode: 0o600 });
  const paths = [stateFile, stateDirectory, join(f.host, "missing")];
  const descriptorReads = new Map<string | symbol, number>();
  const proxy = new Proxy(paths, {
    get() {
      throw new Error("Array property getters must not run");
    },
    getOwnPropertyDescriptor(target, key) {
      descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const before = snapshot(f.root, f.host);
  const controller = createGitPromotionHostControl({
    ...f.config,
    statePaths: proxy,
  });
  for (const key of ["length", "0", "1", "2"])
    assert.equal(descriptorReads.get(key), 1);
  paths.splice(0, paths.length, f.host);
  const owner = controller.acquire(randomUUID());
  // Query/release do not impose source cleanliness or fixed HEAD/ref checks.
  writeFileSync(join(f.root, "value.txt"), "dirty after acquisition\n");
  git(f.root, "checkout", "--detach", "-q");
  assert.equal(controller.query().status, "held");
  controller.release(owner, { childrenQuiescent: true });
  assert.equal(controller.query().status, "available");
  assert.equal(existsSync(f.config.approvalDatabasePath), false);
  git(f.root, "checkout", "main", "-q");
  writeFileSync(join(f.root, "value.txt"), "before\n");
  // checkout can alter index/reflog timestamps, so compare mutation-free fence
  // operations separately from the deliberate source changes above.
  assert.deepEqual(snapshot(f.root, f.host).ledger, before.ledger);
  const unchanged = snapshot(f.root, f.host);
  for (const config of [
    { ...f.config, statePaths: [] },
    {
      repositoryPath: f.root,
      approvalDatabasePath: f.config.approvalDatabasePath,
      fencePath: f.config.fencePath,
    },
  ]) {
    const c = createGitPromotionHostControl(config);
    const o = c.acquire(randomUUID());
    c.release(o, { childrenQuiescent: true });
  }
  assert.deepEqual(snapshot(f.root, f.host), unchanged);
});

for (const target of ["ledger", "state"] as const) {
  test(
    `private ${target} parents cannot hide independently writable ancestors`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = fixture(t);
      const { createGitPromotionHostControl } = await controlModule();
      const ancestor = join(f.scratch, "separate ancestor");
      const parent = join(ancestor, "private parent");
      mkdirSync(ancestor, { mode: 0o700 });
      mkdirSync(parent, { mode: 0o700 });
      const path = join(parent, "missing state");
      const config =
        target === "ledger"
          ? { ...f.config, approvalDatabasePath: path }
          : { ...f.config, statePaths: [path] };
      const controller = createGitPromotionHostControl(config);
      const owner = controller.acquire(randomUUID());
      const latch = readFileSync(join(f.config.fencePath, "owner.json"));
      chmodSync(ancestor, 0o777);
      try {
        assert.equal(lstatSync(parent).mode & 0o777, 0o700);
        assert.throws(() => createGitPromotionHostControl(config), /ancestor/u);
        assert.throws(() => controller.query(), /ancestor/u);
        assert.throws(() => controller.acquire(randomUUID()), /ancestor/u);
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /ancestor/u);
        assert.deepEqual(
          readFileSync(join(f.config.fencePath, "owner.json")),
          latch,
        );
        assert.equal(lstatSync(ancestor).mode & 0o777, 0o777);
      } finally {
        chmodSync(ancestor, 0o700);
      }
      controller.release(owner, { childrenQuiescent: true });
      assert.equal(existsSync(path), false);
    },
  );
}

for (const operation of ["query", "acquire", "release"] as const) {
  test(`common lifetime binding rechecks real replacement during ${operation} and retains latch`, async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl(f.config);
    const owner =
      operation === "acquire" ? undefined : controller.acquire(randomUUID());
    const ownerPath = join(f.config.fencePath, "owner.json");
    const latch = owner ? snapshotFile(ownerPath) : undefined;
    let replaced = false;
    let opens = 0;
    const originalOpen = fs.openSync;
    const originalMkdir = fs.mkdirSync;
    const opening = t.mock.method(
      fs,
      "openSync",
      (
        path: Parameters<typeof openSync>[0],
        flags: Parameters<typeof openSync>[1],
        mode: Parameters<typeof openSync>[2],
      ) => {
        const fd = originalOpen(path, flags, mode);
        try {
          if (
            path === ownerPath &&
            operation !== "acquire" &&
            ++opens === (operation === "release" ? 2 : 1)
          ) {
            replaceCommon(join(f.root, ".git"));
            replaced = true;
          }
          return fd;
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      },
    );
    const creating = t.mock.method(
      fs,
      "mkdirSync",
      (
        path: Parameters<typeof mkdirSync>[0],
        options: Parameters<typeof mkdirSync>[1],
      ) => {
        const result = originalMkdir(path, options);
        if (path === f.config.fencePath && operation === "acquire") {
          replaceCommon(join(f.root, ".git"));
          replaced = true;
        }
        return result;
      },
    );
    syncBuiltinESMExports();
    try {
      if (operation === "acquire")
        assert.throws(
          () => controller.acquire(randomUUID()),
          /uncertain.*retained/u,
        );
      else if (operation === "query")
        assert.deepEqual(controller.query(), { status: "held-invalid" });
      else {
        assert.ok(owner);
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /common-directory binding changed/u);
      }
    } finally {
      opening.mock.restore();
      creating.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(replaced, true);
    assert.ok(existsSync(f.config.fencePath));
    if (owner) assert.deepEqual(snapshotFile(ownerPath), latch);
  });
}

const LIFETIME_LAYOUTS = [
  "directory",
  "file",
  "symlink-file",
  "symlink-directory",
  "directory-commondir",
] as const;
function lifetimeFixture(
  t: TestContext,
  layout: (typeof LIFETIME_LAYOUTS)[number],
) {
  const f = fixture(t);
  const common = realpathSync.native(join(f.root, ".git"));
  if (layout === "directory")
    return { ...f, repository: f.root, gitdir: common, common };
  const repository = join(f.scratch, "linked lifetime é");
  git(f.root, "worktree", "add", "-qb", "lifetime", repository);
  let gitdir = realpathSync.native(
    git(repository, "rev-parse", "--absolute-git-dir").toString("utf8").trim(),
  );
  const dotGit = join(repository, ".git");
  if (layout === "symlink-file") {
    const pointer = join(f.host, "linked pointer");
    renameSync(dotGit, pointer);
    symlinkSync(pointer, dotGit, "file");
  } else if (layout === "symlink-directory") {
    rmSync(dotGit);
    symlinkSync(
      gitdir,
      dotGit,
      process.platform === "win32" ? "junction" : "dir",
    );
  } else if (layout === "directory-commondir") {
    rmSync(dotGit);
    renameSync(gitdir, dotGit);
    gitdir = dotGit;
    writeFileSync(join(gitdir, "commondir"), common + "\n");
    writeFileSync(join(gitdir, "gitdir"), dotGit + "\n");
  }
  return { ...f, repository, gitdir, common };
}
function replaceCommon(common: string): void {
  const identity = lstatSync(common, { bigint: true });
  renameSync(common, common + " original");
  cpSync(common + " original", common, { recursive: true });
  assert.notEqual(lstatSync(common, { bigint: true }).ino, identity.ino);
}

for (const timing of ["available", "held"] as const) {
  for (const operation of ["query", "acquire", "release"] as const) {
    if (timing === "available" && operation === "release") continue;
    test(`common lifetime binding rejects same-path inode replacement during ${operation} while ${timing}`, async (t) => {
      const f = fixture(t);
      const { createGitPromotionHostControl } = await controlModule();
      const controller = createGitPromotionHostControl(f.config);
      const owner =
        timing === "held" ? controller.acquire(randomUUID()) : undefined;
      const ownerPath = join(f.config.fencePath, "owner.json");
      const latch = owner ? snapshotFile(ownerPath) : undefined;
      const common = realpathSync.native(join(f.root, ".git"));
      replaceCommon(common);
      assert.equal(
        realpathSync.native(
          git(f.root, "rev-parse", "--path-format=absolute", "--git-common-dir")
            .toString("utf8")
            .trim(),
        ),
        common,
      );
      if (operation === "query")
        assert.throws(
          () => controller.query(),
          /common-directory binding changed/u,
        );
      else if (operation === "acquire")
        assert.throws(
          () => controller.acquire(randomUUID()),
          /common-directory binding changed/u,
        );
      else {
        assert.ok(owner);
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /common-directory binding changed/u);
      }
      if (owner) assert.deepEqual(snapshotFile(ownerPath), latch);
      else assert.equal(existsSync(f.config.fencePath), false);
    });
  }
}

for (const layout of LIFETIME_LAYOUTS) {
  for (const operation of ["query", "acquire", "release"] as const) {
    test(`common lifetime binding rejects current commondir redirection in ${layout} during ${operation}`, async (t) => {
      const f = lifetimeFixture(t, layout);
      const { createGitPromotionHostControl } = await controlModule();
      const controller = createGitPromotionHostControl({
        ...f.config,
        repositoryPath: f.repository,
      });
      const owner = controller.acquire(randomUUID());
      const ownerPath = join(f.config.fencePath, "owner.json");
      const latch = snapshotFile(ownerPath);
      const identity = lstatSync(f.common, { bigint: true });
      const redirected = join(f.scratch, "redirected common ü");
      cpSync(f.common, redirected, { recursive: true });
      assert.notEqual(
        lstatSync(redirected, { bigint: true }).ino,
        identity.ino,
      );
      writeFileSync(join(f.gitdir, "commondir"), redirected + "\n");
      // The old common directory remains at the captured path and inode. A stat
      // of that old path alone cannot detect Git's newly selected mapping.
      assert.equal(lstatSync(f.common, { bigint: true }).ino, identity.ino);
      assert.equal(
        realpathSync.native(
          git(
            f.repository,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          )
            .toString("utf8")
            .trim(),
        ),
        redirected,
      );
      if (operation === "query") assert.throws(() => controller.query());
      else if (operation === "acquire")
        assert.throws(() => controller.acquire(randomUUID()));
      else
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        });
      assert.deepEqual(snapshotFile(ownerPath), latch);
    });
  }
  test(`common lifetime binding permits advanced HEAD and dirty tracked/untracked content in ${layout}`, async (t) => {
    const f = lifetimeFixture(t, layout);
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl({
      ...f.config,
      repositoryPath: f.repository,
    });
    const owner = controller.acquire(randomUUID());
    const oldHead = git(f.repository, "rev-parse", "HEAD");
    const identity = lstatSync(f.common, { bigint: true });
    git(f.repository, "commit", "--allow-empty", "-qm", "advance while held");
    assert.notDeepEqual(git(f.repository, "rev-parse", "HEAD"), oldHead);
    writeFileSync(join(f.repository, "value.txt"), "dirty tracked content\n");
    writeFileSync(join(f.repository, "untracked.txt"), "untracked content\n");
    const status = git(f.repository, "status", "--porcelain", "-z");
    assert.ok(status.includes(Buffer.from(" M value.txt\0")));
    assert.ok(status.includes(Buffer.from("?? untracked.txt\0")));
    assert.equal(lstatSync(f.common, { bigint: true }).ino, identity.ino);
    assert.deepEqual(controller.query(), { status: "held", owner });
    controller.release(owner, { childrenQuiescent: true });
    assert.deepEqual(controller.query(), { status: "available" });
    assert.equal(existsSync(f.config.fencePath), false);
    assert.deepEqual(git(f.repository, "status", "--porcelain", "-z"), status);
  });
}

function redirectGitdirIntoFenceParent(
  f: ReturnType<typeof lifetimeFixture>,
): void {
  const commonIdentity = lstatSync(f.common, { bigint: true });
  const parentIdentity = lstatSync(f.host, { bigint: true });
  for (const name of readdirSync(f.gitdir))
    cpSync(join(f.gitdir, name), join(f.host, name), { recursive: true });
  writeFileSync(join(f.host, "commondir"), f.common + "\n");
  const dotGit = join(f.repository, ".git");
  const directoryLink =
    lstatSync(dotGit).isSymbolicLink() && fs.statSync(dotGit).isDirectory();
  rmSync(dotGit);
  if (directoryLink)
    symlinkSync(
      f.host,
      dotGit,
      process.platform === "win32" ? "junction" : "dir",
    );
  else writeFileSync(dotGit, "gitdir: " + f.host + "\n");
  assert.equal(
    realpathSync.native(
      git(f.repository, "rev-parse", "--absolute-git-dir")
        .toString("utf8")
        .trim(),
    ),
    f.host,
  );
  assert.equal(
    git(f.repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
      .toString("utf8")
      .trim(),
    f.common,
  );
  assert.equal(lstatSync(f.common, { bigint: true }).ino, commonIdentity.ino);
  assert.equal(lstatSync(f.host, { bigint: true }).ino, parentIdentity.ino);
}

for (const layout of ["file", "symlink-file", "symlink-directory"] as const) {
  for (const timing of ["available", "held"] as const) {
    for (const operation of ["query", "acquire", "release"] as const) {
      if (timing === "available" && operation === "release") continue;
      test(`complete lifetime separation rejects effective gitdir engulfing fence in ${layout} during ${operation} while ${timing}`, async (t) => {
        const f = lifetimeFixture(t, layout);
        const { createGitPromotionHostControl } = await controlModule();
        const controller = createGitPromotionHostControl({
          ...f.config,
          repositoryPath: f.repository,
        });
        const owner =
          timing === "held" ? controller.acquire(randomUUID()) : undefined;
        const ownerPath = join(f.config.fencePath, "owner.json");
        const latch = owner ? snapshotFile(ownerPath) : undefined;
        redirectGitdirIntoFenceParent(f);
        if (operation === "query") {
          if (owner)
            assert.deepEqual(controller.query(), { status: "held-invalid" });
          else assert.throws(() => controller.query(), /overlap/u);
        } else if (operation === "acquire")
          assert.throws(() => controller.acquire(randomUUID()), /overlap/u);
        else {
          assert.ok(owner);
          assert.throws(() => {
            controller.release(owner, { childrenQuiescent: true });
          }, /overlap/u);
        }
        if (owner) assert.deepEqual(snapshotFile(ownerPath), latch);
        else assert.equal(existsSync(f.config.fencePath), false);
      });
    }
  }
}

for (const boundary of [
  "available-observation",
  "held-observation",
  "post-mkdir",
  "pre-unlink",
  "post-unlink",
] as const) {
  test(`complete lifetime separation rechecks gitdir overlap at ${boundary} and retains latch`, async (t) => {
    const f = lifetimeFixture(t, "file");
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl({
      ...f.config,
      repositoryPath: f.repository,
    });
    const owner =
      boundary === "available-observation" || boundary === "post-mkdir"
        ? undefined
        : controller.acquire(randomUUID());
    const ownerPath = join(f.config.fencePath, "owner.json");
    const latch = owner ? snapshotFile(ownerPath) : undefined;
    let drifted = false;
    let opens = 0;
    const redirect = () => {
      redirectGitdirIntoFenceParent(f);
      drifted = true;
    };
    const originalStat = fs.lstatSync;
    const originalOpen = fs.openSync;
    const originalMkdir = fs.mkdirSync;
    const originalUnlink = fs.unlinkSync;
    const observing = t.mock.method(
      fs,
      "lstatSync",
      (...args: Parameters<typeof fs.lstatSync>) => {
        try {
          return originalStat(...args);
        } catch (error) {
          if (
            args[0] === f.config.fencePath &&
            boundary === "available-observation" &&
            !drifted
          )
            redirect();
          throw error;
        }
      },
    );
    const opening = t.mock.method(
      fs,
      "openSync",
      (...args: Parameters<typeof fs.openSync>) => {
        const fd = originalOpen(...args);
        try {
          if (
            args[0] === ownerPath &&
            !drifted &&
            ++opens === (boundary === "pre-unlink" ? 2 : 1) &&
            (boundary === "held-observation" || boundary === "pre-unlink")
          )
            redirect();
          return fd;
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      },
    );
    const creating = t.mock.method(
      fs,
      "mkdirSync",
      (...args: Parameters<typeof fs.mkdirSync>) => {
        const result = originalMkdir(...args);
        if (args[0] === f.config.fencePath && boundary === "post-mkdir")
          redirect();
        return result;
      },
    );
    const deleting = t.mock.method(
      fs,
      "unlinkSync",
      (...args: Parameters<typeof fs.unlinkSync>) => {
        originalUnlink(...args);
        if (args[0] === ownerPath && boundary === "post-unlink") redirect();
      },
    );
    syncBuiltinESMExports();
    try {
      if (boundary === "available-observation")
        assert.throws(() => controller.query(), /overlap/u);
      else if (boundary === "held-observation")
        assert.deepEqual(controller.query(), { status: "held-invalid" });
      else if (boundary === "post-mkdir")
        assert.throws(
          () => controller.acquire(randomUUID()),
          /uncertain.*retained/u,
        );
      else {
        assert.ok(owner);
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /overlap/u);
      }
    } finally {
      for (const mock of [observing, opening, creating, deleting])
        mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(drifted, true);
    if (boundary === "available-observation")
      assert.equal(existsSync(f.config.fencePath), false);
    else {
      assert.ok(existsSync(f.config.fencePath));
      if (boundary === "post-unlink")
        assert.deepEqual(readdirSync(f.config.fencePath), []);
      else if (owner) assert.deepEqual(snapshotFile(ownerPath), latch);
    }
  });
}

test("lossless physical paths preserve actual Unicode state directory and sidecars", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const state = join(f.host, "state \uFFFD");
  mkdirSync(state, { mode: 0o700 });
  for (const suffix of ["-wal", "-shm", "-journal"])
    writeFileSync(state + suffix, "private", { mode: 0o600 });
  const controller = createGitPromotionHostControl({
    ...f.config,
    statePaths: [state],
  });
  assert.deepEqual(controller.query(), { status: "available" });
  const owner = controller.acquire(randomUUID());
  assert.deepEqual(controller.query(), { status: "held", owner });
  controller.release(owner, { childrenQuiescent: true });
  assert.deepEqual(controller.query(), { status: "available" });
});

const UNICODE_PHYSICAL_TARGETS = [
  "source",
  "metadata-pointer",
  "metadata-directory",
  "common-pointer",
  "fence-parent",
  "ledger-parent",
  "state-parent",
] as const;
function unicodePhysicalFixture(
  t: TestContext,
  target: (typeof UNICODE_PHYSICAL_TARGETS)[number],
) {
  const f = lifetimeFixture(
    t,
    target.startsWith("metadata") || target === "common-pointer"
      ? "file"
      : "directory",
  );
  const config = { ...f.config, repositoryPath: f.repository };
  let entry: string;
  if (target === "source") entry = f.repository;
  else if (target === "metadata-pointer") entry = join(f.repository, ".git");
  else if (target === "metadata-directory") {
    entry = f.gitdir;
    writeFileSync(join(entry, "commondir"), f.common + "\n");
    rmSync(join(f.repository, ".git"));
    symlinkSync(
      entry,
      join(f.repository, ".git"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } else if (target === "common-pointer") {
    entry = join(f.gitdir, "commondir");
    writeFileSync(entry, f.common + "\n");
  } else if (target === "fence-parent") entry = f.host;
  else {
    entry = join(f.scratch, "separate private location");
    mkdirSync(entry, { mode: 0o700 });
    if (target === "ledger-parent")
      config.approvalDatabasePath = join(entry, "approval.sqlite");
    else config.statePaths = [join(entry, "config.json")];
  }
  const twin = join(f.scratch, "physical \uFFFD");
  const isDirectory = lstatSync(entry).isDirectory();
  renameSync(entry, twin);
  symlinkSync(
    twin,
    entry,
    isDirectory ? (process.platform === "win32" ? "junction" : "dir") : "file",
  );
  return { ...f, config, entry, twin, isDirectory };
}
function rawPhysicalTwin(f: ReturnType<typeof unicodePhysicalFixture>): Buffer {
  const raw = Buffer.concat([
    Buffer.from(join(f.scratch, "physical ")),
    Buffer.from([0xff]),
  ]);
  if (f.isDirectory) {
    const staging = join(f.scratch, "raw copy staging");
    cpSync(f.twin, staging, { recursive: true });
    renameSync(staging, raw);
  } else writeFileSync(raw, snapshotFile(f.twin), { mode: 0o600 });
  assert.notDeepEqual(raw, Buffer.from(f.twin));
  return raw;
}
function rejectsBeforeTwinInspection(
  t: TestContext,
  twin: string,
  action: () => unknown,
): void {
  let inspections = 0;
  const observe = (path: unknown) => {
    if (
      typeof path === "string" &&
      (path === twin || path.startsWith(twin + "/"))
    ) {
      inspections++;
      throw new Error("Replacement twin was inspected");
    }
  };
  const originalStat = fs.statSync;
  const originalLstat = fs.lstatSync;
  const originalOpen = fs.openSync;
  const stats = t.mock.method(
    fs,
    "statSync",
    (...args: Parameters<typeof fs.statSync>) => {
      observe(args[0]);
      return originalStat(...args);
    },
  );
  const lstats = t.mock.method(
    fs,
    "lstatSync",
    (...args: Parameters<typeof fs.lstatSync>) => {
      observe(args[0]);
      return originalLstat(...args);
    },
  );
  const opening = t.mock.method(
    fs,
    "openSync",
    (...args: Parameters<typeof fs.openSync>) => {
      observe(args[0]);
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(action, /lossless|UTF-8|encoded data/u);
  } finally {
    for (const mock of [stats, lstats, opening]) mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    inspections,
    0,
    "must reject raw physical bytes before inspecting replacement twin",
  );
}

for (const target of UNICODE_PHYSICAL_TARGETS) {
  test(`lossless physical paths preserve valid Unicode replacement character in ${target}`, async (t) => {
    const f = unicodePhysicalFixture(t, target);
    const { createGitPromotionHostControl } = await controlModule();
    assert.ok(
      git(f.config.repositoryPath, "rev-parse", "--show-toplevel").length > 0,
    );
    assert.deepEqual(
      realpathSync.native(f.entry, { encoding: "buffer" }),
      Buffer.from(f.twin),
    );
    const controller = createGitPromotionHostControl(f.config);
    assert.deepEqual(controller.query(), { status: "available" });
    const owner = controller.acquire(randomUUID());
    assert.deepEqual(controller.query(), { status: "held", owner });
    controller.release(owner, { childrenQuiescent: true });
    assert.deepEqual(controller.query(), { status: "available" });
  });
  test(
    `lossless physical paths reject invalid-byte ${target} with existing Unicode twin before construction inspection`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = unicodePhysicalFixture(t, target);
      const { createGitPromotionHostControl } = await controlModule();
      const raw = rawPhysicalTwin(f);
      rmSync(f.entry);
      symlinkSync(raw, f.entry, f.isDirectory ? "dir" : "file");
      assert.deepEqual(
        realpathSync.native(f.entry, { encoding: "buffer" }),
        raw,
      );
      assert.equal(realpathSync.native(f.entry), f.twin);
      assert.ok(
        git(f.config.repositoryPath, "rev-parse", "--show-toplevel").length > 0,
      );
      rejectsBeforeTwinInspection(t, f.twin, () =>
        createGitPromotionHostControl(f.config),
      );
      assert.equal(existsSync(f.config.fencePath), false);
    },
  );
}

for (const target of [
  "source",
  "metadata-directory",
  "fence-parent",
  "ledger-parent",
  "state-parent",
] as const) {
  for (const timing of ["available", "held"] as const) {
    test(
      `lossless physical paths revalidate captured ${target} against raw-byte redirection while ${timing}`,
      { skip: process.platform === "win32" },
      async (t) => {
        const f = unicodePhysicalFixture(t, target);
        const { createGitPromotionHostControl } = await controlModule();
        const controller = createGitPromotionHostControl(f.config);
        const owner =
          timing === "held" ? controller.acquire(randomUUID()) : undefined;
        const capturedFence =
          owner?.fencePath ??
          realpathSync.native(dirname(f.config.fencePath)) + "/ownership";
        const latch = owner
          ? snapshotFile(join(capturedFence, "owner.json"))
          : undefined;
        const substitute = join(f.scratch, "late physical \uFFFD");
        const staging = join(f.scratch, "late physical staging");
        const raw = Buffer.concat([
          Buffer.from(join(f.scratch, "late physical ")),
          Buffer.from([0xff]),
        ]);
        cpSync(f.twin, substitute, { recursive: true });
        cpSync(f.twin, staging, { recursive: true });
        renameSync(staging, raw);
        renameSync(f.twin, f.twin + " original");
        symlinkSync(raw, f.twin, "dir");
        assert.deepEqual(
          realpathSync.native(f.twin, { encoding: "buffer" }),
          raw,
        );
        assert.equal(realpathSync.native(f.twin), substitute);
        assert.ok(
          git(f.config.repositoryPath, "rev-parse", "--show-toplevel").length >
            0,
        );
        rejectsBeforeTwinInspection(t, substitute, () => controller.query());
        rejectsBeforeTwinInspection(t, substitute, () =>
          controller.acquire(randomUUID()),
        );
        if (owner) {
          rejectsBeforeTwinInspection(t, substitute, () => {
            controller.release(owner, { childrenQuiescent: true });
          });
          assert.deepEqual(
            snapshotFile(join(capturedFence, "owner.json")),
            latch,
          );
        } else assert.equal(existsSync(capturedFence), false);
      },
    );
  }
}

test("owner snapshots accept atime-only observation changes throughout acquire/query/release", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const controller = createGitPromotionHostControl(f.config);
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  let atimes = 0n;
  function atimeOnly(stats: fs.Stats | fs.BigIntStats): void {
    if ("atimeNs" in stats) {
      stats.atimeNs += ++atimes;
      stats.atimeMs += atimes;
    }
  }
  const pathStats = t.mock.method(
    fs,
    "lstatSync",
    (...args: Parameters<typeof fs.lstatSync>) => {
      const stats = originalLstat(...args);
      if (stats) atimeOnly(stats);
      return stats;
    },
  );
  const descriptorStats = t.mock.method(
    fs,
    "fstatSync",
    (...args: Parameters<typeof fs.fstatSync>) => {
      const stats = originalFstat(...args);
      atimeOnly(stats);
      return stats;
    },
  );
  syncBuiltinESMExports();
  try {
    const owner = controller.acquire(randomUUID());
    assert.deepEqual(controller.query(), { status: "held", owner });
    controller.release(owner, { childrenQuiescent: true });
    assert.deepEqual(controller.query(), { status: "available" });
    assert.ok(atimes > 0n);
  } finally {
    for (const mock of [pathStats, descriptorStats]) mock.mock.restore();
    syncBuiltinESMExports();
  }
});

type OwnerMutation = "truncate" | "same-size-token" | "unsafe-mode";
function mutateOwner(path: string, mutation: OwnerMutation) {
  const before = lstatSync(path, { bigint: true });
  const bytes = readFileSync(path);
  if (mutation === "truncate") writeFileSync(path, "{");
  else if (mutation === "same-size-token") {
    const owner = JSON.parse(bytes.toString("utf8")) as { token: string };
    const token = randomUUID();
    assert.notEqual(token, owner.token);
    const replacement = Buffer.from(JSON.stringify({ ...owner, token }));
    assert.equal(replacement.length, bytes.length);
    writeFileSync(path, replacement);
  } else chmodSync(path, process.platform === "win32" ? 0o444 : 0o644);
  const after = lstatSync(path, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  if (mutation === "same-size-token") {
    assert.equal(after.size, before.size);
    assert.notDeepEqual(readFileSync(path), bytes);
  }
  if (mutation === "truncate") assert.notEqual(after.size, before.size);
  if (mutation === "unsafe-mode") assert.notEqual(after.mode, before.mode);
  return { bytes: readFileSync(path), stats: after };
}

for (const timing of ["during-read", "after-close"] as const) {
  for (const mutation of [
    "truncate",
    "same-size-token",
    "unsafe-mode",
  ] as const) {
    for (const operation of ["query", "acquire", "release"] as const) {
      test(`observable owner mutation ${mutation} ${timing} rejects ${operation} without deleting or repairing latch`, async (t) => {
        const f = fixture(t);
        const { createGitPromotionHostControl } = await controlModule();
        const controller = createGitPromotionHostControl(f.config);
        const owner =
          operation === "acquire"
            ? undefined
            : controller.acquire(randomUUID());
        const path = join(f.config.fencePath, "owner.json");
        const targetRead = operation === "release" ? 2 : 1;
        let readNumber = 0;
        let descriptor: number | undefined;
        let evidence: ReturnType<typeof mutateOwner> | undefined;
        const originalOpen = fs.openSync;
        const originalRead = fs.readSync;
        const originalClose = fs.closeSync;
        const opening = t.mock.method(
          fs,
          "openSync",
          (...args: Parameters<typeof fs.openSync>) => {
            const fd = originalOpen(...args);
            if (
              args[0] === path &&
              typeof args[1] === "number" &&
              (args[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0
            ) {
              readNumber++;
              descriptor = fd;
            }
            return fd;
          },
        );
        const reading = t.mock.method(
          fs,
          "readSync",
          (...args: Parameters<typeof fs.readSync>) => {
            const count = originalRead(...args);
            // Real owner bytes have already been copied; mutate before EOF/final fstat.
            if (
              timing === "during-read" &&
              count > 0 &&
              args[0] === descriptor &&
              readNumber === targetRead &&
              !evidence
            )
              evidence = mutateOwner(path, mutation);
            return count;
          },
        );
        const closing = t.mock.method(
          fs,
          "closeSync",
          (...args: Parameters<typeof fs.closeSync>) => {
            const ownerDescriptor = args[0] === descriptor;
            originalClose(...args);
            // Clear before fixture I/O can reuse the just-closed descriptor.
            if (ownerDescriptor) descriptor = undefined;
            // Descriptor validation is finished, but inspect's final path observation is still ahead.
            if (
              timing === "after-close" &&
              ownerDescriptor &&
              readNumber === targetRead &&
              !evidence
            )
              evidence = mutateOwner(path, mutation);
          },
        );
        syncBuiltinESMExports();
        let result: unknown;
        let error: unknown;
        try {
          if (operation === "query") result = controller.query();
          else if (operation === "acquire")
            result = controller.acquire(randomUUID());
          else controller.release(owner, { childrenQuiescent: true });
        } catch (caught) {
          error = caught;
        } finally {
          for (const mock of [opening, reading, closing]) mock.mock.restore();
          syncBuiltinESMExports();
        }
        assert.ok(evidence, "real same-inode mutation must have executed");
        if (operation === "query")
          assert.deepEqual(result, { status: "held-invalid" });
        else {
          assert.ok(
            error instanceof Error,
            "mutation must not return acquired/released success",
          );
          if (operation === "acquire")
            assert.match(error.message, /uncertain.*retained/u);
        }
        assert.ok(existsSync(f.config.fencePath));
        assert.deepEqual(
          readFileSync(path),
          evidence.bytes,
          "must retain the mutated owner without repair",
        );
        const retained = lstatSync(path, { bigint: true });
        assert.equal(retained.ino, evidence.stats.ino);
        assert.equal(retained.mode, evidence.stats.mode);
        assert.throws(() => controller.acquire(randomUUID()), /held/u);
      });
    }
  }
}

for (const mutation of [
  "rewrite-identical",
  "mode-restored",
  "link-restored",
] as const) {
  test(`observable owner metadata ${mutation} between release inspections retains owner and latch`, async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl(f.config);
    const owner = controller.acquire(randomUUID());
    const path = join(f.config.fencePath, "owner.json");
    const bytes = readFileSync(path);
    const before = lstatSync(path, { bigint: true });
    let observations = 0;
    let mutated = false;
    const original = fs.lstatSync;
    const observing = t.mock.method(
      fs,
      "lstatSync",
      (...args: Parameters<typeof fs.lstatSync>) => {
        // Mutate before the next captured owner snapshot, after the first inspect completed.
        if (args[0] === path && ++observations === 3) {
          if (mutation === "rewrite-identical") writeFileSync(path, bytes);
          else if (mutation === "mode-restored") {
            chmodSync(path, process.platform === "win32" ? 0o444 : 0o644);
            chmodSync(path, 0o600);
          } else {
            const alias = join(f.host, "transient owner alias");
            linkSync(path, alias);
            rmSync(alias);
          }
          mutated = true;
        }
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    let error: unknown;
    try {
      controller.release(owner, { childrenQuiescent: true });
    } catch (caught) {
      error = caught;
    } finally {
      observing.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(mutated, true);
    assert.ok(
      error instanceof Error,
      "release must honor metadata drift even with identical owner bytes",
    );
    assert.ok(existsSync(f.config.fencePath));
    assert.deepEqual(readFileSync(path), bytes);
    const after = lstatSync(path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mode, before.mode);
    assert.equal(after.nlink, before.nlink);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
  });
}

for (const target of ["metadata-pointer", "common-pointer"] as const) {
  for (const timing of ["available", "held"] as const) {
    test(
      `lossless physical paths reject late invalid-byte ${target} during all ${timing} operations without twin inspection`,
      { skip: process.platform === "win32" },
      async (t) => {
        const f = unicodePhysicalFixture(t, target);
        const { createGitPromotionHostControl } = await controlModule();
        const controller = createGitPromotionHostControl(f.config);
        const owner =
          timing === "held" ? controller.acquire(randomUUID()) : undefined;
        const latch = owner
          ? snapshotFile(join(f.config.fencePath, "owner.json"))
          : undefined;
        const raw = rawPhysicalTwin(f);
        rmSync(f.entry);
        symlinkSync(raw, f.entry, "file");
        assert.deepEqual(
          realpathSync.native(f.entry, { encoding: "buffer" }),
          raw,
        );
        assert.ok(
          git(f.config.repositoryPath, "rev-parse", "--show-toplevel").length >
            0,
        );
        rejectsBeforeTwinInspection(t, f.twin, () => controller.query());
        rejectsBeforeTwinInspection(t, f.twin, () =>
          controller.acquire(randomUUID()),
        );
        if (owner) {
          rejectsBeforeTwinInspection(t, f.twin, () => {
            controller.release(owner, { childrenQuiescent: true });
          });
          assert.deepEqual(
            snapshotFile(join(f.config.fencePath, "owner.json")),
            latch,
          );
        } else assert.equal(existsSync(f.config.fencePath), false);
      },
    );
  }
}
