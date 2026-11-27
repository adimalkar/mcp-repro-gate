import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { canonicalJson } from "../src/canonical-json.js";
import type { PromoteGitPromotionAttemptInput } from "../src/git-approval-store.js";
import { startGateWorker } from "./helpers/git-promotion-gate-worker.js";
import {
  fixture,
  git,
  observingPlans,
  raw,
  reserve,
} from "./helpers/git-promotion-journal.js";

// What happens between the durable admission and the outcome. Keep cases
// sequential within this file; Node isolates each suite.

type Fixture = ReturnType<typeof fixture>;

function promote(
  f: Fixture,
  overrides: Partial<PromoteGitPromotionAttemptInput> = {},
) {
  return f.store.promoteGitPromotionAttempt({
    attemptId: f.prepared.attemptId,
    context: f.context,
    trust: f.trust,
    hostControl: f.hostControl,
    owner: f.owner,
    ...overrides,
  });
}
function recover(f: Fixture) {
  return f.store.recoverGitPromotionAttempt({
    attemptId: f.prepared.attemptId,
    hostControl: f.hostControl,
    acknowledgement: { childrenQuiescent: true },
  });
}
function target(f: Fixture): string {
  return git(f.root, "rev-parse", "refs/heads/target").toString().trim();
}
function status(f: Fixture) {
  return f.store.getGitPromotionStatus(f.prepared.attemptId);
}

/**
 * In-process hooks on this process's SQLite boundary, installed just before
 * promote: once after the admission COMMIT (the first COMMIT of the call),
 * and on every statement prepared after it.
 */
function hooks(
  t: TestContext,
  on: {
    afterAdmission?: () => void;
    prepare?: (sql: string) => void;
  },
) {
  const exec: (this: DatabaseSync, sql: string) => void = Reflect.get(
    DatabaseSync.prototype,
    "exec",
  );
  const prepare: (
    this: DatabaseSync,
    sql: string,
  ) => ReturnType<DatabaseSync["prepare"]> = Reflect.get(
    DatabaseSync.prototype,
    "prepare",
  );
  let admitted = false;
  let inside = false;
  const guarded = (run: () => void) => {
    if (inside) return;
    inside = true;
    try {
      run();
    } finally {
      inside = false;
    }
  };
  t.mock.method(
    DatabaseSync.prototype,
    "exec",
    function (this: DatabaseSync, sql: string) {
      exec.call(this, sql);
      if (sql === "COMMIT" && !admitted && !inside) {
        admitted = true;
        if (on.afterAdmission) guarded(on.afterAdmission);
      }
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      if (admitted && on.prepare) guarded(() => on.prepare?.(sql));
      return prepare.call(this, sql);
    },
  );
}

test("an outcome recorded while the promoter stalled prevents dispatch", (t) => {
  const f = fixture(t);
  reserve(f);
  hooks(t, {
    // Recovery committed its outcome; the fence is not yet released.
    afterAdmission: () => {
      const record = {
        outcomeVersion: 1,
        attemptId: f.prepared.attemptId,
        state: "indeterminate",
        reason: "interrupted",
        decidedAt: new Date(Date.now() + 1000).toISOString(),
        observedDestinationOid: f.prepared.expectedOldOid,
      };
      raw(f, (db) =>
        db
          .prepare(
            "INSERT INTO git_promotion_outcomes (attempt_id, state, reason, observed_oid, record_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            record.attemptId,
            record.state,
            record.reason,
            record.observedDestinationOid,
            canonicalJson(record),
          ),
      );
    },
  });
  assert.throws(
    () => promote(f),
    (error: Error) =>
      error.message.includes("outcome uncertain") &&
      (error.cause as Error).message.includes("resolved before dispatch"),
  );
  t.mock.restoreAll();
  assert.equal(target(f), f.prepared.expectedOldOid);
  assert.equal(status(f)?.outcome?.reason, "interrupted");
});

for (const change of ["policy", "operator trust"] as const) {
  test(`dispatch reauthenticates changed ${change} after durable admission`, (t) => {
    const f = fixture(t);
    reserve(f);
    hooks(t, {
      afterAdmission: () => {
        if (change === "policy")
          f.context.currentPolicy.defaults.local_write = "deny";
        else f.trust.operators = [];
      },
    });
    const result = promote(f);
    assert.equal(result.status.state, "indeterminate");
    assert.equal(result.status.outcome?.reason, "not_dispatched");
    assert.ok(result.status.admission);
    assert.equal(target(f), f.prepared.expectedOldOid);
    assert.equal(result.fence, "retained");
    assert.throws(() => promote(f), /admitted or resolved/u);
  });
}

