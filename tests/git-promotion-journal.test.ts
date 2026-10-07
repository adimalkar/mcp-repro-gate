import { Ajv2020 } from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { sha256 } from "../src/digest.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import { createGitChangeProposal } from "../src/git-change-proposal.js";
import { matchesOperatorReviewedGitApprovalFromPlan } from "../src/git-operator-review-plan.js";
import {
  parseGitPromotionAttempt,
  parsePreparedGitPromotionObjects,
  type GitPromotionAttemptV1,
} from "../src/git-promotion-contract.js";
import {
  fixture,
  noAttempt,
  observingPlans,
  raw,
  registerEpochProjection,
  request,
  reserve,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each journal suite.

test("signed exact objects reserve durably, permanently, without Git writes", (t) => {
  const f = fixture(t);
  const record = reserve(f);
  const readonlyCheck = () => {
    // @ts-expect-error durable records are recursively readonly
    record.prepared.staged.changedPaths[0] = "other";
    // @ts-expect-error intent cannot be reassigned
    record.approvalId = randomUUID();
  };
  assert.equal(typeof readonlyCheck, "function");
  assert.equal(record.state, "prepared");
  assert.equal(
    matchesOperatorReviewedGitApprovalFromPlan(f.store, {
      approvalId: f.approval.approvalId,
      proposal: f.proposal,
      patch: f.patch,
      context: f.context,
      trust: f.trust,
    }),
    true,
    "legacy signed read-only matching is not a consumption claim",
  );
  assert.equal(
    canonicalJson(f.store.getGitPromotionAttempt(f.prepared.attemptId)),
    canonicalJson(record),
  );
  assert.deepEqual(record.prepared, f.prepared);
  assert.equal(
    record.reviewDigest,
    sha256(
      "ReproGate/GitOperatorReview/v1\0" + canonicalJson(f.review.payload),
    ),
  );
  assert.equal(record.admissionDeadline, f.approval.expiresAt);
  assert.equal(Object.hasOwn(record, "finalAuthorizationCheckedAt"), false);
  assert.equal(Object.hasOwn(record, "refObservations"), false);
  assert.ok(Object.isFrozen(record.prepared.staged.changedPaths));
  assert.ok(Object.isFrozen(record.proposal.workspace));
  assert.equal(Reflect.set(record, "state", "confirmed"), false);
  assert.throws(() => reserve(f));
  assert.throws(() => f.store.revoke(f.approval.approvalId));
  f.store.close();
  const reopened = new SqliteGitApprovalStore(f.databasePath);
  f.closers.push(() => {
    reopened.close();
  });
  assert.deepEqual(
    reopened.getGitPromotionAttempt(f.prepared.attemptId),
    record,
  );
  assert.throws(
    () => reopened.reserveGitPromotionFromPlan(request(f)),
    /consumed/u,
  );
  assert.throws(() => reopened.revoke(f.approval.approvalId), /Unresolved/u);
  f.assertProtected();
});

test("journal exists in the approval database with FULL synchronization", (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.databasePath);
  try {
    assert.ok(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'git_promotion_attempts'",
        )
        .get(),
    );
  } finally {
    db.close();
  }
});

test("SHA256 Git objects also reserve with strict readback", (t) => {
  const f = fixture(t, "approve", "sha256");
  assert.equal(reserve(f).prepared.candidateCommitOid.length, 64);
  f.assertProtected();
});

