import { Ajv2020 } from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.js";
import {
  SqliteGitApprovalStore,
  type PromoteGitPromotionAttemptInput,
} from "../src/git-approval-store.js";
import {
  fixture,
  git,
  observingPlans,
  raw,
  reserve,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each suite.

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
// Everything except the destination ref: source HEAD, branch, index,
// worktree file and status.
function source(f: Fixture) {
  return {
    head: git(f.root, "symbolic-ref", "HEAD").toString(),
    branch: git(f.root, "rev-parse", "refs/heads/source").toString(),
    index: readFileSync(join(f.root, ".git", "index")),
    file: readFileSync(join(f.root, "value.txt")),
    status: git(f.root, "status", "--porcelain=v1", "-z").toString(),
  };
}
function otherCommit(f: Fixture): string {
  return git(f.root, "commit-tree", "-p", "HEAD", "-m", "other", "HEAD^{tree}")
    .toString()
    .trim();
}
function deadlineClock(t: TestContext, f: Fixture) {
  const deadline = Date.parse(f.approval.expiresAt);
  t.mock.method(Date, "now", () => deadline);
}

test("an exact admitted promotion moves only the destination and confirms", (t) => {
  const f = fixture(t);
  reserve(f);
  const before = source(f);
  const result = promote(f);
  assert.equal(result.status.state, "confirmed");
  assert.equal(result.status.outcome?.reason, "ref_updated");
  assert.equal(result.fence, "released");
  assert.equal(f.control.query().status, "available");
  assert.equal(target(f), f.prepared.candidateCommitOid);
  assert.deepEqual(source(f), before);
  assert.equal(
    result.status.admission?.candidateCommitOid,
    f.prepared.candidateCommitOid,
  );
  assert.ok(
    git(f.root, "reflog", "show", "refs/heads/target")
      .toString()
      .includes(`reprogate promotion ${f.prepared.attemptId}`),
  );
  // One use only: a resolved attempt is never promoted or revoked again, not
  // even under a freshly acquired fence for the same attempt.
  assert.throws(() => promote(f), /exact persisted fence owner/u);
  const fresh = f.control.acquire(f.prepared.attemptId);
  assert.throws(() => promote(f, { owner: fresh }), /ownership mismatch/u);
  f.control.release(fresh, { childrenQuiescent: true });
  assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
  // A lost response reads back the same durable confirmation.
  f.store.close();
  const reopened = new SqliteGitApprovalStore(f.databasePath);
  f.closers.push(() => {
    reopened.close();
  });
  assert.equal(
    canonicalJson(reopened.getGitPromotionStatus(f.prepared.attemptId)),
    canonicalJson(result.status),
  );
});

test("SHA256 repositories promote with the same exact readback", (t) => {
  const f = fixture(t, "approve", "sha256");
  reserve(f);
  const result = promote(f);
  assert.equal(result.status.state, "confirmed");
  assert.equal(target(f).length, 64);
  assert.equal(target(f), f.prepared.candidateCommitOid);
});

test("precheck rejections record nothing and leave the attempt retryable", (t) => {
  const f = fixture(t);
  reserve(f);
  const base = target(f);
  // A moved destination is drift; restoring it makes the attempt admissible.
  git(f.root, "update-ref", "refs/heads/target", otherCommit(f));
  assert.throws(() => promote(f), /precheck rejected: authority_rejected/u);
  git(f.root, "update-ref", "refs/heads/target", base);
  // A destination checked out in any linked worktree is refused too.
  const linked = join(f.scratch, "linked");
  git(f.root, "worktree", "add", "-q", linked, "target");
  assert.throws(() => promote(f), /precheck rejected: authority_rejected/u);
  git(f.root, "worktree", "remove", linked);
  const status = f.store.getGitPromotionStatus(f.prepared.attemptId);
  assert.equal(status?.state, "prepared");
  assert.equal(status.admission, undefined);
  assert.equal(f.control.query().status, "held");
  assert.equal(promote(f).status.state, "confirmed");
});

test("an expired admission deadline is refused before the lock", (t) => {
  const f = fixture(t);
  reserve(f);
  deadlineClock(t, f);
  assert.throws(() => promote(f), /precheck rejected: admission_expired/u);
  t.mock.restoreAll();
  assert.equal(
    f.store.getGitPromotionStatus(f.prepared.attemptId)?.state,
    "prepared",
  );
});

test("wrong owners, tokens, attempts and configurations cannot promote", (t) => {
  const f = fixture(t);
  reserve(f);
  for (const overrides of [
    { owner: { ...f.owner, token: randomUUID() } },
    { owner: { ...f.owner, attemptId: randomUUID() } },
    { attemptId: randomUUID() },
    {
      hostControl: {
        ...f.hostControl,
        fencePath: join(f.scratch, "other-fence"),
      },
    },
  ])
    assert.throws(() => promote(f, overrides));
  assert.equal(
    f.store.getGitPromotionStatus(f.prepared.attemptId)?.state,
    "prepared",
  );
  assert.equal(target(f), f.prepared.expectedOldOid);
});

test("a policy change after the precheck records failed at the gate", (t) => {
  const f = fixture(t);
  reserve(f);
  const result = promote(f, {
    context: {
      ...f.context,
      // Call 1 is the unlocked precheck; call 2 runs under BEGIN IMMEDIATE.
      plans: observingPlans(f.plans, (n) => {
        if (n === 2) f.context.currentPolicy.defaults.local_write = "deny";
      }),
    },
  });
  assert.equal(result.status.state, "failed");
  assert.equal(result.status.outcome?.reason, "authority_rejected");
  assert.equal(result.status.admission, undefined);
  assert.equal(result.fence, "released");
  assert.equal(target(f), f.prepared.expectedOldOid);
  assert.throws(() => promote(f), /exact persisted fence owner/u);
  assert.throws(() => f.store.revoke(f.approval.approvalId), /Unresolved/u);
});

test("reaching the deadline at the gate records admission_expired", (t) => {
  const f = fixture(t);
  reserve(f);
  const result = promote(f, {
    context: {
      ...f.context,
      plans: observingPlans(f.plans, (n) => {
        if (n === 2) deadlineClock(t, f);
      }),
    },
  });
  t.mock.restoreAll();
  assert.equal(result.status.state, "failed");
  assert.equal(result.status.outcome?.reason, "admission_expired");
  assert.equal(target(f), f.prepared.expectedOldOid);
});

test("a lost compare-and-swap after admission is indeterminate and keeps the fence", (t) => {
  const f = fixture(t);
  reserve(f);
  const moved = otherCommit(f);
  const result = promote(f, {
    context: {
      ...f.context,
      // After the locked workspace observation, before update-ref.
      plans: observingPlans(f.plans, (n) => {
        if (n === 2) git(f.root, "update-ref", "refs/heads/target", moved);
      }),
    },
  });
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "dispatch_uncertain");
  assert.equal(result.status.outcome.observedDestinationOid, moved);
  assert.ok(result.status.admission);
  assert.equal(result.fence, "retained");
  assert.equal(f.control.query().status, "held");
  assert.equal(target(f), moved, "the newer ref is never overwritten");
  assert.throws(() => promote(f), /admitted or resolved/u);
  // Recovery after quiescence keeps the outcome and only releases the fence.
  const recovered = recover(f);
  assert.equal(canonicalJson(recovered.status), canonicalJson(result.status));
  assert.equal(recovered.fence, "released");
  assert.equal(recover(f).fence, "not_held");
  assert.equal(target(f), moved);
});

