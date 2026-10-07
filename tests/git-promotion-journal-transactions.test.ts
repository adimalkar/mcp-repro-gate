import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { sha256 } from "../src/digest.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import type { PlanStore } from "../src/kernel.js";
import {
  firstOperator,
  fixture,
  noAttempt,
  observingPlans,
  raw,
  reserve,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each journal suite.

test("SQL constraints, permanent triggers and atomic direct raw-revoke guard", (t) => {
  const f = fixture(t);
  reserve(f);
  raw(f, (db) => {
    const row = db.prepare("SELECT * FROM git_promotion_attempts").get();
    assert.ok(row);
    const columns = Object.keys(row);
    const insert = db.prepare(
      `INSERT INTO git_promotion_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    const run = (changed: Record<string, string>) =>
      insert.run(...columns.map((key) => changed[key] ?? row[key] ?? null));
    const fresh = {
      attempt_id: randomUUID(),
      approval_id: randomUUID(),
      proposal_id: sha256("fresh"),
    };
    assert.throws(() => run({}), /permanent/u);
    const replace = db.prepare(
      `INSERT OR REPLACE INTO git_promotion_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    assert.throws(
      () => replace.run(...columns.map((key) => row[key] ?? null)),
      /permanent/u,
    );
    assert.throws(
      () => run({ ...fresh, state: "confirmed" }),
      /prepared|CHECK/u,
    );
    assert.throws(() => run({ ...fresh, record_json: "{}" }), /CHECK/u);
    assert.throws(
      () => run({ ...fresh, candidate_oid: "0".repeat(40) }),
      /CHECK/u,
    );
    assert.throws(
      () => run({ ...fresh, reserved_at: "9999-01-01T00:00:00.000Z" }),
      /CHECK/u,
    );
    assert.throws(() => {
      db.exec("UPDATE git_promotion_attempts SET state = 'failed'");
    }, /immutable/u);
    assert.throws(() => {
      db.exec("DELETE FROM git_promotion_attempts");
    }, /permanent/u);
    assert.throws(() => {
      db.exec("UPDATE git_change_approvals SET status = 'revoked'");
    }, /Unresolved/u);
    db.exec("BEGIN IMMEDIATE");
    const competing = new SqliteGitApprovalStore(":memory:");
    competing.close();
    db.exec("ROLLBACK");
  });
  assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
  f.assertProtected();
});

test("insert failure and deferred COMMIT failure roll back with no prepared success", (t) => {
  const f = fixture(t);
  raw(f, (db) => {
    db.exec(
      `CREATE TRIGGER inject_insert BEFORE INSERT ON git_promotion_attempts BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`,
    );
  });
  assert.throws(() => reserve(f), /injected failure/u);
  noAttempt(f);
  raw(f, (db) => {
    db.exec(
      `DROP TRIGGER inject_insert; CREATE TABLE parent_probe (id TEXT PRIMARY KEY); CREATE TABLE child_probe (id TEXT REFERENCES parent_probe(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER inject_commit AFTER INSERT ON git_promotion_attempts BEGIN INSERT INTO child_probe VALUES ('missing'); END;`,
    );
  });
  assert.throws(() => reserve(f), /FOREIGN KEY/u);
  noAttempt(f);
  raw(f, (db) => {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM child_probe").get()?.n,
      0,
    );
    db.exec("DROP TRIGGER inject_commit");
  });
  reserve(f);
  f.assertProtected();
});

test("T1 rechecks plan/key/time after precheck, with heavy Git work outside writer lock", (t) => {
  const f = fixture(t);
  let calls = 0;
  const plans = observingPlans(f.plans, (n) => {
    calls = n;
    if (n < 3)
      raw(f, (db) => {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;");
      });
    if (n === 3)
      raw(f, (db) => {
        db.exec("PRAGMA busy_timeout=0");
        assert.throws(() => {
          db.exec("BEGIN IMMEDIATE");
        }, /locked/u);
      });
  });
  reserve(f, { context: { ...f.context, plans } });
  assert.equal(calls, 3);
  f.assertProtected();
});
for (const drift of ["expiry", "key", "plan", "revocation"] as const) {
  test(`T1 ${drift} drift rejects without reservation`, (t) => {
    const f = fixture(t);
    const trust = structuredClone(f.trust);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const plans = observingPlans(f.plans, (n) => {
      if (drift === "revocation" && n === 2)
        assert.equal(f.store.revoke(f.approval.approvalId), true);
      if (n !== 3) return;
      if (drift === "expiry")
        t.mock.timers.setTime(Date.parse(f.approval.expiresAt));
      if (drift === "key") firstOperator(trust).key.enabled = false;
    });
    const finalPlans: PlanStore =
      drift === "plan"
        ? {
            save: (p) => {
              f.plans.save(p);
            },
            get: (() => {
              let n = 0;
              return (id: string) => (++n === 3 ? undefined : f.plans.get(id));
            })(),
          }
        : plans;
    assert.throws(() =>
      reserve(f, { trust, context: { ...f.context, plans: finalPlans } }),
    );
    noAttempt(f);
    f.assertProtected();
  });
}

test("corrupt/noncanonical journal cannot manufacture terminal evidence or bypass raw revoke", (t) => {
  const f = fixture(t);
  const record = reserve(f);
  raw(f, (db) => {
    db.exec(
      "DROP TRIGGER git_promotion_intent_immutable; PRAGMA ignore_check_constraints=ON",
    );
    db.prepare(
      "UPDATE git_promotion_attempts SET state = 'confirmed', record_json = ?",
    ).run(JSON.stringify({ ...record, state: "confirmed", quiescent: true }));
    assert.throws(() => f.store.getGitPromotionAttempt(f.prepared.attemptId));
    assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
    db.prepare(
      "UPDATE git_promotion_attempts SET state = 'prepared', record_json = ?",
    ).run(JSON.stringify(record, null, 1));
    assert.throws(
      () => f.store.getGitPromotionAttempt(f.prepared.attemptId),
      /canonical/u,
    );
    assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
    db.prepare("UPDATE git_promotion_attempts SET record_json = ?").run(
      canonicalJson(record),
    );
    db.prepare(
      "UPDATE git_promotion_attempts SET admission_deadline_epoch_ms = 1",
    ).run();
    assert.throws(
      () => f.store.getGitPromotionAttempt(f.prepared.attemptId),
      /column/u,
    );
    db.prepare(
      "UPDATE git_promotion_attempts SET admission_deadline_epoch_ms = ?",
    ).run(Date.parse(record.admissionDeadline));
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare(
      "UPDATE git_promotion_attempts SET approval_id = ?, proposal_id = ?",
    ).run(randomUUID(), sha256("broken linkage"));
    assert.throws(() => f.store.revoke(f.approval.approvalId), /Corrupt/u);
    db.prepare(
      "UPDATE git_promotion_attempts SET approval_id = ?, proposal_id = ?",
    ).run(record.approvalId, record.proposalId);
    db.exec("PRAGMA foreign_keys=ON");
  });
  assert.deepEqual(
    f.store.getGitPromotionAttempt(f.prepared.attemptId),
    record,
  );
  f.assertProtected();
});