test("prepared shapes, prototypes, accessors and mixed versions cannot consume", (t) => {
  const f = fixture(t);
  const variants: unknown[] = [
    { ...f.prepared, extra: true },
    { ...f.prepared, preparedVersion: 2 },
    { ...f.prepared, attemptId: f.prepared.attemptId + "\n" },
    { ...f.prepared, attemptId: f.prepared.attemptId.toUpperCase() },
    { ...f.prepared, createdAt: "2026-02-30T00:00:00.000Z" },
    { ...f.prepared, effectDigest: sha256("other") },
    { ...f.prepared, baseCommit: "0".repeat(40) },
    { ...f.prepared, staged: { ...f.prepared.staged, extra: 1 } },
    {
      ...f.prepared,
      staged: {
        ...f.prepared.staged,
        changedPaths: ["value.txt", "value.txt"],
      },
    },
    { ...f.prepared, staged: { ...f.prepared.staged, changedPaths: Array(1) } },
    Object.assign(Object.create({ inherited: true }) as object, f.prepared),
  ];
  let invoked = 0;
  variants.push({
    ...f.prepared,
    get candidateCommitOid() {
      invoked++;
      return f.prepared.candidateCommitOid;
    },
  });
  const hidden = { ...f.prepared };
  Object.defineProperty(hidden, "createdAt", {
    value: hidden.createdAt,
    enumerable: false,
  });
  variants.push(hidden);
  const symbol = { ...f.prepared, [Symbol("unknown")]: 1 };
  variants.push(symbol);
  for (const prepared of variants) {
    assert.throws(() =>
      reserve(f, { prepared: prepared as typeof f.prepared }),
    );
    noAttempt(f);
  }
  assert.equal(invoked, 0);
  const v1 = createGitChangeProposal({
    repositoryPath: f.root,
    repositoryId: f.context.repositoryId,
    destinationRef: "refs/heads/source",
    patch: f.patch,
    allowedPaths: ["value.txt"],
    expiresAt: f.proposal.expiresAt,
    actionId: f.proposal.actionId,
    policyDigest: f.proposal.policyDigest,
  });
  assert.throws(() =>
    reserve(f, { proposal: v1 as unknown as typeof f.proposal }),
  );
  noAttempt(f);
  reserve(f);
  f.assertProtected();
});

test("strict proposal and prepared owned capture is detached from later caller mutation", (t) => {
  const f = fixture(t);
  const proposal = structuredClone(f.proposal);
  const prepared = structuredClone(f.prepared);
  let inputReads = 0;
  let workspaceReads = 0;
  const withGetter = {
    ...proposal,
    get workspace() {
      workspaceReads++;
      return proposal.workspace;
    },
  };
  const context = {
    ...f.context,
    plans: observingPlans(f.plans, (n) => {
      if (n === 1) {
        prepared.staged.changedPaths.push("other");
        prepared.candidateCommitOid = "0".repeat(40);
        proposal.allowedPaths.push("other");
      }
    }),
  };
  const input = {
    ...request(f),
    context,
    prepared,
    get proposal() {
      inputReads++;
      return withGetter;
    },
  };
  const record = f.store.reserveGitPromotionFromPlan(input);
  assert.equal(inputReads, 1);
  assert.equal(workspaceReads, 1);
  assert.deepEqual(record.prepared, f.prepared);
  assert.deepEqual(record.proposal, f.proposal);
  assert.notStrictEqual(record.prepared.staged, f.prepared.staged);
  f.assertProtected();
});

test("wrong fence token, attempt, physical common, ledger, config or fake controller fails", (t) => {
  const f = fixture(t);
  for (const owner of [
    { ...f.owner, token: randomUUID() },
    { ...f.owner, attemptId: randomUUID() },
    { ...f.owner, commonDirectory: f.scratch },
    { ...f.owner, approvalDatabasePath: join(f.scratch, "other.sqlite") },
    { ...f.owner, fencePath: join(f.scratch, "other-fence") },
  ]) {
    assert.throws(() => reserve(f, { owner }));
    noAttempt(f);
  }
  assert.throws(() =>
    reserve(f, { prepared: { ...f.prepared, attemptId: randomUUID() } }),
  );
  noAttempt(f);
  assert.throws(() =>
    reserve(f, {
      hostControl: {
        ...f.hostControl,
        fencePath: join(f.scratch, "other-fence"),
      },
    }),
  );
  assert.throws(() =>
    reserve(f, { hostControl: f.control as unknown as typeof f.hostControl }),
  );
  const other = new SqliteGitApprovalStore(join(f.scratch, "other.sqlite"));
  try {
    assert.throws(
      () => other.reserveGitPromotionFromPlan(request(f)),
      /bound absolute disk ledger/u,
    );
  } finally {
    other.close();
  }
  const memory = new SqliteGitApprovalStore(":memory:");
  try {
    assert.throws(
      () => memory.reserveGitPromotionFromPlan(request(f)),
      /bound absolute disk ledger/u,
    );
  } finally {
    memory.close();
  }
  noAttempt(f);
  reserve(f);
  f.assertProtected();
});