test("a destination already at the candidate without our dispatch is never confirmed", (t) => {
  const f = fixture(t);
  reserve(f);
  const result = promote(f, {
    context: {
      ...f.context,
      // Another writer moves the ref to the candidate first; our expected-old
      // compare-and-swap then fails. Present-ref equality is not evidence.
      plans: observingPlans(f.plans, (n) => {
        if (n === 2)
          git(
            f.root,
            "update-ref",
            "refs/heads/target",
            f.prepared.candidateCommitOid,
          );
      }),
    },
  });
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "dispatch_uncertain");
  assert.equal(
    result.status.outcome.observedDestinationOid,
    f.prepared.candidateCommitOid,
  );
  assert.equal(result.fence, "retained");
});

test("recovery of a never-admitted attempt fails it without dispatch", (t) => {
  const f = fixture(t);
  reserve(f);
  const result = recover(f);
  assert.equal(result.status.state, "failed");
  assert.equal(result.status.outcome?.reason, "abandoned");
  assert.equal(
    result.status.outcome.observedDestinationOid,
    f.prepared.expectedOldOid,
  );
  assert.equal(result.fence, "released");
  assert.equal(target(f), f.prepared.expectedOldOid);
  assert.throws(() => promote(f));
  assert.equal(canonicalJson(recover(f).status), canonicalJson(result.status));
});

test("recovery requires an explicit plain quiescence acknowledgement", (t) => {
  const f = fixture(t);
  reserve(f);
  for (const acknowledgement of [
    { childrenQuiescent: false },
    {},
    { childrenQuiescent: true, extra: true },
    Object.create(null, {
      childrenQuiescent: { value: true, enumerable: true },
    }) as object,
    Object.defineProperty({}, "childrenQuiescent", {
      get: () => true,
      enumerable: true,
    }),
    null,
  ])
    assert.throws(() =>
      f.store.recoverGitPromotionAttempt({
        attemptId: f.prepared.attemptId,
        hostControl: f.hostControl,
        acknowledgement: acknowledgement as { childrenQuiescent: true },
      }),
    );
  assert.equal(
    f.store.getGitPromotionStatus(f.prepared.attemptId)?.state,
    "prepared",
  );
});

