import assert from "node:assert/strict";
import childProcess, {
  execFileSync,
  fork,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, {
  fchmodSync,
  ftruncateSync,
  futimesSync,
  readSync,
  writeSync,
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

import { sep } from "node:path";

function probeInvalidBytePaths(platform = process.platform): boolean {
  const probeScratch = mkdtempSync(join(tmpdir(), "reprogate-probe-"));
  let fd: number | undefined;
  try {
    // ENOENT for a raw Windows path is a capability result only after a real
    // valid-name file can be created in this same owned directory.
    const controlName = Buffer.from("valid-name");
    const control = Buffer.concat([
      Buffer.from(probeScratch),
      Buffer.from(sep),
      controlName,
    ]);
    fd = openSync(control, "wx");
    const controlIdentity = fstatSync(fd, { bigint: true });
    const parentIdentity = lstatSync(probeScratch, { bigint: true });
    closeSync(fd);
    fd = undefined;
    const verifyControl = () => {
      const parent = lstatSync(probeScratch, { bigint: true });
      const current = lstatSync(control, { bigint: true });
      assert.ok(parent.isDirectory() && current.isFile());
      assert.deepEqual(
        [parent.dev, parent.ino],
        [parentIdentity.dev, parentIdentity.ino],
        "capability probe parent changed",
      );
      assert.deepEqual(
        [current.dev, current.ino],
        [controlIdentity.dev, controlIdentity.ino],
        "capability probe control changed",
      );
      assert.ok(
        readdirSync(probeScratch, { encoding: "buffer" }).some((entry) =>
          entry.equals(controlName),
        ),
        "valid Buffer name must roundtrip byte-for-byte",
      );
    };
    verifyControl();
    const probeFile = Buffer.concat([
      Buffer.from(probeScratch),
      Buffer.from(sep),
      Buffer.from([0xff]),
    ]);
    try {
      fd = openSync(probeFile, "wx");
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (
        err.code === "EILSEQ" ||
        err.code === "EINVAL" ||
        (platform === "win32" && err.code === "ENOENT")
      ) {
        verifyControl();
        return false;
      }
      throw error;
    }
    // Some Unicode-only filesystems accept Buffer input after replacement
    // decoding. Creation alone is not proof that the original byte survived.
    return readdirSync(probeScratch, { encoding: "buffer" }).some((entry) =>
      entry.equals(Buffer.from([0xff])),
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(probeScratch, { recursive: true, force: true });
  }
}
const supportsInvalidBytePaths = probeInvalidBytePaths();

for (const [platform, code, unsupported] of [
  ["win32", "ENOENT", true],
  ["linux", "ENOENT", false],
  ["win32", "EACCES", false],
] as const) {
  test(`raw path capability ${platform}/${code} requires a successful valid-name control`, (t) => {
    const original = fs.openSync;
    let control: string | undefined;
    let controlFd: number | undefined;
    let invalidAttempts = 0;
    const opening = t.mock.method(
      fs,
      "openSync",
      (...args: Parameters<typeof fs.openSync>) => {
        if (Buffer.isBuffer(args[0]) && args[0].at(-1) === 0xff) {
          invalidAttempts++;
          assert.ok(
            control,
            "probe must establish a real valid-name control first",
          );
          assert.ok(existsSync(control));
          throw Object.assign(new Error("modeled invalid-byte probe failure"), {
            code,
          });
        }
        assert.ok(
          Buffer.isBuffer(args[0]),
          "valid control must exercise Buffer path handling",
        );
        const fd = original(...args);
        control = String(args[0]);
        controlFd = fd;
        return fd;
      },
    );
    syncBuiltinESMExports();
    try {
      if (unsupported) assert.equal(probeInvalidBytePaths(platform), false);
      else assert.throws(() => probeInvalidBytePaths(platform), { code });
    } finally {
      opening.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(invalidAttempts, 1);
    assert.ok(control);
    assert.equal(
      existsSync(dirname(control)),
      false,
      "probe scratch is removed",
    );
    assert.ok(controlFd !== undefined);
    const descriptor = controlFd;
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
  });
}

test("raw path capability never hides a Windows ENOENT for its valid-name control", (t) => {
  const opening = t.mock.method(fs, "openSync", () => {
    throw Object.assign(new Error("modeled valid-name control failure"), {
      code: "ENOENT",
    });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => probeInvalidBytePaths("win32"), { code: "ENOENT" });
  } finally {
    opening.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(opening.mock.callCount(), 1);
});

for (const drift of ["remove-control", "replace-parent"] as const) {
  test(`raw path capability does not hide Windows ENOENT after real ${drift}`, (t) => {
    const original = fs.openSync;
    let control: string | undefined;
    let moved: string | undefined;
    let invalidAttempts = 0;
    const opening = t.mock.method(
      fs,
      "openSync",
      (...args: Parameters<typeof fs.openSync>) => {
        if (Buffer.isBuffer(args[0]) && args[0].at(-1) === 0xff) {
          invalidAttempts++;
          assert.ok(control);
          if (drift === "remove-control") rmSync(control);
          else {
            const parent = dirname(control);
            moved = `${parent}-moved`;
            renameSync(parent, moved);
            mkdirSync(parent);
            writeFileSync(control, "");
          }
          throw Object.assign(
            new Error("modeled Windows invalid-path ENOENT"),
            { code: "ENOENT" },
          );
        }
        control = String(args[0]);
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => probeInvalidBytePaths("win32"),
        drift === "remove-control"
          ? { code: "ENOENT" }
          : /probe parent changed/u,
      );
    } finally {
      opening.mock.restore();
      syncBuiltinESMExports();
      if (moved) rmSync(moved, { recursive: true, force: true });
    }
    assert.equal(invalidAttempts, 1);
    assert.ok(control);
    assert.equal(existsSync(dirname(control)), false);
  });
}

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
    const failures: unknown[] = [];
    for (const worker of workers) {
      try {
        // Exit alone does not prove that stdio has closed or files can be removed.
        await workerExit(worker, 10_000, worker.pid !== undefined);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Owned fixture workers could not all be reaped",
      );
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
const ownedWorkerLifecycles = new WeakMap<
  ChildProcess,
  {
    closed: boolean;
    exitEvidence: boolean;
    successfulKill: boolean;
  }
>();
function worker(
  f: ReturnType<typeof fixture>,
  mode = "acquire",
  timeoutMs = 10_000,
  execPath = process.execPath,
) {
  const child = fork(
    fileURLToPath(
      new URL(
        "./fixtures/git-promotion-host-control-worker.js",
        import.meta.url,
      ),
    ),
    [JSON.stringify(f.config), mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], execPath },
  );
  const lifecycle = {
    closed: false,
    exitEvidence: false,
    successfulKill: false,
  };
  ownedWorkerLifecycles.set(child, lifecycle);
  child.once("close", (code, signal) => {
    lifecycle.closed = true;
    lifecycle.exitEvidence =
      code !== null || signal !== null || child.pid === undefined;
  });
  f.workers.push(child);
  return {
    child,
    message: workerMessage(child, timeoutMs),
  };
}
interface WorkerMessage {
  status: string;
  owner: import("../src/git-promotion-host-control.js").GitPromotionFenceOwnerV1;
}
function boundedWorkerWait(
  child: ChildProcess,
  event: "message" | "exit",
  timeoutMs: number,
  stopOwned = false,
): Promise<unknown> {
  const lifecycle = ownedWorkerLifecycles.get(child);
  if (event === "exit" && lifecycle?.closed && lifecycle.exitEvidence)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    let failedKill = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (event === "message")
        onError(
          new Error(
            `Worker exited before message: ${String(code)}/${String(signal)}`,
          ),
        );
      // Reaping must also wait for close, which follows exit and closes stdio.
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === null && signal === null && child.pid !== undefined) {
        onError(new Error("Owned fixture worker closed without exit evidence"));
        return;
      }
      cleanup();
      resolve(undefined);
    };
    const timer = setTimeout(() => {
      onError(
        new Error(
          event === "message"
            ? "Owned fixture worker did not send a message"
            : failedKill
              ? "Owned fixture worker could not be stopped and did not exit/close"
              : "Owned fixture worker did not exit/close",
        ),
      );
    }, timeoutMs);
    if (event === "message") child.once("message", onMessage);
    else child.once("close", onClose);
    child.once("error", onError);
    child.once("exit", onExit);
    if (stopOwned) {
      try {
        assert.ok(
          lifecycle && child.pid !== undefined,
          "Only an owned spawned child may be stopped",
        );
        if (
          child.exitCode === null &&
          child.signalCode === null &&
          !lifecycle.successfulKill
        ) {
          lifecycle.successfulKill = child.kill("SIGKILL");
          // False can race with natural exit or an OS kill. Only actual bounded
          // close with exit evidence can establish quiescence in that case.
          failedKill = !lifecycle.successfulKill;
        }
      } catch (error) {
        onError(
          new Error("Owned fixture worker could not be stopped", {
            cause: error,
          }),
        );
      }
    }
  });
}
function workerMessage(
  child: ChildProcess,
  timeoutMs: number,
): Promise<WorkerMessage> {
  return boundedWorkerWait(child, "message", timeoutMs).then(
    (message) => message as WorkerMessage,
  );
}
function workerExit(
  child: ChildProcess,
  timeoutMs = 10_000,
  stopOwned = false,
): Promise<void> {
  return boundedWorkerWait(child, "exit", timeoutMs, stopOwned).then(
    () => undefined,
  );
}
async function regressionGuard<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Regression guard: worker wait is unbounded"));
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function noWaitListeners(child: ChildProcess) {
  assert.equal(
    child.listenerCount("close"),
    ownedWorkerLifecycles.get(child)?.closed ? 0 : 1,
    "leftover close wait listener (one lifecycle observer is retained until reaped)",
  );
  for (const event of ["message", "error", "exit"])
    assert.equal(
      child.listenerCount(event),
      0,
      `leftover ${event} wait listener`,
    );
}

test("owned silent worker message wait times out, clears listeners, and cleanup reaps it", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root, f.host);
  const child = worker(f, "silent", 100);
  t.after(() => {
    assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
    noWaitListeners(child.child);
    assert.equal(existsSync(f.scratch), false);
  });
  await assert.rejects(
    regressionGuard(child.message),
    /did not send a message/u,
  );
  assert.equal(child.child.exitCode, null);
  noWaitListeners(child.child);
  assert.deepEqual(snapshot(f.root, f.host), before);
});
test("owned worker exit before message rejects and clears listeners", async (t) => {
  const f = fixture(t);
  const child = worker(f, "exit-before-message");
  await assert.rejects(
    regressionGuard(child.message),
    /Worker exited before message: 17/u,
  );
  assert.equal(child.child.exitCode, 17);
  noWaitListeners(child.child);
});
test("owned fork spawn error rejects without stale listeners or a child to kill", async (t) => {
  const f = fixture(t);
  const child = worker(
    f,
    "acquire",
    10_000,
    join(f.scratch, "missing-owned-worker-executable"),
  );
  await assert.rejects(regressionGuard(child.message), /ENOENT/u);
  assert.equal(child.child.pid, undefined);
  noWaitListeners(child.child);
});
test("owned live worker exit wait times out and clears listeners before cleanup kill", async (t) => {
  const f = fixture(t);
  const child = worker(f);
  t.after(() => {
    assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
    noWaitListeners(child.child);
    assert.equal(existsSync(f.scratch), false);
  });
  assert.equal((await child.message).status, "acquired");
  await assert.rejects(
    regressionGuard(workerExit(child.child, 100)),
    /did not exit/u,
  );
  assert.equal(child.child.exitCode, null);
  assert.equal(child.child.signalCode, null);
  noWaitListeners(child.child);
});