test("the SQLite writer excludes a competing writer during the dispatch authorization check", (t) => {
  const f = fixture(t);
  reserve(f);
  let checked = false;
  const result = promote(f, {
    context: {
      ...f.context,
      plans: observingPlans(f.plans, (n) => {
        if (n === 3) {
          raw(f, (db) => {
            db.exec("PRAGMA busy_timeout = 0");
            assert.throws(() => {
              db.exec("BEGIN IMMEDIATE");
            }, /locked/u);
          });
          checked = true;
        }
      }),
    },
  });
  assert.ok(checked);
  assert.equal(result.status.state, "confirmed");
});

test("a deadline passed after admission is not dispatched", (t) => {
  const f = fixture(t);
  reserve(f);
  const deadline = Date.parse(f.approval.expiresAt);
  hooks(t, {
    afterAdmission: () => {
      t.mock.method(Date, "now", () => deadline);
    },
  });
  const result = promote(f);
  t.mock.restoreAll();
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "not_dispatched");
  assert.equal(
    result.status.outcome.observedDestinationOid,
    f.prepared.expectedOldOid,
  );
  assert.equal(result.fence, "retained");
  assert.equal(target(f), f.prepared.expectedOldOid);
  assert.equal(recover(f).fence, "released");
});

test("a destination checked out after admission is not dispatched", (t) => {
  const f = fixture(t);
  reserve(f);
  hooks(t, {
    afterAdmission: () => {
      git(
        f.root,
        "worktree",
        "add",
        "--quiet",
        join(f.scratch, "late"),
        "target",
      );
    },
  });
  const result = promote(f);
  t.mock.restoreAll();
  assert.equal(result.status.outcome?.reason, "not_dispatched");
  assert.equal(target(f), f.prepared.expectedOldOid);
});

test("a fence lost after admission stops the dispatch", (t) => {
  const f = fixture(t);
  reserve(f);
  hooks(t, {
    afterAdmission: () => {
      f.control.release(f.owner, { childrenQuiescent: true });
    },
  });
  assert.throws(() => promote(f), /outcome uncertain/u);
  t.mock.restoreAll();
  assert.equal(target(f), f.prepared.expectedOldOid);
  const current = status(f);
  assert.ok(current?.admission);
  assert.equal(current.outcome, undefined);
});

test("a source moved during dispatch is a readback mismatch, never confirmed", (t) => {
  const f = fixture(t);
  reserve(f);
  const moved = git(
    f.root,
    "commit-tree",
    "-p",
    "HEAD",
    "-m",
    "moved",
    "HEAD^{tree}",
  )
    .toString()
    .trim();
  let reads = 0;
  hooks(t, {
    // The second status read in the dispatch transaction follows update-ref.
    prepare: (sql) => {
      if (sql.includes("LEFT JOIN git_promotion_admissions") && ++reads === 2)
        git(f.root, "update-ref", "refs/heads/source", moved);
    },
  });
  const result = promote(f);
  t.mock.restoreAll();
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "readback_mismatch");
  assert.equal(
    result.status.outcome.observedDestinationOid,
    f.prepared.candidateCommitOid,
  );
  assert.equal(result.fence, "retained");
});

test("a failed outcome write after update-ref leaves recovery to decide", (t) => {
  const f = fixture(t);
  reserve(f);
  hooks(t, {
    prepare: (sql) => {
      if (sql.startsWith("INSERT INTO git_promotion_outcomes"))
        throw new Error("injected outcome write failure");
    },
  });
  assert.throws(() => promote(f), /outcome uncertain/u);
  t.mock.restoreAll();
  assert.equal(target(f), f.prepared.candidateCommitOid);
  assert.equal(status(f)?.outcome, undefined);
  assert.equal(f.control.query().status, "held");
  const recovered = recover(f);
  assert.equal(recovered.status.outcome?.reason, "interrupted");
  assert.equal(
    recovered.status.outcome.observedDestinationOid,
    f.prepared.candidateCommitOid,
  );
  assert.equal(recovered.fence, "released");
});

