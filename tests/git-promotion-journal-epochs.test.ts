import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import {
  fixture,
  linkedJournalProbe,
  request,
  reserve,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each journal suite.

for (const mismatch of [
  "all",
  "prechecked_epoch_ms",
  "reserved_epoch_ms",
  "admission_deadline_epoch_ms",
] as const) {
  test(`SQL epoch binding rejects ordered but incorrect ${mismatch} projections`, (t) => {
    const f = fixture(t);
    reserve(f);
    linkedJournalProbe(f, (db, row, insert) => {
      const changed = { ...row };
      if (mismatch === "all") {
        changed.prechecked_epoch_ms = 0;
        changed.reserved_epoch_ms = 1;
        changed.admission_deadline_epoch_ms = 2;
      } else {
        assert.equal(typeof row[mismatch], "number");
        changed[mismatch] =
          (row[mismatch] as number) +
          (mismatch === "prechecked_epoch_ms" ? -1 : 1);
      }
      assert.ok(
        Number(changed.prechecked_epoch_ms) <=
          Number(changed.reserved_epoch_ms),
      );
      assert.ok(
        Number(changed.reserved_epoch_ms) <
          Number(changed.admission_deadline_epoch_ms),
      );
      assert.throws(() => {
        insert(changed);
      }, /epoch.*canonical|canonical.*epoch/u);
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM git_promotion_attempts").get()?.n,
        0,
      );
      insert(row);
      assert.deepEqual(
        db.prepare("SELECT * FROM git_promotion_attempts").get(),
        row,
      );
    });
    f.assertProtected();
  });
}

for (const [column, field] of [
  ["prechecked_at", "precheckedAt"],
  ["reserved_at", "reservedAt"],
  ["admission_deadline", "admissionDeadline"],
] as const) {
  test(`SQL epoch binding fails closed for invalid/noncanonical ${field}`, (t) => {
    const f = fixture(t);
    reserve(f);
    linkedJournalProbe(f, (db, row, insert) => {
      for (const value of [
        "2026-02-30T00:00:00.000Z",
        "2026-13-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000+00:00",
        "+002026-01-01T00:00:00.000Z",
        "-000000-01-01T00:00:00.000Z",
        "+275760-09-13T00:00:00.001Z",
        "2026-01-01T00:00:00.000Z\n",
        "x".repeat(8192),
        null,
        0,
      ]) {
        const record = JSON.parse(row.record_json as string) as Record<
          string,
          unknown
        >;
        record[field] = value;
        assert.equal(
          db
            .prepare("SELECT reprogate_promotion_epoch_ms(?) AS epoch")
            .get(value)?.epoch,
          null,
        );
        assert.throws(() => {
          insert({
            ...row,
            [column]: value,
            record_json: canonicalJson(record),
          });
        }, /epoch.*canonical|canonical.*epoch/u);
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM git_promotion_attempts").get()
            ?.n,
          0,
        );
      }
      insert(row);
    });
    f.assertProtected();
  });
}

