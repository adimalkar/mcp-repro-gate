import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { digestCanonical } from "../src/digest.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import { createGitChangeProposal } from "../src/git-change-proposal.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";
import { createGitPromotionHostControl } from "../src/git-promotion-host-control.js";
import {
  attemptCount,
  copyClosedLedger,
  fixture,
  modeledRawFilenameProbe,
  noAttempt,
  openObserved,
  rawFilenameSupported,
  request,
  reserve,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each journal suite.

test("modeled Windows malformed Buffer filename ENOENT is a narrowly supported capability skip", (t) => {
  const f = modeledRawFilenameProbe(t);
  const error = Object.assign(new Error("modeled raw filename rejection"), {
    code: "ENOENT",
  });
  const result = rawFilenameSupported(f.context, f.scratch, {
    platform: "win32",
    writeProbe: (path) => {
      if (Buffer.isBuffer(path)) {
        const control = join(f.scratch, "encoding-probe-valid");
        assert.equal(readFileSync(control, "utf8"), "probe");
        assert.deepEqual(
          realpathSync.native(control, { encoding: "buffer" }),
          Buffer.from(control),
        );
        assert.ok(statSync(f.scratch).isDirectory());
        throw error;
      }
      writeFileSync(path, "probe");
    },
  });
  assert.equal(result, false);
  assert.equal(f.skips.length, 1);
  assert.match(f.skips[0] ?? "", /ENOENT/u);
  assert.deepEqual(readdirSync(f.scratch), []);
});

for (const platform of ["linux", "darwin"] as const) {
  test(`modeled ${platform} malformed filename ENOENT remains an error`, (t) => {
    const f = modeledRawFilenameProbe(t);
    const error = Object.assign(new Error("modeled ordinary I/O failure"), {
      code: "ENOENT",
    });
    assert.throws(
      () =>
        rawFilenameSupported(f.context, f.scratch, {
          platform,
          writeProbe: (path) => {
            if (Buffer.isBuffer(path)) throw error;
            writeFileSync(path, "probe");
          },
        }),
      (caught) => caught === error,
    );
    assert.deepEqual(f.skips, []);
  });
}

for (const code of ["EACCES", "EIO"] as const) {
  test(`modeled Windows malformed filename ${code} remains an error`, (t) => {
    const f = modeledRawFilenameProbe(t);
    const error = Object.assign(new Error("modeled ordinary I/O failure"), {
      code,
    });
    assert.throws(
      () =>
        rawFilenameSupported(f.context, f.scratch, {
          platform: "win32",
          writeProbe: (path) => {
            if (Buffer.isBuffer(path)) throw error;
            writeFileSync(path, "probe");
          },
        }),
      (caught) => caught === error,
    );
    assert.deepEqual(f.skips, []);
  });
}

test("modeled Windows ordinary control-file ENOENT is never a capability skip", (t) => {
  const f = modeledRawFilenameProbe(t);
  const error = Object.assign(new Error("modeled missing ordinary control"), {
    code: "ENOENT",
  });
  assert.throws(
    () =>
      rawFilenameSupported(f.context, f.scratch, {
        platform: "win32",
        writeProbe: () => {
          throw error;
        },
      }),
    (caught) => caught === error,
  );
  assert.deepEqual(f.skips, []);
});

test("modeled Windows missing ordinary probe parent is never a capability skip", (t) => {
  const f = modeledRawFilenameProbe(t);
  assert.throws(
    () =>
      rawFilenameSupported(f.context, join(f.scratch, "missing-parent"), {
        platform: "win32",
      }),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.deepEqual(f.skips, []);
});

test("modeled Windows disappearing control after raw ENOENT remains an error", (t) => {
  const f = modeledRawFilenameProbe(t);
  assert.throws(
    () =>
      rawFilenameSupported(f.context, f.scratch, {
        platform: "win32",
        writeProbe: (path) => {
          if (Buffer.isBuffer(path)) {
            rmSync(join(f.scratch, "encoding-probe-valid"));
            throw Object.assign(new Error("modeled raw filename rejection"), {
              code: "ENOENT",
            });
          }
          writeFileSync(path, "probe");
        },
      }),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.deepEqual(f.skips, []);
});

test("modeled Windows invalid ordinary control roundtrip never classifies a raw filename", (t) => {
  const f = modeledRawFilenameProbe(t);
  let rawCalls = 0;
  assert.throws(
    () =>
      rawFilenameSupported(f.context, f.scratch, {
        platform: "win32",
        writeProbe: (path) => {
          if (Buffer.isBuffer(path)) {
            rawCalls++;
            throw Object.assign(new Error("modeled raw filename rejection"), {
              code: "ENOENT",
            });
          }
          // Model a control creation returning without creating the requested file.
          writeFileSync(path + "-different", "probe");
        },
      }),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(rawCalls, 0);
  assert.deepEqual(f.skips, []);
});

test("lossless model rejects malformed SQLite filename bytes before twin lookup", (t) => {
  const f = fixture(t);
  const twin = join(f.scratch, "modeled-\uFFFD.sqlite");
  copyClosedLedger(f, [twin]);
  const malformed = Buffer.concat([
    Buffer.from(f.scratch + "/modeled-"),
    Buffer.from([0xff]),
    Buffer.from(".sqlite"),
  ]);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the actual connection via call below.
  const prepare = DatabaseSync.prototype.prepare;
  const projection = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      // Model only SQLite's VFS filename projection, using a real SQL BLOB
      // result. This test runs even where raw filenames cannot be created.
      return prepare.call(
        this,
        sql ===
          "SELECT CAST(file AS BLOB) AS file FROM pragma_database_list WHERE name = 'main'"
          ? `SELECT X'${malformed.toString("hex")}' AS file`
          : sql,
      );
    },
  );
  let opened;
  try {
    opened = openObserved(t, f.databasePath);
  } finally {
    projection.mock.restore();
  }
  try {
    assert.equal(opened.store, undefined);
    assert.match(String(opened.error), /lossless|UTF-8/u);
    assert.equal(opened.closed.length, 1);
    assert.equal(attemptCount(f.databasePath), 0);
    assert.equal(attemptCount(twin), 0);
    assert.equal(f.control.query().status, "held");
  } finally {
    opened.store?.close();
  }
  f.assertProtected();
});

for (const layout of ["leaf", "ancestor"] as const) {
  for (const withTwin of [true, false]) {
    test(`lossless private connection rejects invalid-byte ${layout}, ${withTwin ? "with" : "without"} Unicode twin`, (t) => {
      const f = fixture(t);
      if (!rawFilenameSupported(t, f.scratch)) return;
      f.control.release(f.owner, { childrenQuiescent: true });
      const rawBase = Buffer.concat([
        Buffer.from(f.scratch + "/ledger-"),
        Buffer.from([0xff]),
      ]);
      const twinBase = join(f.scratch, "ledger-\uFFFD");
      const actual =
        layout === "leaf"
          ? Buffer.concat([rawBase, Buffer.from(".sqlite")])
          : Buffer.concat([rawBase, Buffer.from("/approvals.sqlite")]);
      const twin =
        layout === "leaf"
          ? twinBase + ".sqlite"
          : join(twinBase, "approvals.sqlite");
      if (layout === "ancestor") {
        mkdirSync(rawBase, { mode: 0o700 });
        if (withTwin) mkdirSync(twinBase, { mode: 0o700 });
      }
      copyClosedLedger(f, withTwin ? [actual, twin] : [actual]);
      const alias = join(f.scratch, "ledger-alias.sqlite");
      symlinkSync(actual, alias, "file");
      assert.deepEqual(
        realpathSync.native(alias, { encoding: "buffer" }),
        actual,
      );
      assert.throws(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(actual),
      );
      if (withTwin) {
        const a = statSync(actual, { bigint: true }),
          b = statSync(twin, { bigint: true });
        assert.notEqual(
          `${a.dev.toString()}:${a.ino.toString()}`,
          `${b.dev.toString()}:${b.ino.toString()}`,
        );
      }
      // Actual Node/SQLite connection facts: TEXT substitutes; SQL BLOB retains
      // the raw VFS filename, not caller spelling or a synthesized fixture value.
      const probe = new DatabaseSync(alias);
      try {
        assert.equal(probe.prepare("PRAGMA database_list").get()?.file, twin);
        const blob = probe
          .prepare(
            "SELECT CAST(file AS BLOB) AS file FROM pragma_database_list WHERE name='main'",
          )
          .get()?.file;
        assert.ok(blob instanceof Uint8Array);
        assert.deepEqual(Buffer.from(blob), actual);
      } finally {
        probe.close();
      }
      const config = {
        ...f.hostControl,
        approvalDatabasePath: withTwin ? twin : f.databasePath,
      };
      const control = createGitPromotionHostControl(config);
      const owner = control.acquire(f.prepared.attemptId);
      const beforeNames = readdirSync(f.scratch, { encoding: "buffer" });
      const opened = openObserved(t, alias);
      try {
        if (opened.store && withTwin) {
          // RED evidence on the original implementation: the first prepared
          // result claims the untouched twin; its canonical connection then
          // accepts the same signed approval/attempt/fence a second time.
          const wrong = opened.store.reserveGitPromotionFromPlan({
            ...request(f),
            hostControl: config,
            owner,
          });
          assert.equal(wrong.fenceOwner.approvalDatabasePath, twin);
          assert.equal(attemptCount(twin), 0);
          assert.equal(attemptCount(alias), 1);
          const canonical = new SqliteGitApprovalStore(twin);
          try {
            const duplicate = canonical.reserveGitPromotionFromPlan({
              ...request(f),
              hostControl: config,
              owner,
            });
            assert.equal(duplicate.approvalId, wrong.approvalId);
            assert.equal(duplicate.attemptId, wrong.attemptId);
          } finally {
            canonical.close();
          }
          assert.fail(
            "private connection prepared on wrong inode and canonical twin duplicated consumption",
          );
        }
        assert.equal(
          opened.store,
          undefined,
          "unrepresentable physical filename must reject before identity pinning",
        );
        assert.match(String(opened.error), /lossless|UTF-8/u);
        assert.equal(
          opened.closed.length,
          0,
          "invalid physical identity rejects before opening a private connection",
        );
        assert.deepEqual(
          readdirSync(f.scratch, { encoding: "buffer" }),
          beforeNames,
          "rejection creates no WAL/SHM sidecars",
        );
        assert.equal(attemptCount(alias), 0);
        assert.equal(attemptCount(f.databasePath), 0);
        if (withTwin) assert.equal(attemptCount(twin), 0);
        assert.equal(
          control.query().status,
          "held",
          "constructor rejection never deletes the held fence",
        );
      } finally {
        opened.store?.close();
      }
      f.assertProtected();
    });
  }
}

for (const name of ["canonical.sqlite", "valid-\uFFFD.sqlite"]) {
  test(`lossless private connection accepts ${name} and canonical aliases across reopen`, (t) => {
    const f = fixture(t);
    f.control.release(f.owner, { childrenQuiescent: true });
    const path = join(f.scratch, name);
    copyClosedLedger(f, [path]);
    const directoryAlias = join(f.scratch, "directory-alias");
    symlinkSync(
      f.scratch,
      directoryAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = join(directoryAlias, "connection-alias.sqlite");
    symlinkSync(path, alias, "file");
    const config = { ...f.hostControl, approvalDatabasePath: path };
    const control = createGitPromotionHostControl(config);
    const owner = control.acquire(f.prepared.attemptId);
    const store = new SqliteGitApprovalStore(alias);
    let record;
    try {
      record = store.reserveGitPromotionFromPlan({
        ...request(f),
        hostControl: config,
        owner,
      });
      assert.equal(
        record.fenceOwner.approvalDatabasePath,
        realpathSync.native(path),
      );
      assert.equal(attemptCount(path), 1);
      assert.equal(attemptCount(alias), 1);
    } finally {
      store.close();
    }
    const reopened = new SqliteGitApprovalStore(path);
    try {
      assert.deepEqual(
        reopened.getGitPromotionAttempt(f.prepared.attemptId),
        record,
      );
      assert.throws(
        () =>
          reopened.reserveGitPromotionFromPlan({
            ...request(f),
            hostControl: config,
            owner,
          }),
        /consumed/u,
      );
    } finally {
      reopened.close();
    }
    assert.equal(control.query().status, "held");
    f.assertProtected();
  });
}

test("lossless caller repository resolution rejects raw target rather than Unicode twin root", (t) => {
  const f = fixture(t, "approve", undefined, "repo-\uFFFD");
  if (!rawFilenameSupported(t, f.scratch)) return;
  const actual = Buffer.concat([
    Buffer.from(f.scratch + "/repo-"),
    Buffer.from([0xff]),
  ]);
  mkdirSync(actual);
  const alias = join(f.scratch, "repository-alias");
  symlinkSync(actual, alias, "dir");
  assert.equal(realpathSync.native(alias), f.root);
  assert.notEqual(
    statSync(actual, { bigint: true }).ino,
    statSync(f.root, { bigint: true }).ino,
  );
  assert.throws(
    () => reserve(f, { context: { ...f.context, repositoryPath: alias } }),
    /lossless|UTF-8/u,
  );
  noAttempt(f);
  assert.equal(f.control.query().status, "held");
  f.assertProtected();
});

for (const kind of ["memory", "relative"] as const) {
  test(`lossless binding keeps legacy V1 ${kind} grant/match/revoke but rejects promotion`, (t) => {
    const f = fixture(t);
    const path =
      kind === "memory"
        ? ":memory:"
        : relative(process.cwd(), join(f.scratch, "relative.sqlite"));
    const store = new SqliteGitApprovalStore(path);
    try {
      const proposal = createGitChangeProposal({
        repositoryPath: f.root,
        repositoryId: f.context.repositoryId,
        destinationRef: "refs/heads/source",
        patch: f.patch,
        allowedPaths: ["value.txt"],
        expiresAt: f.proposal.expiresAt,
        actionId: f.proposal.actionId,
        policyDigest: f.proposal.policyDigest,
      });
      const authority = {
        repositoryId: proposal.repositoryId,
        actionId: proposal.actionId,
        policyDigest: proposal.policyDigest,
        workspaceRootDigest: proposal.workspace.rootDigest,
        destinationRef: proposal.workspace.destinationRef,
        maxExpiresAt: proposal.expiresAt,
      };
      const check = {
        proposal,
        authority,
        repositoryPath: f.root,
        patch: f.patch,
      };
      const staged = stageGitChangeProposal(proposal, f.root, f.patch);
      const approval = store.grant({
        ...check,
        reviewedEffectDigest: digestCanonical(staged),
        expiresAt: f.approval.expiresAt,
      });
      assert.equal(
        store.matchesActiveApproval({
          ...check,
          approvalId: approval.approvalId,
        }),
        true,
      );
      assert.equal(store.revoke(approval.approvalId), true);
      assert.equal(store.revoke(approval.approvalId), false);
      assert.equal(
        store.matchesActiveApproval({
          ...check,
          approvalId: approval.approvalId,
        }),
        false,
      );
      assert.throws(
        () => store.reserveGitPromotionFromPlan(request(f)),
        /bound absolute disk ledger/u,
      );
    } finally {
      store.close();
    }
    noAttempt(f);
    f.assertProtected();
  });
}

// Windows SQLite can retain an alias spelling for WAL despite native realpath
// resolving the base inode. Model only that filesystem normalization; all SQL
// writes/readers below use the real SQLite engine and remain open concurrently.
test("canonical connection opening keeps real WAL writes visible across a modeled VFS alias", (t) => {
  const f = fixture(t);
  const canonical = join(f.scratch, "wal-canonical.sqlite");
  const alias = join(f.scratch, "wal-alias.sqlite");
  copyClosedLedger(f, [canonical]);
  linkSync(canonical, alias);
  assert.equal(
    statSync(canonical, { bigint: true }).ino,
    statSync(alias, { bigint: true }).ino,
  );
  const native = realpathSync.native;
  t.mock.method(
    realpathSync,
    "native",
    (...args: Parameters<typeof native>) => {
      const physical = native(...args);
      if (Buffer.isBuffer(physical))
        return physical.equals(Buffer.from(alias))
          ? Buffer.from(canonical)
          : physical;
      return physical === alias ? canonical : physical;
    },
  );
  const store = new SqliteGitApprovalStore(alias);
  try {
    assert.equal(store.revoke(f.approval.approvalId), true);
    const reader = new DatabaseSync(canonical);
    try {
      assert.equal(
        reader
          .prepare(
            "SELECT status FROM git_change_approvals WHERE approval_id = ?",
          )
          .get(f.approval.approvalId)?.status,
        "revoked",
      );
    } finally {
      reader.close();
    }
    assert.equal(
      readdirSync(f.scratch).includes("wal-alias.sqlite-wal"),
      false,
    );
  } finally {
    store.close();
  }
  f.assertProtected();
});

test("new disk ledger through a valid directory alias opens its canonical physical leaf", (t) => {
  const f = modeledRawFilenameProbe(t);
  const directory = join(f.scratch, "physical");
  mkdirSync(directory);
  const alias = join(f.scratch, "alias");
  symlinkSync(
    directory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const canonical = join(directory, "new-\uFFFD.sqlite");
  const store = new SqliteGitApprovalStore(join(alias, "new-\uFFFD.sqlite"));
  try {
    const reader = new DatabaseSync(canonical);
    try {
      assert.equal(
        reader
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'git_promotion_attempts'",
          )
          .get()?.n,
        1,
      );
    } finally {
      reader.close();
    }
    assert.ok(statSync(canonical).isFile());
  } finally {
    store.close();
  }
});

test("missing ordinary parent and dangling disk aliases fail before opening a private connection", (t) => {
  const f = modeledRawFilenameProbe(t);
  const target = join(f.scratch, "missing.sqlite");
  const dangling = join(f.scratch, "dangling.sqlite");
  symlinkSync(target, dangling, "file");
  for (const path of [
    join(f.scratch, "missing-parent", "db.sqlite"),
    dangling,
  ]) {
    const opened = openObserved(t, path);
    try {
      assert.equal(opened.store, undefined);
      assert.equal((opened.error as NodeJS.ErrnoException).code, "ENOENT");
      assert.equal(opened.closed.length, 0);
    } finally {
      opened.store?.close();
    }
  }
  assert.deepEqual(readdirSync(f.scratch), ["dangling.sqlite"]);
});