function startGateWorker(
  f: Fixture,
  mode: "before-admission" | "after-admission",
) {
  const path = join(f.scratch, `gate-worker-${randomUUID()}.json`);
  const context = {
    repositoryPath: f.context.repositoryPath,
    repositoryId: f.context.repositoryId,
    destinationRef: f.context.destinationRef,
    catalogTool: f.context.catalogTool,
    currentPolicy: f.context.currentPolicy,
  };
  writeFileSync(
    path,
    JSON.stringify({
      databasePath: f.databasePath,
      plansPath: join(f.scratch, "plans.sqlite"),
      mode,
      request: {
        attemptId: f.prepared.attemptId,
        context,
        trust: f.trust,
        hostControl: f.hostControl,
        owner: f.owner,
      },
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("./fixtures/git-promotion-gate-worker.js", import.meta.url),
      ),
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  };
  // Reap before the fixture deletes its scratch directory.
  f.asyncClosers.push(kill);
  const waitFor = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const seen = () => output.includes(`{"event":"${event}"}`);
      const timer = setTimeout(() => {
        reject(new Error(`Gate worker did not emit ${event}`));
      }, 90_000);
      const onData = (chunk: string) => {
        output += chunk;
        if (seen()) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      void closed.then(() => {
        clearTimeout(timer);
        if (!seen()) reject(new Error(`Gate worker exited before ${event}`));
      });
    });
  return { waitFor, kill };
}

test("a worker killed before admission recovers as abandoned", async (t) => {
  const f = fixture(t);
  reserve(f);
  const worker = startGateWorker(f, "before-admission");
  await worker.waitFor("before-admission");
  await worker.kill();
  assert.equal(
    f.store.getGitPromotionStatus(f.prepared.attemptId)?.state,
    "prepared",
  );
  const result = recover(f);
  assert.equal(result.status.outcome?.reason, "abandoned");
  assert.equal(result.fence, "released");
  assert.equal(target(f), f.prepared.expectedOldOid);
});

test("a worker killed after admission cannot be promoted again and recovers as interrupted", async (t) => {
  const f = fixture(t);
  reserve(f);
  const worker = startGateWorker(f, "after-admission");
  await worker.waitFor("admitted");
  await worker.kill();
  const admitted = f.store.getGitPromotionStatus(f.prepared.attemptId);
  assert.equal(admitted?.state, "prepared");
  assert.ok(admitted.admission);
  assert.equal(f.control.query().status, "held");
  assert.throws(() => promote(f), /admitted or resolved/u);
  const result = recover(f);
  assert.equal(result.status.state, "indeterminate");
  assert.equal(result.status.outcome?.reason, "interrupted");
  assert.equal(
    result.status.outcome.observedDestinationOid,
    f.prepared.expectedOldOid,
  );
  assert.equal(result.fence, "released");
  assert.equal(target(f), f.prepared.expectedOldOid);
});

