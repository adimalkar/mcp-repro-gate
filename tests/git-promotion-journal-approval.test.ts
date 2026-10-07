import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { canonicalJson } from "../src/canonical-json.js";
import { digestCanonical, sha256 } from "../src/digest.js";
import { SqliteGitApprovalStore } from "../src/git-approval-store.js";
import type { GitOperatorReviewTrustV1 } from "../src/git-operator-review.js";
import { prepareGitPromotionObjects } from "../src/git-promotion-objects.js";
import { InMemoryPlanStore } from "../src/kernel.js";
import {
  firstOperator,
  fixture,
  git,
  noAttempt,
  raw,
  request,
  reserve,
} from "./helpers/git-promotion-journal.js";

// Keep cases sequential within this file; Node isolates each journal suite.

for (const mode of ["deny", "legacy"] as const) {
  test(`${mode} has no signed approved authority and cannot reserve`, (t) => {
    const f = fixture(t, mode);
    assert.throws(() => reserve(f), /linked signed approval/u);
    noAttempt(f);
    if (mode === "legacy") {
      assert.equal(f.store.revoke(f.approval.approvalId), true);
      assert.equal(f.store.revoke(f.approval.approvalId), false);
    }
    f.assertProtected();
  });
}
test("revoked and expired approvals cannot reserve, ordinary revoke behavior remains", (t) => {
  const f = fixture(t);
  assert.equal(f.store.revoke(f.approval.approvalId), true);
  assert.equal(f.store.revoke(f.approval.approvalId), false);
  assert.equal(f.store.revoke(randomUUID()), false);
  assert.throws(() => reserve(f), /linked signed approval/u);
  noAttempt(f);
  const expired = fixture(t);
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse(expired.approval.expiresAt),
  });
  assert.throws(() => reserve(expired), /linked signed approval/u);
  noAttempt(expired);
});

test("current key, permission, audience and TTL drift invalidate the signed proof", (t) => {
  const f = fixture(t);
  const variants = [
    (trust: GitOperatorReviewTrustV1) => {
      trust.operators = [];
    },
    (trust: GitOperatorReviewTrustV1) => {
      firstOperator(trust).operator.enabled = false;
    },
    (trust: GitOperatorReviewTrustV1) => {
      firstOperator(trust).key.enabled = false;
    },
    (trust: GitOperatorReviewTrustV1) => {
      firstOperator(trust).operator.keys = [];
    },
    (trust: GitOperatorReviewTrustV1) => {
      firstOperator(trust).operator.permissions = [];
    },
    (trust: GitOperatorReviewTrustV1) => {
      firstOperator(trust).permission.destinationRef = "refs/heads/other";
    },
    (trust: GitOperatorReviewTrustV1) => {
      trust.audience = "other-host";
    },
    (trust: GitOperatorReviewTrustV1) => {
      trust.maxReviewTtlMs = 1;
    },
  ];
  for (const change of variants) {
    const trust = structuredClone(f.trust);
    change(trust);
    assert.throws(() => reserve(f, { trust }), /linked signed approval/u);
    noAttempt(f);
  }
  reserve(f);
  f.assertProtected();
});

test("plan, policy, catalog, repo, ref, proposal and effect drift reserve nothing", (t) => {
  const f = fixture(t);
  const contexts = [
    { ...f.context, plans: new InMemoryPlanStore() },
    {
      ...f.context,
      currentPolicy: {
        ...f.context.currentPolicy,
        defaults: {
          ...f.context.currentPolicy.defaults,
          local_write: "deny" as const,
        },
      },
    },
    { ...f.context, catalogTool: { ...f.context.catalogTool, scopes: [] } },
    {
      ...f.context,
      catalogTool: { ...f.context.catalogTool, toolName: "changed" },
    },
    { ...f.context, repositoryId: "other/repo" },
    { ...f.context, destinationRef: "refs/heads/other" },
  ];
  for (const context of contexts) {
    assert.throws(() => reserve(f, { context }));
    noAttempt(f);
  }
  const altered = { ...f.proposal, allowedPaths: ["value.txt", "other"] };
  altered.proposalId = digestCanonical(
    Object.fromEntries(
      Object.entries(altered).filter(([k]) => k !== "proposalId"),
    ),
  );
  assert.throws(() => reserve(f, { proposal: altered }));
  const staged = { ...f.prepared.staged, stagedPatchDigest: sha256("other") };
  assert.throws(() =>
    reserve(f, {
      prepared: {
        ...f.prepared,
        staged,
        effectDigest: digestCanonical(staged),
      },
    }),
  );
  noAttempt(f);
  reserve(f);
  f.assertProtected();
});

