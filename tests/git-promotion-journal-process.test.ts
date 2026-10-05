import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  fixture,
  journalWorkerRegressionGuard,
  noAttempt,
  noJournalWaiters,
  reserve,
  startWorker,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each journal suite.

test("owned journal silent event wait times out and fixture cleanup reaps before deletion", async (t) => {
  const f = fixture(t);
  const w = startWorker(f, "silent", 100);
  t.after(() => {
    assert.ok(w.child.exitCode !== null || w.child.signalCode !== null);
    assert.equal(existsSync(f.scratch), false);
    noJournalWaiters(w, true);
  });
  await assert.rejects(
    journalWorkerRegressionGuard(w.wait("never")),
    /did not emit never/u,
  );
  noJournalWaiters(w);
  noAttempt(f);
  f.assertProtected();
});

test("owned journal exit before event rejects promptly with exit evidence", async (t) => {
  const f = fixture(t);
  const w = startWorker(f, "exit-before-event");
  await assert.rejects(
    journalWorkerRegressionGuard(w.wait("never")),
    /Worker exited before never: 17/u,
  );
  assert.equal((await journalWorkerRegressionGuard(w.closed)).code, 17);
  noJournalWaiters(w, true);
  noAttempt(f);
  f.assertProtected();
});

test("owned journal close wait times out before cleanup kills and reaps live worker", async (t) => {
  const f = fixture(t);
  const w = startWorker(f, "event-stall", 100);
  await w.wait("ready", 10_000);
  t.after(() => {
    assert.ok(w.child.exitCode !== null || w.child.signalCode !== null);
    assert.equal(existsSync(f.scratch), false);
    noJournalWaiters(w, true);
  });
  await assert.rejects(
    journalWorkerRegressionGuard(w.closed),
    /did not close/u,
  );
  assert.equal(w.child.exitCode, null);
  noJournalWaiters(w);
  noAttempt(f);
  f.assertProtected();
});

test("owned journal failed kill rejects without stale waiters and can be reaped afterward", async (t) => {
  const f = fixture(t);
  const w = startWorker(f, "event-stall");
  await w.wait("ready");
  const kill = t.mock.method(w.child, "kill", () => false);
  try {
    await assert.rejects(
      journalWorkerRegressionGuard(w.stop(100)),
      /could not be stopped/u,
    );
    noJournalWaiters(w);
  } finally {
    kill.mock.restore();
    await journalWorkerRegressionGuard(w.stop());
  }
  noJournalWaiters(w, true);
  noAttempt(f);
  f.assertProtected();
});

test("owned journal successful kill report without close has a bounded reap deadline", async (t) => {
  const f = fixture(t);
  const w = startWorker(f, "event-stall");
  await w.wait("ready");
  const kill = t.mock.method(w.child, "kill", () => true);
  try {
    await assert.rejects(
      journalWorkerRegressionGuard(w.stop(100)),
      /did not close/u,
    );
    assert.equal(w.child.exitCode, null);
    assert.equal(w.child.signalCode, null);
    noJournalWaiters(w);
  } finally {
    kill.mock.restore();
    await journalWorkerRegressionGuard(w.stop());
  }
  noJournalWaiters(w, true);
  noAttempt(f);
  f.assertProtected();
});

test("owned journal spawn error rejects without stale waits or a PID to kill", async (t) => {
  const f = fixture(t);
  const w = startWorker(
    f,
    "silent",
    10_000,
    join(f.scratch, "missing-owned-worker-executable"),
  );
  await assert.rejects(
    journalWorkerRegressionGuard(w.wait("never")),
    /ENOENT/u,
  );
  assert.equal(w.child.pid, undefined);
  await journalWorkerRegressionGuard(w.stop());
  noJournalWaiters(w, true);
  noAttempt(f);
  f.assertProtected();
});

test(
  "competing owned processes permanently consume exactly one approval",
  { timeout: 90_000 },
  async (t) => {
    const f = fixture(t);
    const workers = [startWorker(f, "reserve"), startWorker(f, "reserve")];
    const outcomes = await Promise.all(workers.map((w) => w.closed));
    assert.equal(outcomes.filter((r) => r.code === 0).length, 1);
    assert.equal(outcomes.filter((r) => r.code === 1).length, 1);
    const winner = workers
      .flatMap((w) => w.events)
      .find((e) => e.event === "reserved");
    assert.ok(winner);
    assert.deepEqual(
      f.store.getGitPromotionAttempt(f.prepared.attemptId),
      winner.record,
    );
    assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
    assert.equal(f.control.query().status, "held");
    f.assertProtected();
  },
);
for (const mode of ["before-commit", "after-commit"] as const) {
  test(
    `hard kill owned worker ${mode} retains fence and correct durable consumption`,
    { timeout: 90_000 },
    async (t) => {
      const f = fixture(t);
      const w = startWorker(f, mode);
      const message = await w.wait(
        mode === "before-commit" ? "before-commit" : "reserved",
      );
      if (mode === "before-commit") noAttempt(f);
      await w.stop();
      assert.equal(f.control.query().status, "held");
      if (mode === "before-commit") {
        noAttempt(f);
        assert.equal(f.store.revoke(f.approval.approvalId), true);
      } else {
        assert.deepEqual(
          f.store.getGitPromotionAttempt(f.prepared.attemptId),
          message.record,
        );
        assert.throws(
          () => f.store.revoke(f.approval.approvalId),
          /Unresolved/u,
        );
        assert.throws(() => reserve(f), /consumed/u);
      }
      f.assertProtected();
    },
  );
}
for (const drift of ["revocation", "expiry"] as const) {
  test(
    `blocked BEGIN IMMEDIATE rechecks ${drift} after waiting`,
    { timeout: 60_000 },
    async (t) => {
      const f = fixture(t);
      const w = startWorker(f, drift === "expiry" ? "wait-expiry" : "wait");
      await w.wait("prechecked");
      const db = new DatabaseSync(f.databasePath);
      try {
        db.exec("BEGIN IMMEDIATE");
        if (drift === "revocation")
          db.prepare(
            "UPDATE git_change_approvals SET status = 'revoked', revoked_at = ? WHERE approval_id = ?",
          ).run(new Date().toISOString(), f.approval.approvalId);
        w.child.stdin.write("x");
        await w.wait("beginning-t1");
        // Worker has reached the actual native writer-lock boundary, not merely
        // staging. Committing releases the lock; final proof is reloaded in T1.
        db.exec("COMMIT");
      } finally {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* committed */
        }
        db.close();
      }
      assert.equal((await w.closed).code, 1);
      assert.ok(w.events.some((e) => e.event === "rejected"));
      noAttempt(f);
      assert.equal(f.control.query().status, "held");
      f.assertProtected();
    },
  );
}