test("SQL guards keep admissions and outcomes insert-only and consistent", (t) => {
  const f = fixture(t);
  const attempt = reserve(f);
  const now = new Date().toISOString();
  const outcome = (fields: Record<string, unknown>) =>
    canonicalJson({
      outcomeVersion: 1,
      attemptId: attempt.attemptId,
      state: "confirmed",
      reason: "ref_updated",
      decidedAt: now,
      observedDestinationOid: attempt.prepared.candidateCommitOid,
      ...fields,
    });
  const admission = (fields: Record<string, unknown> = {}) =>
    canonicalJson({
      admissionVersion: 1,
      attemptId: attempt.attemptId,
      authorityDigest: attempt.authorityDigest,
      reviewDigest: attempt.reviewDigest,
      expectedOldOid: attempt.prepared.expectedOldOid,
      candidateCommitOid: attempt.prepared.candidateCommitOid,
      admittedAt: now,
      ...fields,
    });
  const insertOutcome = (json: string, verb = "INSERT") => {
    raw(f, (db) => {
      const value = JSON.parse(json) as Record<string, string | null>;
      db.prepare(
        `${verb} INTO git_promotion_outcomes (attempt_id, state, reason, observed_oid, record_json) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        attempt.attemptId,
        value.state ?? null,
        value.reason ?? null,
        value.observedDestinationOid ?? null,
        json,
      );
    });
  };
  const insertAdmission = (json: string, verb = "INSERT") => {
    raw(f, (db) => {
      db.prepare(
        `${verb} INTO git_promotion_admissions (attempt_id, record_json) VALUES (?, ?)`,
      ).run(attempt.attemptId, json);
    });
  };
  const exec = (sql: string) => {
    raw(f, (db) => {
      db.exec(sql);
    });
  };
  assert.throws(() => {
    insertOutcome(outcome({}));
  }, /contradicts its admission/u);
  assert.throws(() => {
    insertAdmission(
      admission({ candidateCommitOid: attempt.prepared.expectedOldOid }),
    );
  }, /bind its exact attempt/u);
  insertAdmission(admission());
  assert.throws(() => {
    insertAdmission(admission(), "INSERT OR REPLACE");
  }, /permanent/u);
  assert.throws(() => {
    insertOutcome(outcome({ state: "failed", reason: "abandoned" }));
  }, /contradicts its admission/u);
  assert.throws(() => {
    insertOutcome(
      outcome({ observedDestinationOid: attempt.prepared.expectedOldOid }),
    );
  }, /observe its candidate/u);
  assert.throws(() => {
    insertOutcome(outcome({ reason: "interrupted" }));
  }, /CHECK constraint/u);
  insertOutcome(outcome({}));
  assert.throws(() => {
    insertOutcome(outcome({}), "INSERT OR REPLACE");
  }, /permanent/u);
  assert.throws(() => {
    exec("UPDATE git_promotion_outcomes SET reason = 'interrupted'");
  }, /immutable/u);
  assert.throws(() => {
    exec("DELETE FROM git_promotion_outcomes");
  }, /permanent/u);
  assert.throws(() => {
    exec("UPDATE git_promotion_admissions SET record_json = record_json");
  }, /immutable/u);
  assert.throws(() => {
    exec("DELETE FROM git_promotion_admissions");
  }, /permanent/u);
  // The ledger is trusted host state: SQL alone does not verify Git.
  assert.equal(
    f.store.getGitPromotionStatus(attempt.attemptId)?.state,
    "confirmed",
  );
  assert.throws(() => promote(f), /admitted or resolved/u);
});

test("strict readback rejects non-canonical journal records", (t) => {
  const f = fixture(t);
  const attempt = reserve(f);
  raw(f, (db) => {
    db.prepare(
      "INSERT INTO git_promotion_admissions (attempt_id, record_json) VALUES (?, ?)",
    ).run(
      attempt.attemptId,
      JSON.stringify({
        admissionVersion: 1,
        attemptId: attempt.attemptId,
        authorityDigest: attempt.authorityDigest,
        reviewDigest: attempt.reviewDigest,
        expectedOldOid: attempt.prepared.expectedOldOid,
        candidateCommitOid: attempt.prepared.candidateCommitOid,
        admittedAt: new Date().toISOString(),
      }),
    );
  });
  assert.throws(
    () => f.store.getGitPromotionStatus(attempt.attemptId),
    /Corrupt promotion journal/u,
  );
});

test("published schemas accept real records and reject extra fields", (t) => {
  const f = fixture(t);
  reserve(f);
  const status = promote(f).status;
  const compile = (name: string) =>
    new Ajv2020({ strict: true }).compile(
      JSON.parse(
        readFileSync(
          new URL(`../../schemas/${name}.schema.json`, import.meta.url),
          "utf8",
        ),
      ) as object,
    );
  const admission = compile("git-promotion-admission");
  const outcome = compile("git-promotion-outcome");
  assert.equal(admission(status.admission), true);
  assert.equal(outcome(status.outcome), true);
  assert.equal(admission({ ...status.admission, extra: true }), false);
  assert.equal(outcome({ ...status.outcome, extra: true }), false);
  assert.equal(outcome({ ...status.outcome, reason: "abandoned" }), false);
  assert.equal(
    outcome({
      ...status.outcome,
      state: "failed",
      reason: "abandoned",
      observedDestinationOid: null,
    }),
    true,
  );
});

test("an unreserved fence is released only for its own attempt, never after reservation", (t) => {
  const f = fixture(t);
  const release = (
    attemptId: string,
    acknowledgement: unknown = { childrenQuiescent: true },
  ) =>
    f.store.releaseUnreservedGitPromotionFence({
      attemptId,
      hostControl: f.hostControl,
      acknowledgement: acknowledgement as { childrenQuiescent: true },
    });
  assert.throws(() => release(randomUUID()), /No fence is held/u);
  assert.throws(() =>
    release(f.prepared.attemptId, { childrenQuiescent: false }),
  );
  assert.equal(f.control.query().status, "held");
  reserve(f);
  assert.throws(() => release(f.prepared.attemptId), /recover it instead/u);
  assert.equal(f.control.query().status, "held");
});

test("a never-reserved attempt's fence is released and nothing is recorded", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.store.releaseUnreservedGitPromotionFence({
      attemptId: f.prepared.attemptId,
      hostControl: f.hostControl,
      acknowledgement: { childrenQuiescent: true },
    }),
    { fence: "released" },
  );
  assert.equal(f.control.query().status, "available");
  assert.equal(f.store.getGitPromotionAttempt(f.prepared.attemptId), undefined);
});