test("changed raw candidate identity/message/time/parents/tree or scopes cannot consume", (t) => {
  const f = fixture(t);
  const original = git(
    f.root,
    "cat-file",
    "commit",
    f.prepared.candidateCommitOid,
  ).toString("utf8");
  for (const commit of [
    original.replace("author ReproGate", "author Intruder"),
    original.replace("ReproGate candidate v1", "other message"),
    original.replace(
      `parent ${f.prepared.baseCommit}\n`,
      `parent ${f.prepared.baseCommit}\nparent ${f.prepared.baseCommit}\n`,
    ),
    original.replace(" +0000", " +0100"),
    original.replace(f.prepared.createdAt, "2020-01-01T00:00:00.000Z"),
    original.replace(
      f.prepared.candidateTreeOid,
      f.proposal.workspace.headTree,
    ),
  ]) {
    const oid = execFileSync(
      "git",
      ["-C", f.root, "hash-object", "-t", "commit", "-w", "--stdin"],
      { input: commit },
    )
      .toString()
      .trim();
    assert.throws(() =>
      reserve(f, {
        prepared: {
          ...f.prepared,
          candidateCommitOid: oid,
          hostCommitMetadataDigest: sha256(commit),
        },
      }),
    );
    noAttempt(f);
  }
  const staged = { ...f.prepared.staged, changedPaths: ["outside.txt"] };
  assert.throws(() =>
    reserve(f, {
      prepared: {
        ...f.prepared,
        staged,
        effectDigest: digestCanonical(staged),
      },
    }),
  );
  noAttempt(f);
  reserve(f);
  f.assertProtected();
});

test("durable linked proof tampering fails closed without consuming", (t) => {
  const f = fixture(t);
  raw(f, (db) => {
    const saved = db
      .prepare(
        "SELECT review_json FROM git_operator_review_decisions WHERE approval_id = ?",
      )
      .get(f.approval.approvalId)?.review_json;
    assert.equal(typeof saved, "string");
    for (const review of [
      {
        ...f.review,
        signature: { ...f.review.signature, value: "A".repeat(86) },
      },
      { ...f.review, payload: { ...f.review.payload, decision: "deny" } },
      {
        ...f.review,
        payload: { ...f.review.payload, effectDigest: sha256("other") },
      },
    ]) {
      db.prepare(
        "UPDATE git_operator_review_decisions SET review_json = ? WHERE approval_id = ?",
      ).run(canonicalJson(review), f.approval.approvalId);
      assert.throws(() => reserve(f));
      noAttempt(f);
    }
    db.prepare(
      "UPDATE git_operator_review_decisions SET review_json = ? WHERE approval_id = ?",
    ).run(saved as string, f.approval.approvalId);
  });
  reserve(f);
  f.assertProtected();
});

test("different fresh attempt cannot reuse consumption across connections", (t) => {
  const f = fixture(t);
  const first = reserve(f);
  // No child was dispatched: explicit trusted-host release is not recovery and
  // must not restore the consumed approval even with a new, valid fence owner.
  f.control.release(f.owner, { childrenQuiescent: true });
  const prepared = prepareGitPromotionObjects({
    proposal: f.proposal,
    repositoryPath: f.root,
    patch: f.patch,
    attemptId: randomUUID(),
  });
  const owner = f.control.acquire(prepared.attemptId);
  const second = new SqliteGitApprovalStore(f.databasePath);
  try {
    assert.throws(
      () =>
        second.reserveGitPromotionFromPlan({ ...request(f), prepared, owner }),
      /consumed/u,
    );
    assert.equal(second.getGitPromotionAttempt(prepared.attemptId), undefined);
    assert.deepEqual(second.getGitPromotionAttempt(first.attemptId), first);
  } finally {
    second.close();
  }
  f.assertProtected();
});

test("changed installed raw object at claimed OID fails before consumption", (t) => {
  const f = fixture(t);
  const original = git(
    f.root,
    "cat-file",
    "commit",
    f.prepared.candidateCommitOid,
  );
  const altered = Buffer.from(
    original.toString("utf8").replace("author ReproGate", "author Intruder"),
  );
  // Git may prefer a packed copy over a forged loose overlay. Unpack the
  // fixture's imported closure first and VERIFY that Git observes tampering.
  const packDir = join(f.root, ".git", "objects", "pack");
  const packs = readdirSync(packDir)
    .filter((name) => name.endsWith(".pack"))
    .map((name) => readFileSync(join(packDir, name)));
  for (const name of readdirSync(packDir)) rmSync(join(packDir, name));
  for (const pack of packs)
    execFileSync("git", ["-C", f.root, "unpack-objects", "-r"], {
      input: pack,
    });
  const oid = f.prepared.candidateCommitOid;
  const shard = join(f.root, ".git", "objects", oid.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  const objectPath = join(shard, oid.slice(2));
  const object = Buffer.concat([
    Buffer.from(`commit ${String(altered.length)}\0`),
    altered,
  ]);
  chmodSync(objectPath, 0o600);
  writeFileSync(objectPath, deflateSync(object));
  assert.deepEqual(git(f.root, "cat-file", "commit", oid), altered);
  try {
    assert.throws(() => reserve(f));
    noAttempt(f);
  } finally {
    writeFileSync(
      objectPath,
      deflateSync(
        Buffer.concat([
          Buffer.from(`commit ${String(original.length)}\0`),
          original,
        ]),
      ),
    );
  }
  reserve(f);
  f.assertProtected();
});
