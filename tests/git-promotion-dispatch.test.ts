import assert from "node:assert/strict";
import childProcess from "node:child_process";
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