test("owned false-kill race requires the real child close before quiescence", async (t) => {
  const f = fixture(t);
  const child = worker(f);
  await child.message;
  let closed = false;
  child.child.once("close", () => {
    closed = true;
  });
  const originalKill = child.child.kill.bind(child.child);
  const stopping = t.mock.method(
    child.child,
    "kill",
    (signal?: NodeJS.Signals | number) => {
      assert.equal(originalKill(signal), true);
      return false; // The OS has stopped the owned child before kill reports its race.
    },
  );
  try {
    await regressionGuard(workerExit(child.child, 1000, true));
    assert.equal(closed, true);
    assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
  } finally {
    stopping.mock.restore();
  }
  noWaitListeners(child.child);
});

test("owned unsuccessful kill cannot report a live child as quiescent", async (t) => {
  const f = fixture(t);
  const child = worker(f);
  await child.message;
  const stopping = t.mock.method(child.child, "kill", () => false);
  try {
    await assert.rejects(
      regressionGuard(workerExit(child.child, 100, true)),
      /could not be stopped.*did not exit/u,
    );
    assert.equal(child.child.exitCode, null);
    assert.equal(child.child.signalCode, null);
    noWaitListeners(child.child);
  } finally {
    stopping.mock.restore();
  }
});

test("owned concurrent reap shares a successful kill and waits for delayed close", async (t) => {
  const f = fixture(t);
  const child = worker(f);
  await child.message;
  let closed = false;
  const originalEmit = child.child.emit.bind(child.child);
  const emitting = t.mock.method(
    child.child,
    "emit",
    (event: string | symbol, ...args: unknown[]) => {
      if (event === "close") {
        setTimeout(() => {
          closed = true;
          originalEmit(event, ...args);
        }, 100);
        return true;
      }
      return originalEmit(event, ...args);
    },
  );
  const originalKill = child.child.kill.bind(child.child);
  let kills = 0;
  const stopping = t.mock.method(
    child.child,
    "kill",
    (signal?: NodeJS.Signals | number) => {
      kills++;
      if (kills > 1) return false;
      return originalKill(signal);
    },
  );
  try {
    await regressionGuard(
      Promise.all([
        workerExit(child.child, 1000, true),
        workerExit(child.child, 1000, true),
      ]),
    );
    assert.equal(kills, 1);
    assert.equal(closed, true);
  } finally {
    stopping.mock.restore();
    emitting.mock.restore();
  }
  noWaitListeners(child.child);
});

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
  noWaitListeners(a.child);
  noWaitListeners(b.child);
  assert.deepEqual(results.map((r) => r.status).sort(), ["acquired", "held"]);
  const winningIndex = results.findIndex((r) => r.status === "acquired");
  const winner = [a, b][winningIndex];
  const result = results[winningIndex];
  assert.ok(winner);
  assert.ok(result);
  const owner = result.owner;
  assert.equal(winner.child.exitCode, null);
  assert.equal(winner.child.signalCode, null);
  await workerExit(winner.child, 10_000, true);
  noWaitListeners(winner.child);
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
      writeFileSync(join(gitdir, "commondir"), join(f.root, ".git") + "\n");
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
  assert.throws(() => createGitPromotionHostControl(f.config).query());
  rmSync(f.config.approvalDatabasePath);
  linkSync(target, f.config.approvalDatabasePath);
  assert.throws(() => createGitPromotionHostControl(f.config).query());
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
  assert.throws(() => createGitPromotionHostControl(f.config).query());
  assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test(
  "POSIX private ownership/permissions and FIFOs are enforced (Windows ACLs are a host deployment responsibility)",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    chmodSync(f.host, 0o755);
    assert.throws(() => createGitPromotionHostControl(f.config).query());
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
    assert.throws(() => createGitPromotionHostControl(f.config).query());
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
  { skip: !supportsInvalidBytePaths },
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
    assert.throws(() => createGitPromotionHostControl(f.config).query());
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
    assert.throws(() => createGitPromotionHostControl(f.config).query());
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
    return { ...f, repository: f.root, gitdir: common, common, layout };
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
    // Git for Windows can resolve ../.. relative to the junction spelling.
    // Bind to the actual common directory before installing the directory link.
    writeFileSync(join(gitdir, "commondir"), common + "\n");
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
  return { ...f, repository, gitdir, common, layout };
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

function physicalGitPath(output: Buffer): Buffer {
  assert.ok(output.length > 1 && output[output.length - 1] === 0x0a);
  const path = output.subarray(0, -1);
  assert.ok(!path.includes(0) && !path.includes(0x0a) && !path.includes(0x0d));
  // Preserve the path bytes; Git's slash spelling can differ from native Windows.
  return realpathSync.native(path, { encoding: "buffer" });
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
    f.layout === "directory" ||
    f.layout === "symlink-directory" ||
    f.layout === "directory-commondir";
  rmSync(dotGit, { recursive: true, force: true });
  if (directoryLink)
    symlinkSync(
      f.host,
      dotGit,
      process.platform === "win32" ? "junction" : "dir",
    );
  else writeFileSync(dotGit, "gitdir: " + f.host + "\n");
  assert.deepEqual(
    physicalGitPath(git(f.repository, "rev-parse", "--absolute-git-dir")),
    realpathSync.native(Buffer.from(f.host), { encoding: "buffer" }),
  );
  assert.deepEqual(
    physicalGitPath(
      git(
        f.repository,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    ),
    realpathSync.native(Buffer.from(f.common), { encoding: "buffer" }),
  );
  assert.equal(lstatSync(f.common, { bigint: true }).ino, commonIdentity.ino);
  assert.equal(lstatSync(f.host, { bigint: true }).ino, parentIdentity.ino);
}

test("modeled Windows Git rejects relative junction commondir but the real linked fixture is recognized", async (t) => {
  const f = lifetimeFixture(t, "symlink-directory");
  const original = childProcess.execFileSync;
  const reading = t.mock.method(
    childProcess,
    "execFileSync",
    (...args: Parameters<typeof execFileSync>) => {
      const command = args[1];
      if (
        Array.isArray(command) &&
        command[0] === "-C" &&
        command[1] === f.repository &&
        readFileSync(join(f.gitdir, "commondir"), "utf8").trim() === "../.."
      ) {
        throw new Error(
          "modeled Windows Git: fatal: not a git repository: junction with relative commondir",
        );
      }
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  const commondir = readFileSync(join(f.gitdir, "commondir"));
  try {
    // This is a genuine Git operation; only the unsupported relative layout is modeled.
    git(f.repository, "rev-parse", "--git-common-dir");
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl({
      ...f.config,
      repositoryPath: f.repository,
    });
    assert.deepEqual(controller.query(), { status: "available" });
    writeFileSync(join(f.gitdir, "commondir"), "../..\n");
    assert.throws(
      () => git(f.repository, "rev-parse", "--git-common-dir"),
      /junction with relative commondir/u,
    );
  } finally {
    writeFileSync(join(f.gitdir, "commondir"), commondir);
    reading.mock.restore();
    syncBuiltinESMExports();
  }
});

test("modeled Windows Git path separators preserve physical relocation identity and reject another common directory", (t) => {
  const f = lifetimeFixture(t, "file");
  const commonSpelling = Buffer.from("C:/modeled/common é");
  const wrongSpelling = Buffer.from("C:/modeled/wrong common é");
  const wrongCommon = join(f.scratch, "different common é");
  mkdirSync(wrongCommon);
  let wrong = false;
  let byteResolutions = 0;
  const originalGit = childProcess.execFileSync;
  const reading = t.mock.method(
    childProcess,
    "execFileSync",
    (...args: Parameters<typeof execFileSync>) => {
      const result = originalGit(...args);
      const command = args[1];
      if (
        Array.isArray(command) &&
        command[1] === f.repository &&
        command.includes("--git-common-dir")
      )
        return Buffer.concat([
          wrong ? wrongSpelling : commonSpelling,
          Buffer.from("\n"),
        ]);
      return result;
    },
  );
  const originalRealpath = realpathSync.native;
  const resolving = t.mock.method(
    realpathSync,
    "native",
    (path: fs.PathLike, options?: fs.EncodingOption) => {
      if (
        Buffer.isBuffer(path) &&
        (path.equals(commonSpelling) || path.equals(wrongSpelling))
      ) {
        assert.equal(
          typeof options === "object" ? options?.encoding : options,
          "buffer",
        );
        byteResolutions++;
        return originalRealpath(
          path.equals(commonSpelling) ? f.common : wrongCommon,
          options,
        );
      }
      return originalRealpath(path, options);
    },
  );
  syncBuiltinESMExports();
  try {
    redirectGitdirIntoFenceParent(f);
    assert.equal(byteResolutions, 1);
    wrong = true;
    assert.throws(
      () => {
        redirectGitdirIntoFenceParent(f);
      },
      { name: "AssertionError" },
    );
    assert.equal(byteResolutions, 2);
  } finally {
    reading.mock.restore();
    resolving.mock.restore();
    syncBuiltinESMExports();
  }
});

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
    { skip: !supportsInvalidBytePaths },
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
      { skip: !supportsInvalidBytePaths },
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
  const fd = openSync(path, "r+");
  try {
    const before = fstatSync(fd, { bigint: true });
    const bytes = Buffer.alloc(Number(before.size));
    readSync(fd, bytes, 0, bytes.length, 0);

    if (mutation === "truncate") {
      ftruncateSync(fd, 1);
      writeSync(fd, Buffer.from("{"), 0, 1, 0);
    } else if (mutation === "same-size-token") {
      const owner = JSON.parse(bytes.toString("utf8")) as { token: string };
      const token = randomUUID();
      assert.notEqual(token, owner.token);
      const replacement = Buffer.from(JSON.stringify({ ...owner, token }));
      assert.equal(replacement.length, bytes.length);
      writeSync(fd, replacement, 0, replacement.length, 0);
      const mtime = Number(before.mtimeMs) / 1000 + 1;
      futimesSync(fd, mtime, mtime);
    } else fchmodSync(fd, process.platform === "win32" ? 0o444 : 0o644);

    const after = fstatSync(fd, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);

    if (mutation === "truncate") assert.notEqual(after.size, before.size);
    else if (mutation === "unsafe-mode")
      assert.notEqual(after.mode, before.mode);
    else {
      assert.equal(after.size, before.size);
      assert.ok(
        after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs,
        "same-size replacement must expose a stable timestamp change",
      );
      const afterBytes = Buffer.alloc(Number(after.size));
      readSync(fd, afterBytes, 0, afterBytes.length, 0);
      assert.notDeepEqual(afterBytes, bytes);
    }
    const finalBytes = Buffer.alloc(Number(after.size));
    readSync(fd, finalBytes, 0, finalBytes.length, 0);
    return { bytes: finalBytes, stats: after };
  } finally {
    closeSync(fd);
  }
}

test("modeled unchanged ctime permits real same-size owner token mutation evidence", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const controller = createGitPromotionHostControl(f.config);
  const owner = controller.acquire(randomUUID());
  const path = join(f.config.fencePath, "owner.json");
  const fd = openSync(path, "r");
  let before: fs.BigIntStats;
  let bytes: Buffer;
  try {
    before = fstatSync(fd, { bigint: true });
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const original = fs.fstatSync;
  let observations = 0;
  const observing = t.mock.method(
    fs,
    "fstatSync",
    (...args: Parameters<typeof fs.fstatSync>) => {
      const stats = original(...args);
      if (
        "ctimeNs" in stats &&
        stats.dev === before.dev &&
        stats.ino === before.ino
      ) {
        observations++;
        stats.ctimeNs = before.ctimeNs;
        stats.ctimeMs = before.ctimeMs;
        stats.ctime = before.ctime;
      }
      return stats;
    },
  );
  syncBuiltinESMExports();
  let evidence: ReturnType<typeof mutateOwner>;
  try {
    evidence = mutateOwner(path, "same-size-token");
  } finally {
    observing.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(observations >= 2);
  assert.equal(
    evidence.stats.ctimeNs,
    before.ctimeNs,
    "modeled metadata, not an NTFS claim",
  );
  assert.notEqual(evidence.stats.mtimeNs, before.mtimeNs);
  assert.equal(evidence.stats.size, before.size);
  assert.equal(evidence.stats.mode, before.mode);
  assert.equal(evidence.stats.nlink, before.nlink);
  assert.notDeepEqual(evidence.bytes, bytes);
  assert.ok(existsSync(f.config.fencePath));
  assert.throws(() => {
    controller.release(owner, { childrenQuiescent: true });
  }, /exact persisted owner/u);
  assert.deepEqual(snapshotFile(path), evidence.bytes);
});

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

function ownerDescriptorSnapshot(fd: number) {
  const stats = fstatSync(fd, { bigint: true });
  assert.ok(stats.isFile());
  const bytes = Buffer.alloc(Number(stats.size));
  assert.equal(readSync(fd, bytes, 0, bytes.length, 0), bytes.length);
  return { bytes, stats };
}
type OwnerDescriptorSnapshot = ReturnType<typeof ownerDescriptorSnapshot>;
function assertRestoredOwner(
  after: OwnerDescriptorSnapshot,
  before: OwnerDescriptorSnapshot,
) {
  assert.deepEqual(after.bytes, before.bytes);
  for (const field of [
    "dev",
    "ino",
    "size",
    "mode",
    "nlink",
    "uid",
    "gid",
    "birthtimeNs",
    "rdev",
  ] as const)
    assert.equal(
      after.stats[field],
      before.stats[field],
      `owner ${field} must be restored`,
    );
}
type RestoredOwnerMutation =
  "rewrite-identical" | "mode-restored" | "link-restored";
function mutateRestoredOwner(
  fd: number,
  path: string,
  alias: string,
  mutation: RestoredOwnerMutation,
  before: OwnerDescriptorSnapshot,
) {
  if (mutation === "rewrite-identical")
    assert.equal(
      writeSync(fd, before.bytes, 0, before.bytes.length, 0),
      before.bytes.length,
    );
  else if (mutation === "mode-restored") {
    fchmodSync(fd, process.platform === "win32" ? 0o444 : 0o644);
    assert.notEqual(fstatSync(fd, { bigint: true }).mode, before.stats.mode);
    fchmodSync(fd, Number(before.stats.mode & 0o777n));
  } else {
    // Only link creation needs the defined fixture path; observations and I/O stay on fd.
    linkSync(path, alias);
    try {
      assert.equal(
        fstatSync(fd, { bigint: true }).nlink,
        before.stats.nlink + 1n,
      );
    } finally {
      rmSync(alias);
    }
  }
  // Baselines use whole seconds so restoration is exact despite futimes' numeric API.
  futimesSync(
    fd,
    Number(before.stats.atimeMs) / 1000,
    Number(before.stats.mtimeMs) / 1000,
  );
  const after = ownerDescriptorSnapshot(fd);
  assertRestoredOwner(after, before);
  assert.equal(after.stats.mtimeNs, before.stats.mtimeNs);
  return after;
}
function pinOwnerMtime(fd: number) {
  const stats = fstatSync(fd, { bigint: true });
  futimesSync(
    fd,
    Number(stats.atimeMs) / 1000,
    Math.floor(Number(stats.mtimeMs) / 1000) - 10,
  );
  return ownerDescriptorSnapshot(fd);
}
async function exposesRestoredOwnerCtime(
  root: string,
  mutation: RestoredOwnerMutation,
) {
  const path = join(root, "owned ctime capability probe");
  const fd = openSync(path, "wx+", 0o600);
  try {
    writeSync(fd, Buffer.from("capability fixture"));
    const before = pinOwnerMtime(fd);
    for (let attempt = 0; attempt < 3; attempt++) {
      // Retry across coarse timestamp ticks, not a narrow release deadline.
      if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, 1100));
      const after = mutateRestoredOwner(
        fd,
        path,
        join(root, "probe alias"),
        mutation,
        before,
      );
      if (after.stats.ctimeNs !== before.stats.ctimeNs) return true;
    }
    return false;
  } finally {
    closeSync(fd);
    rmSync(path);
  }
}

for (const mutation of [
  "rewrite-identical",
  "mode-restored",
  "link-restored",
] as const) {
  test(`observable owner ctime-only metadata ${mutation} between release inspections retains owner and latch`, async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl(f.config);
    const owner = controller.acquire(randomUUID());
    if (!(await exposesRestoredOwnerCtime(f.host, mutation))) {
      t.skip(
        `Actual ${mutation} capability probe exposed no ctime drift with bytes/mtime/mode/size/nlink restored after three attempts across coarse timestamp ticks`,
      );
      return;
    }
    const path = join(f.config.fencePath, "owner.json");
    const fd = openSync(path, "r+");
    try {
      const before = pinOwnerMtime(fd);
      // Give coarse POSIX clocks an owned tick before the synchronous release observations.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      let observations = 0;
      let evidence: OwnerDescriptorSnapshot | undefined;
      const original = fs.lstatSync;
      const observing = t.mock.method(
        fs,
        "lstatSync",
        (...args: Parameters<typeof fs.lstatSync>) => {
          // Third owner lstat is the second inspect's initial snapshot, after inspect one completed.
          if (args[0] === path && ++observations === 3)
            evidence = mutateRestoredOwner(
              fd,
              path,
              join(f.host, "transient owner alias"),
              mutation,
              before,
            );
          return original(...args);
        },
      );
      syncBuiltinESMExports();
      try {
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /Fence changed before release/u);
      } finally {
        observing.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(observations, 4, "both full inspections must execute");
      assert.ok(evidence, "real restored-metadata mutation must have executed");
      const after = ownerDescriptorSnapshot(fd);
      assertRestoredOwner(after, before);
      assert.equal(
        after.stats.mtimeNs,
        before.stats.mtimeNs,
        "ctime-only case must restore mtime exactly",
      );
      assert.notEqual(after.stats.ctimeNs, before.stats.ctimeNs);
      assert.ok(existsSync(f.config.fencePath));
      assert.deepEqual(controller.query(), { status: "held", owner });
      assert.throws(() => controller.acquire(randomUUID()), /held/u);
    } finally {
      closeSync(fd);
    }
  });
}

for (const metadata of ["native", "modeled-unchanged-ctime"] as const) {
  test(`observable owner deterministic mtime between release inspections retains identical owner and latch (${metadata})`, async (t) => {
    const f = fixture(t);
    const { createGitPromotionHostControl } = await controlModule();
    const controller = createGitPromotionHostControl(f.config);
    const owner = controller.acquire(randomUUID());
    const path = join(f.config.fencePath, "owner.json");
    const fd = openSync(path, "r+");
    try {
      const before = pinOwnerMtime(fd);
      let observations = 0;
      let evidence: OwnerDescriptorSnapshot | undefined;
      const originalLstat = fs.lstatSync;
      const originalFstat = fs.fstatSync;
      function model(stats: fs.Stats | fs.BigIntStats | undefined) {
        if (
          metadata === "modeled-unchanged-ctime" &&
          stats &&
          "ctimeNs" in stats &&
          stats.dev === before.stats.dev &&
          stats.ino === before.stats.ino
        ) {
          stats.ctimeNs = before.stats.ctimeNs;
          stats.ctimeMs = before.stats.ctimeMs;
          stats.ctime = before.stats.ctime;
        }
        return stats;
      }
      const observing = t.mock.method(
        fs,
        "lstatSync",
        (...args: Parameters<typeof fs.lstatSync>) => {
          if (args[0] === path && ++observations === 3) {
            assert.equal(
              writeSync(fd, before.bytes, 0, before.bytes.length, 0),
              before.bytes.length,
            );
            futimesSync(
              fd,
              Number(before.stats.atimeMs) / 1000,
              Number(before.stats.mtimeMs) / 1000 + 1,
            );
            evidence = ownerDescriptorSnapshot(fd);
          }
          return model(originalLstat(...args));
        },
      );
      const descriptorStats = t.mock.method(
        fs,
        "fstatSync",
        (...args: Parameters<typeof fs.fstatSync>) =>
          model(originalFstat(...args)),
      );
      syncBuiltinESMExports();
      try {
        assert.throws(() => {
          controller.release(owner, { childrenQuiescent: true });
        }, /Fence changed before release/u);
      } finally {
        for (const mock of [observing, descriptorStats]) mock.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(observations, 4);
      assert.ok(
        evidence,
        "real rewrite and deterministic mtime advance must have executed",
      );
      assertRestoredOwner(evidence, before);
      assert.equal(
        evidence.stats.mtimeNs,
        before.stats.mtimeNs + 1_000_000_000n,
      );
      if (metadata === "modeled-unchanged-ctime")
        assert.equal(
          evidence.stats.ctimeNs,
          before.stats.ctimeNs,
          "modeled metadata, not an NTFS claim",
        );
      const after = ownerDescriptorSnapshot(fd);
      assertRestoredOwner(after, before);
      assert.equal(after.stats.mtimeNs, evidence.stats.mtimeNs);
      assert.ok(existsSync(f.config.fencePath));
      assert.deepEqual(controller.query(), { status: "held", owner });
      assert.throws(() => controller.acquire(randomUUID()), /held/u);
    } finally {
      closeSync(fd);
    }
  });
}

test("injected ctime-only owner snapshots between release inspections retain unchanged real owner and latch", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();
  const controller = createGitPromotionHostControl(f.config);
  const owner = controller.acquire(randomUUID());
  const path = join(f.config.fencePath, "owner.json");
  const fd = openSync(path, "r");
  try {
    const before = ownerDescriptorSnapshot(fd);
    let observations = 0;
    let injected = 0;
    const originalLstat = fs.lstatSync;
    const originalFstat = fs.fstatSync;
    function model(stats: fs.Stats | fs.BigIntStats | undefined) {
      if (
        observations >= 3 &&
        stats &&
        "ctimeNs" in stats &&
        stats.dev === before.stats.dev &&
        stats.ino === before.stats.ino
      ) {
        stats.ctimeNs += 1n;
        injected++;
      }
      return stats;
    }
    const observing = t.mock.method(
      fs,
      "lstatSync",
      (...args: Parameters<typeof fs.lstatSync>) => {
        if (args[0] === path) observations++;
        return model(originalLstat(...args));
      },
    );
    const descriptorStats = t.mock.method(
      fs,
      "fstatSync",
      (...args: Parameters<typeof fs.fstatSync>) =>
        model(originalFstat(...args)),
    );
    syncBuiltinESMExports();
    try {
      assert.throws(() => {
        controller.release(owner, { childrenQuiescent: true });
      }, /Fence changed before release/u);
    } finally {
      for (const mock of [observing, descriptorStats]) mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(observations, 4);
    assert.equal(
      injected,
      4,
      "second inspect's path and descriptor snapshots must agree",
    );
    const after = ownerDescriptorSnapshot(fd);
    assertRestoredOwner(after, before);
    assert.equal(after.stats.mtimeNs, before.stats.mtimeNs);
    assert.equal(
      after.stats.ctimeNs,
      before.stats.ctimeNs,
      "real metadata was unchanged; only the snapshot contract was injected",
    );
    assert.ok(existsSync(f.config.fencePath));
    assert.deepEqual(controller.query(), { status: "held", owner });
    assert.throws(() => controller.acquire(randomUUID()), /held/u);
  } finally {
    closeSync(fd);
  }
});

for (const target of ["metadata-pointer", "common-pointer"] as const) {
  for (const timing of ["available", "held"] as const) {
    test(
      `lossless physical paths reject late invalid-byte ${target} during all ${timing} operations without twin inspection`,
      { skip: !supportsInvalidBytePaths },
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

test("lossless physical paths reject invalid-byte paths via mocked realpathSync.native", async (t) => {
  const f = fixture(t);
  const { createGitPromotionHostControl } = await controlModule();

  const original = realpathSync.native;
  t.mock.method(
    realpathSync,
    "native",
    (p: fs.PathLike, options?: fs.EncodingOption) => {
      if (typeof p === "string" && p === f.config.repositoryPath) {
        return Buffer.concat([
          Buffer.from(f.config.repositoryPath),
          Buffer.from([0xff]),
        ]);
      }
      return original(p, options);
    },
  );

  assert.throws(() => createGitPromotionHostControl(f.config).query(), {
    name: "TypeError",
  });
});