test("a clock stepped back behind the reservation still records valid times", (t) => {
  const f = fixture(t);
  reserve(f);
  const reservedAt = Date.parse(
    status(f)?.attempt.reservedAt ?? "1970-01-01T00:00:00.000Z",
  );
  // Behind the reservation, but not before the review was issued (which
  // authentication would rightly reject).
  const issuedAt = Date.parse(f.review.payload.issuedAt);
  assert.ok(issuedAt < reservedAt);
  const stepped = issuedAt + Math.floor((reservedAt - issuedAt) / 2);
  const result = promote(f, {
    context: {
      ...f.context,
      plans: observingPlans(f.plans, (n) => {
        if (n === 2) t.mock.method(Date, "now", () => stepped);
      }),
    },
  });
  t.mock.restoreAll();
  assert.equal(
    result.status.state,
    "confirmed",
    JSON.stringify(result.status.outcome),
  );
  assert.equal(
    result.status.admission?.admittedAt,
    result.status.attempt.reservedAt,
  );
  assert.equal(
    canonicalJson(status(f)),
    canonicalJson(result.status),
    "strict readback accepts the floored times",
  );
});

test("a worker killed after update-ref recovers as interrupted on the candidate", async (t) => {
  const f = fixture(t);
  reserve(f);
  const worker = startGateWorker(f, "after-update-ref");
  await worker.waitFor("dispatched");
  await worker.kill();
  assert.equal(target(f), f.prepared.candidateCommitOid);
  assert.equal(status(f)?.outcome, undefined);
  const result = recover(f);
  assert.equal(result.status.outcome?.reason, "interrupted");
  assert.equal(
    result.status.outcome.observedDestinationOid,
    f.prepared.candidateCommitOid,
  );
  assert.equal(result.fence, "released");
});

test("recovery observes a destination that moved from base to candidate and back", async (t) => {
  const f = fixture(t);
  reserve(f);
  const base = f.prepared.expectedOldOid;
  const candidate = f.prepared.candidateCommitOid;
  assert.equal(target(f), base);
  const worker = startGateWorker(f, "after-update-ref");
  await worker.waitFor("dispatched");
  await worker.kill();
  assert.equal(target(f), candidate);
  // Model the history independently of the journal. Recovery only sees base.
  git(f.root, "update-ref", "refs/heads/target", base, candidate);
  const history = () =>
    git(
      f.root,
      "reflog",
      "show",
      "--format=%H",
      "refs/heads/target",
    ).toString();
  const before = history();
  assert.deepEqual(before.trim().split(/\r?\n/u).slice(0, 3), [
    base,
    candidate,
    base,
  ]);
  assert.equal(status(f)?.outcome, undefined);
  const result = recover(f);
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "interrupted");
  assert.equal(result.status.outcome.observedDestinationOid, base);
  assert.equal(target(f), base);
  assert.equal(history(), before);
  assert.equal(result.fence, "released");
  assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
});

test("a live Git updater can outlast the promoter while the fence remains held", async (t) => {
  const f = fixture(t);
  reserve(f);
  const worker = startGateWorker(f, "after-admission");
  await worker.waitFor("admitted");
  // The test owns this independent Git process so it can actually reap it.
  // It models a surviving writer without leaving an orphan for the OS to clean up.
  const updater = childProcess.spawn(
    "git",
    ["-C", f.root, "update-ref", "--stdin"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 90_000,
      killSignal: "SIGKILL",
    },
  );
  const closed = new Promise<number | null>((resolve) =>
    updater.once("close", resolve),
  );
  let output = "";
  updater.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  try {
    await once(updater, "spawn");
    await worker.kill();
    assert.equal(updater.exitCode, null);
    assert.equal(updater.signalCode, null);
    assert.ok(status(f)?.admission);
    assert.throws(
      () =>
        f.store.recoverGitPromotionAttempt({
          attemptId: f.prepared.attemptId,
          hostControl: f.hostControl,
          acknowledgement: { childrenQuiescent: false } as unknown as {
            childrenQuiescent: true;
          },
        }),
      /quiescence/u,
    );
    assert.deepEqual(f.control.query(), { status: "held", owner: f.owner });
    assert.throws(() => f.control.acquire(randomUUID()), /held/u);
    assert.equal(status(f)?.outcome, undefined);
    // After the promoter dies the updater can still prepare a transaction.
    // Abort and wait for its actual exit before asserting quiescence.
    updater.stdin.end(
      `start\nverify refs/heads/target ${f.prepared.expectedOldOid}\nprepare\nabort\n`,
    );
    assert.equal(await closed, 0);
    assert.deepEqual(output.trim().split(/\r?\n/u), [
      "start: ok",
      "prepare: ok",
      "abort: ok",
    ]);
  } finally {
    if (updater.exitCode === null && updater.signalCode === null)
      updater.kill("SIGKILL");
    await closed;
  }
  const result = recover(f);
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "interrupted");
  assert.equal(result.fence, "released");
  assert.equal(target(f), f.prepared.expectedOldOid);
});