for (const times of [
  [
    "1970-01-01T00:00:01.001Z",
    "1970-01-01T00:00:01.003Z",
    "1970-01-01T00:00:01.005Z",
  ],
  [
    "1969-12-31T23:59:59.997Z",
    "1969-12-31T23:59:59.998Z",
    "1969-12-31T23:59:59.999Z",
  ],
  [
    "-000001-12-31T23:59:59.999Z",
    "0000-01-01T00:00:00.000Z",
    "0000-01-01T00:00:00.001Z",
  ],
  [
    "9999-12-31T23:59:59.999Z",
    "+010000-01-01T00:00:00.000Z",
    "+010000-01-01T00:00:00.001Z",
  ],
  [
    "-271821-04-20T00:00:00.000Z",
    "-271821-04-20T00:00:00.001Z",
    "-271821-04-20T00:00:00.002Z",
  ],
  [
    "+275760-09-12T23:59:59.998Z",
    "+275760-09-12T23:59:59.999Z",
    "+275760-09-13T00:00:00.000Z",
  ],
] as const) {
  test(`SQL epoch binding preserves exact millisecond projections at ${times[0]}`, (t) => {
    const f = fixture(t);
    reserve(f);
    linkedJournalProbe(f, (db, row, insert) => {
      // Projection-only compatibility probes, not authentication/admission.
      const record = JSON.parse(row.record_json as string) as Record<
        string,
        unknown
      >;
      const changed = { ...row };
      const fields = [
        "precheckedAt",
        "reservedAt",
        "admissionDeadline",
      ] as const;
      const columns = [
        "prechecked_at",
        "reserved_at",
        "admission_deadline",
      ] as const;
      const epochs = [
        "prechecked_epoch_ms",
        "reserved_epoch_ms",
        "admission_deadline_epoch_ms",
      ] as const;
      times.forEach((value, i) => {
        const field = fields[i],
          column = columns[i],
          epoch = epochs[i];
        assert.ok(field && column && epoch);
        const expected = Date.parse(value);
        assert.ok(Number.isSafeInteger(expected));
        assert.equal(new Date(expected).toISOString(), value);
        assert.equal(
          db
            .prepare("SELECT reprogate_promotion_epoch_ms(?) AS epoch")
            .get(value)?.epoch,
          expected,
        );
        record[field] = value;
        changed[column] = value;
        changed[epoch] = expected;
      });
      changed.record_json = canonicalJson(record);
      insert(changed);
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM git_promotion_attempts").get() },
        changed,
      );
    });
    f.assertProtected();
  });
}

test("SQL epoch binding is added on reopening an already-created journal table", (t) => {
  const f = fixture(t);
  const durable = reserve(f);
  linkedJournalProbe(f, (db, row, insert) => {
    // Model the unpublished pre-correction schema without rewriting its table.
    db.exec("DROP TRIGGER IF EXISTS git_promotion_epoch_bindings");
    const tableSql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='git_promotion_attempts'",
      )
      .get()?.sql;
    const path = db.prepare("PRAGMA database_list").get()?.file;
    assert.equal(typeof path, "string");
    new SqliteGitApprovalStore(path as string).close();
    assert.equal(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='git_promotion_attempts'",
        )
        .get()?.sql,
      tableSql,
    );
    assert.throws(() => {
      insert({
        ...row,
        prechecked_epoch_ms: 0,
        reserved_epoch_ms: 1,
        admission_deadline_epoch_ms: 2,
      });
    }, /epoch.*canonical|canonical.*epoch/u);
    insert(row);
  });
  f.store.close();
  const reopened = new SqliteGitApprovalStore(f.databasePath);
  try {
    assert.deepEqual(
      reopened.getGitPromotionAttempt(f.prepared.attemptId),
      durable,
    );
    assert.throws(
      () => reopened.reserveGitPromotionFromPlan(request(f)),
      /consumed/u,
    );
    assert.throws(() => reopened.revoke(f.approval.approvalId), /Unresolved/u);
  } finally {
    reopened.close();
  }
  f.assertProtected();
});

test("SQL epoch binding fails closed without its function or with untrusted schema", (t) => {
  const f = fixture(t);
  reserve(f);
  linkedJournalProbe(f, (db, row, insert) => {
    const path = db.prepare("PRAGMA database_list").get()?.file;
    assert.equal(typeof path, "string");
    const unregistered = new DatabaseSync(path as string);
    try {
      unregistered.exec("PRAGMA foreign_keys=ON");
      const columns = Object.keys(row);
      assert.throws(
        () =>
          unregistered
            .prepare(
              `INSERT INTO git_promotion_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            )
            .run(...columns.map((key) => row[key] ?? null)),
        /no such function: reprogate_promotion_epoch_ms/u,
      );
      assert.equal(
        unregistered
          .prepare("SELECT count(*) AS n FROM git_promotion_attempts")
          .get()?.n,
        0,
      );
    } finally {
      unregistered.close();
    }
    db.exec("PRAGMA trusted_schema=OFF");
    assert.throws(() => {
      insert(row);
    }, /unsafe use of reprogate_promotion_epoch_ms/u);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM git_promotion_attempts").get()?.n,
      0,
    );
    db.exec("PRAGMA trusted_schema=ON");
    insert(row);
  });
  f.assertProtected();
});