test("AJV and runtime strict intent shapes agree; semantic and physical checks remain separate", (t) => {
  const f = fixture(t);
  const record = reserve(f);
  const schema = JSON.parse(
    readFileSync(
      new URL(
        "../../schemas/git-promotion-attempt.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as object;
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseGitPromotionAttempt(record), record);
  for (const value of [
    { ...record, extra: true },
    { ...record, state: "confirmed" },
    { ...record, finalAuthorizationCheckedAt: record.reservedAt },
    { ...record, fenceOwner: { ...record.fenceOwner, extra: true } },
    { ...record, prepared: { ...record.prepared, preparedVersion: 2 } },
    { ...record, proposal: { ...record.proposal, proposalVersion: 1 } },
  ]) {
    assert.equal(validate(value), false);
    assert.throws(() => parseGitPromotionAttempt(value));
  }
  const invalidDate = { ...record, reservedAt: "2026-02-30T00:00:00.000Z" };
  assert.equal(validate(invalidDate), true);
  assert.throws(() => parseGitPromotionAttempt(invalidDate));
  assert.throws(() =>
    parseGitPromotionAttempt({
      ...record,
      proposal: { ...record.proposal, allowedPaths: ["😀".repeat(4097)] },
    }),
  );
  assert.throws(() =>
    parsePreparedGitPromotionObjects({
      ...f.prepared,
      staged: { ...f.prepared.staged, changedPaths: ["😀".repeat(4097)] },
    }),
  );
  const mutable = JSON.parse(canonicalJson(record)) as GitPromotionAttemptV1;
  const owned = parseGitPromotionAttempt(mutable);
  mutable.prepared.staged.changedPaths[0] = "other";
  assert.equal(owned.prepared.staged.changedPaths[0], "value.txt");
});

test("strict SQL foreign keys bind both signed decision and approval linkage", (t) => {
  const f = fixture(t);
  reserve(f);
  let row: Record<string, import("node:sqlite").SQLOutputValue> | undefined;
  raw(f, (db) => {
    row = db.prepare("SELECT * FROM git_promotion_attempts").get();
  });
  assert.ok(row);
  const path = join(f.scratch, "constraints.sqlite");
  new SqliteGitApprovalStore(path).close();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    registerEpochProjection(db);
    const columns = Object.keys(row);
    const insert = db.prepare(
      `INSERT INTO git_promotion_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    assert.throws(
      () => insert.run(...columns.map((key) => row?.[key] ?? null)),
      /FOREIGN KEY/u,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM git_promotion_attempts").get()?.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("unknown subtrees/accessors are rejected before traversal", (t) => {
  const f = fixture(t);
  let calls = 0;
  const poisoned = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        throw new Error("must not traverse unknown subtree");
      },
    },
  );
  assert.throws(() =>
    parsePreparedGitPromotionObjects({ ...f.prepared, unknown: poisoned }),
  );
  assert.equal(calls, 0);
  noAttempt(f);
});

test("journal persists no patch bytes or private signing material", (t) => {
  const f = fixture(t);
  const record = reserve(f);
  const bytes = Buffer.concat(
    readdirSync(f.scratch)
      .filter((name) => name.startsWith("approvals.sqlite"))
      .map((name) => readFileSync(join(f.scratch, name))),
  );
  for (const secret of [
    f.patch,
    f.privateKeyBytes,
    f.privateKeyBytes.subarray(f.privateKeyBytes.length - 32),
  ])
    assert.equal(bytes.includes(secret), false);
  assert.equal(canonicalJson(record).includes("BEGIN PRIVATE KEY"), false);
  assert.equal(canonicalJson(record).includes(f.patch.toString("utf8")), false);
  f.assertProtected();
});