test("a worker killed after its outcome keeps it; recovery only releases", async (t) => {
  const f = fixture(t);
  reserve(f);
  const worker = startGateWorker(f, "after-outcome");
  await worker.waitFor("decided");
  await worker.kill();
  const decided = status(f);
  assert.equal(decided?.state, "confirmed");
  assert.equal(f.control.query().status, "held");
  const result = recover(f);
  assert.equal(canonicalJson(result.status), canonicalJson(decided));
  assert.equal(result.fence, "released");
});

test("two promoters racing for one attempt dispatch exactly once", async (t) => {
  const f = fixture(t);
  reserve(f);
  const first = startGateWorker(f, "run");
  const second = startGateWorker(f, "run");
  const runs = await Promise.all([first.finished, second.finished]);
  const events = runs.map((run) =>
    run.output.includes('{"event":"returned"}') ? "returned" : "rejected",
  );
  assert.deepEqual(
    events.sort(),
    ["rejected", "returned"],
    JSON.stringify(runs),
  );
  assert.equal(target(f), f.prepared.candidateCommitOid);
  assert.equal(status(f)?.state, "confirmed");
});

test("a ledger read failure at the locked gate records nothing", (t) => {
  const f = fixture(t);
  reserve(f);
  const prepare: (
    this: DatabaseSync,
    sql: string,
  ) => ReturnType<DatabaseSync["prepare"]> = Reflect.get(
    DatabaseSync.prototype,
    "prepare",
  );
  let reads = 0;
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      // The first approval read is the unlocked precheck; the second is the
      // locked admission check.
      if (sql.includes("FROM git_operator_review_decisions") && ++reads === 2)
        throw Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
        });
      return prepare.call(this, sql);
    },
  );
  assert.throws(() => promote(f), /database is locked/u);
  t.mock.restoreAll();
  const current = status(f);
  assert.equal(current?.state, "prepared");
  assert.equal(current.admission, undefined);
  assert.equal(current.outcome, undefined);
  // Nothing was consumed by the transient failure: the gate runs again.
  assert.equal(promote(f).status.state, "confirmed");
});

test("a Git timeout at the locked gate records nothing", (t) => {
  const f = fixture(t);
  reserve(f);
  const original = childProcess.spawnSync;
  let calls = 0;
  // The first symbolic-ref is the unlocked precheck, the second the locked
  // recheck: make Git time out there.
  childProcess.spawnSync = ((command: string, args: string[], options) => {
    if (args.includes("symbolic-ref") && ++calls === 2)
      return {
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error("spawnSync git ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
      };
    return original(command, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => promote(f),
      /Source HEAD must be a symbolic local branch/u,
    );
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
  const current = status(f);
  assert.equal(current?.state, "prepared");
  assert.equal(current.outcome, undefined);
  assert.equal(promote(f).status.state, "confirmed");
});

for (const observation of [
  "read error",
  "missing",
  "different bytes",
] as const) {
  test(`locked candidate verification handles ${observation}`, (t) => {
    const f = fixture(t);
    reserve(f);
    const original = childProcess.spawnSync;
    const oid = f.prepared.candidateCommitOid;
    let commitReads = 0;
    childProcess.spawnSync = ((command: string, args: string[], options) => {
      const result = original(command, args, options);
      if (
        args.includes("cat-file") &&
        args.at(-1) === oid &&
        ++commitReads === 2
      ) {
        if (observation === "different bytes")
          return {
            ...result,
            stdout: Buffer.from("invalid candidate bytes\n"),
          };
        return {
          ...result,
          status: 128,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }
      if (observation === "missing" && args.at(-1) === "--batch-check")
        return {
          ...result,
          stdout: Buffer.from(
            `${oid} missing\n${f.prepared.candidateTreeOid} tree 123\n`,
          ),
        };
      return result;
    }) as typeof childProcess.spawnSync;
    syncBuiltinESMExports();
    try {
      if (observation === "different bytes") {
        const result = promote(f);
        assert.equal(result.status.outcome?.reason, "candidate_rejected");
        assert.equal(result.status.state, "failed");
      } else {
        assert.throws(
          () => promote(f),
          observation === "missing"
            ? /is missing from the repository/u
            : /nonzero command result/u,
        );
      }
      assert.equal(commitReads, 2);
    } finally {
      childProcess.spawnSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(target(f), f.prepared.expectedOldOid);
    if (observation !== "different bytes") {
      assert.equal(status(f)?.state, "prepared");
      assert.equal(status(f)?.admission, undefined);
      assert.equal(status(f)?.outcome, undefined);
      assert.deepEqual(f.control.query(), { status: "held", owner: f.owner });
      assert.equal(promote(f).status.state, "confirmed");
    }
  });
}
