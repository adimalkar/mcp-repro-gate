import assert from "node:assert/strict";
import fs, {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readBoundedRegularFile } from "../src/git-review-config.js";

function fixture(t: TestContext, bytes = "fixture-only bytes") {
  const root = mkdtempSync(join(tmpdir(), "reprogate bounded reader "));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, "fixture.bin");
  writeFileSync(path, bytes, { mode: 0o600 });
  return { root, path, bytes: Buffer.from(bytes) };
}

for (const mutation of [
  "truncate",
  "same-length",
  "mode",
  "hardlink",
  "grow-within-bound",
  "grow-over-bound",
] as const) {
  test(`bounded descriptor reader rejects real ${mutation} mutation after copying bytes`, (t) => {
    const f = fixture(t);
    const before = lstatSync(f.path, { bigint: true });
    const original = fs.readSync;
    let mutated = false;
    let chunk: Uint8Array | undefined;
    const reading = t.mock.method(
      fs,
      "readSync",
      (...args: Parameters<typeof fs.readSync>) => {
        const count = original(...args);
        if (count > 0 && !mutated) {
          assert.ok(args[1] instanceof Uint8Array);
          chunk = args[1];
          mutated = true;
          if (mutation === "truncate") writeFileSync(f.path, "{");
          if (mutation === "same-length")
            writeFileSync(f.path, Buffer.alloc(f.bytes.length, 0x78));
          if (mutation === "mode")
            chmodSync(f.path, process.platform === "win32" ? 0o444 : 0o644);
          if (mutation === "hardlink") linkSync(f.path, join(f.root, "alias"));
          if (mutation.startsWith("grow-"))
            writeFileSync(
              f.path,
              Buffer.alloc(mutation === "grow-over-bound" ? 65 : 32, 0x78),
            );
          const after = lstatSync(f.path, { bigint: true });
          assert.equal(after.dev, before.dev);
          assert.equal(after.ino, before.ino);
          assert.notEqual(after.ctimeNs, before.ctimeNs);
          if (mutation === "same-length") {
            assert.equal(after.size, before.size);
            assert.notDeepEqual(readFileSync(f.path), f.bytes);
          }
        }
        return count;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => readBoundedRegularFile(f.path, 64, "Fixture"),
        mutation === "grow-over-bound"
          ? /exceeds the 64 byte limit/u
          : /changed|regular/u,
      );
    } finally {
      reading.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(mutated, true);
    assert.ok(chunk);
    assert.ok(
      chunk.every((byte) => byte === 0),
      "read scratch must be erased on rejection",
    );
  });
}

for (const field of [
  "dev",
  "ino",
  "size",
  "mode",
  "nlink",
  "uid",
  "gid",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs",
  "rdev",
  "type",
] as const) {
  test(`bounded descriptor reader rejects final observed ${field} drift`, (t) => {
    const f = fixture(t);
    const original = fs.fstatSync;
    let observations = 0;
    const observing = t.mock.method(
      fs,
      "fstatSync",
      (...args: Parameters<typeof fs.fstatSync>) => {
        const stats = original(...args);
        if (++observations === 2) {
          assert.equal(typeof stats.size, "bigint");
          const changed = stats as fs.BigIntStats;
          if (field === "type") changed.isFile = () => false;
          else changed[field] += 1n;
        }
        return stats;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => readBoundedRegularFile(f.path, 64, "Fixture"),
        /changed|regular/u,
      );
    } finally {
      observing.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(observations, 2);
  });
}

test("bounded descriptor reader accepts stable exact/empty bounds and ignores atime-only changes", (t) => {
  const f = fixture(t);
  const original = fs.fstatSync;
  let observations = 0;
  let verifications = 0;
  const observing = t.mock.method(
    fs,
    "fstatSync",
    (...args: Parameters<typeof fs.fstatSync>) => {
      const stats = original(...args);
      if (++observations % 2 === 0) {
        const changed = stats as fs.BigIntStats;
        changed.atimeNs += 1_000_000_000n;
        changed.atimeMs += 1000n;
        changed.atime = new Date(changed.atime.getTime() + 1000);
      }
      return stats;
    },
  );
  syncBuiltinESMExports();
  try {
    assert.deepEqual(
      readBoundedRegularFile(f.path, f.bytes.length, "Fixture", {
        verify: (stats) => {
          assert.ok(stats.isFile());
          verifications++;
        },
      }),
      f.bytes,
    );
    assert.equal(verifications, 2);
    writeFileSync(f.path, "");
    assert.deepEqual(
      readBoundedRegularFile(f.path, 0, "Fixture"),
      Buffer.alloc(0),
    );
    assert.equal(observations, 4);
  } finally {
    observing.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const failure of [
  "post-stat",
  "post-verify",
  "read",
  "allocation",
] as const) {
  test(`bounded descriptor reader closes and erases scratch on ${failure} failure`, (t) => {
    const f = fixture(t);
    const originalOpen = fs.openSync;
    const originalStat = fs.fstatSync;
    const originalRead = fs.readSync;
    const originalAlloc = Buffer.alloc.bind(Buffer);
    let descriptor: number | undefined;
    let observations = 0;
    let verifications = 0;
    let chunk: Uint8Array | undefined;
    const opening = t.mock.method(
      fs,
      "openSync",
      (...args: Parameters<typeof fs.openSync>) => {
        descriptor = originalOpen(...args);
        return descriptor;
      },
    );
    const observing = t.mock.method(
      fs,
      "fstatSync",
      (...args: Parameters<typeof fs.fstatSync>) => {
        if (++observations === 2 && failure === "post-stat")
          throw new Error("Fixture stat failure");
        return originalStat(...args);
      },
    );
    const reading = t.mock.method(
      fs,
      "readSync",
      (...args: Parameters<typeof fs.readSync>) => {
        assert.ok(args[1] instanceof Uint8Array);
        chunk = args[1];
        const count = originalRead(...args);
        if (failure === "read") throw new Error("Fixture read failure");
        return count;
      },
    );
    const allocating = t.mock.method(
      Buffer,
      "alloc",
      (...args: Parameters<typeof Buffer.alloc>) => {
        if (failure === "allocation")
          throw new Error("Fixture allocation failure");
        return originalAlloc(...args);
      },
    );
    syncBuiltinESMExports();
    let error: unknown;
    try {
      readBoundedRegularFile(f.path, 64, "Fixture", {
        verify() {
          if (++verifications === 2 && failure === "post-verify")
            throw new Error("Fixture verify failure");
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      for (const mock of [opening, observing, reading, allocating])
        mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(descriptor !== undefined);
    // Check and close a leaked descriptor even in the RED run.
    let leaked = false;
    try {
      fstatSync(descriptor);
      leaked = true;
    } catch {
      /* Closed as required. */
    } finally {
      if (leaked) closeSync(descriptor);
    }
    assert.ok(error instanceof Error);
    assert.equal(
      leaked,
      false,
      "every post-open failure must close the descriptor",
    );
    if (chunk) assert.ok(chunk.every((byte) => byte === 0));
  });
}

test("bounded descriptor reader rejects invalid bounds before opening a file", (t) => {
  const f = fixture(t);
  const original = fs.openSync;
  let opens = 0;
  const descriptors: number[] = [];
  const opening = t.mock.method(
    fs,
    "openSync",
    (...args: Parameters<typeof fs.openSync>) => {
      opens++;
      const fd = original(...args);
      descriptors.push(fd);
      return fd;
    },
  );
  syncBuiltinESMExports();
  try {
    for (const bound of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])
      assert.throws(
        () => readBoundedRegularFile(f.path, bound, "Fixture"),
        /bound|limit/u,
      );
  } finally {
    opening.mock.restore();
    syncBuiltinESMExports();
    for (const fd of descriptors) {
      try {
        closeSync(fd);
      } catch {
        /* Close any RED-run leaks; others are already closed. */
      }
    }
  }
  assert.equal(opens, 0);
});
