import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/canonical-json.js";
import { digestCanonical, sha256 } from "../src/digest.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import {
  SqliteGitApprovalStore,
  type GitChangeApprovalV1,
} from "../src/git-approval-store.js";
import {
  createGitChangeIntent,
  createGitChangeProposal,
  type GitChangeProposalV1,
} from "../src/git-change-proposal.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";
import {
  gitOperatorKeyId,
  gitOperatorReviewDigest,
  signGitOperatorReview,
  type GitOperatorReviewPayloadV1,
  type GitOperatorReviewTrustV1,
  type GitOperatorReviewV1,
} from "../src/git-operator-review.js";
import {
  applyGitOperatorReviewFromPlan,
  matchesOperatorReviewedGitApprovalFromPlan,
  prepareGitOperatorReviewFromPlan,
} from "../src/git-operator-review-plan.js";
import {
  deriveGitApprovalAuthorityFromPlan,
  GIT_CHANGE_PROMOTE_SCOPE,
  grantGitChangeFromPlan,
  matchesGitApprovalFromPlan,
  type GitPlanBindingContext,
} from "../src/git-plan-binding.js";
import {
  InMemoryPlanStore,
  ReproGateKernel,
  type PlanStore,
} from "../src/kernel.js";
import type { CatalogTool, PolicyV1 } from "../src/types.js";

const MINUTE = 60_000;
const PATCH_MARKER = "reprogate-raw-patch-marker-4d1f9b";
const operatorPair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const workerPath = fileURLToPath(
  new URL("./fixtures/git-review-apply-worker.js", import.meta.url),
);

const tool: CatalogTool = {
  toolRef: "git.change",
  serverRef: "reprogate.git",
  toolName: "promote_patch",
  description: "Plan an exact Git change",
  inputSchema: { type: "object" },
  effects: ["local_write"],
  scopes: [GIT_CHANGE_PROMOTE_SCOPE],
};

const policy: PolicyV1 = {
  version: 1,
  defaults: {
    local_read: "allow",
    local_write: "approval_required",
    process_exec: "deny",
    network_read: "deny",
    network_write: "deny",
    credential_use: "deny",
    destructive: "deny",
  },
  rules: [],
};

const deniedPolicy: PolicyV1 = {
  ...policy,
  defaults: { ...policy.defaults, local_write: "deny" },
};

function sleep(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

interface ApprovalRow {
  approval_id: string;
  proposal_id: string;
  effect_digest: string;
  approval_json: string;
  status: string;
  revoked_at: string | null;
}

interface DecisionRow {
  proposal_id: string;
  review_digest: string;
  decision: string;
  review_json: string;
  approval_id: string | null;
  received_at: string;
}

function fixture(context: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-review-plan-"));
  const closers: (() => void)[] = [];
  context.after(() => {
    for (const close of closers.reverse()) {
      try {
        close();
      } catch {
        // Already closed by the test.
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  const repositoryPath = join(scratch, "repository");
  mkdirSync(repositoryPath);
  git(repositoryPath, "init", "-q", "-b", "main");
  git(repositoryPath, "config", "user.name", "ReproGate Test");
  git(repositoryPath, "config", "user.email", "test@example.invalid");
  mkdirSync(join(repositoryPath, "src"));
  writeFileSync(join(repositoryPath, "src", "value.txt"), "before\n");
  git(repositoryPath, "add", "src/value.txt");
  git(repositoryPath, "commit", "-q", "-m", "initial");
  writeFileSync(
    join(repositoryPath, "src", "value.txt"),
    `after ${PATCH_MARKER}\n`,
  );
  git(repositoryPath, "add", "src/value.txt");
  const patch = Buffer.from(
    git(repositoryPath, "diff", "--cached", "--binary"),
  );
  git(repositoryPath, "reset", "-q", "--hard", "HEAD");

  const repositoryId = "example/repository";
  const destinationRef = "refs/heads/main";
  const intentInput = {
    repositoryPath,
    repositoryId,
    destinationRef,
    patch,
    allowedPaths: ["src/value.txt"],
    expiresAt: new Date(Date.now() + 20 * MINUTE).toISOString(),
  };
  const plansPath = join(scratch, "plans.sqlite");
  const plans = new SqliteExecutionStore(plansPath);
  closers.push(() => {
    plans.close();
  });
  const kernel = new ReproGateKernel([tool], policy, plans);
  const plan = kernel.plan({
    toolRef: tool.toolRef,
    arguments: createGitChangeIntent(intentInput),
    ttlMs: 30 * MINUTE,
  });
  let lastCreatedAt = 0;
  // Proposals for one plan differ only by creation time.
  const newProposal = (): GitChangeProposalV1 => {
    while (Date.now() <= lastCreatedAt) sleep(1);
    const proposal = createGitChangeProposal({
      ...intentInput,
      actionId: plan.envelope.actionId,
      policyDigest: plan.policy.policyDigest,
    });
    lastCreatedAt = Date.parse(proposal.createdAt);
    return proposal;
  };
  const contextBinding: GitPlanBindingContext = {
    repositoryPath,
    repositoryId,
    destinationRef,
    catalogTool: tool,
    currentPolicy: policy,
    plans,
  };
  const proposal = newProposal();
  const keyId = gitOperatorKeyId(operatorPair.publicKey);
  const trust: GitOperatorReviewTrustV1 = {
    audience: "reprogate:test-host",
    maxReviewTtlMs: 30 * MINUTE,
    operators: [
      {
        operatorId: "alice",
        enabled: true,
        keys: [
          {
            keyId,
            publicKeyPem: operatorPair.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            enabled: true,
          },
        ],
        permissions: [
          {
            repositoryId,
            workspaceRootDigest: proposal.workspace.rootDigest,
            destinationRef,
          },
        ],
      },
    ],
  };

  const effects = new Map<string, GitChangeApprovalV1["effectDigest"]>();
  const effectOf = (candidate: GitChangeProposalV1) => {
    let effect = effects.get(candidate.proposalId);
    if (effect === undefined) {
      effect = digestCanonical(
        stageGitChangeProposal(candidate, repositoryPath, patch),
      );
      effects.set(candidate.proposalId, effect);
    }
    return effect;
  };
  /** Sign independently of the API under test: derive + stage directly. */
  const sign = (
    candidate: GitChangeProposalV1,
    overrides: Partial<GitOperatorReviewPayloadV1> = {},
    privateKey: KeyObject = operatorPair.privateKey,
  ): GitOperatorReviewV1 => {
    const payload: GitOperatorReviewPayloadV1 = {
      reviewVersion: 1,
      audience: trust.audience,
      operatorId: "alice",
      keyId,
      decision: "approve",
      proposalId: candidate.proposalId,
      authorityDigest: digestCanonical(
        deriveGitApprovalAuthorityFromPlan(candidate, contextBinding),
      ),
      effectDigest: effectOf(candidate),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * MINUTE).toISOString(),
      ...overrides,
    };
    return signGitOperatorReview(payload, privateKey);
  };

  const approvalsPath = join(scratch, "approvals.sqlite");
  const openStore = () => {
    const store = new SqliteGitApprovalStore(approvalsPath);
    closers.push(() => {
      store.close();
    });
    return store;
  };
  const rawDatabase = () => {
    const database = new DatabaseSync(approvalsPath, {
      enableForeignKeyConstraints: false,
    });
    closers.push(() => {
      database.close();
    });
    return database;
  };
  const counts = () => {
    const database = new DatabaseSync(approvalsPath, { readOnly: true });
    try {
      const count = (table: string) =>
        (
          database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n;
      return {
        approvals: count("git_change_approvals"),
        decisions: count("git_operator_review_decisions"),
      };
    } finally {
      database.close();
    }
  };
  const rows = () => {
    const database = new DatabaseSync(approvalsPath, { readOnly: true });
    // SQLite rows have null prototypes; copy them into plain objects.
    const all = (sql: string) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    try {
      return {
        approvals: all(
          "SELECT * FROM git_change_approvals ORDER BY proposal_id",
        ) as unknown as ApprovalRow[],
        decisions: all(
          "SELECT * FROM git_operator_review_decisions ORDER BY proposal_id",
        ) as unknown as DecisionRow[],
      };
    } finally {
      database.close();
    }
  };
  const protectedState = () => ({
    head: git(repositoryPath, "rev-parse", "HEAD"),
    ref: git(repositoryPath, "rev-parse", destinationRef),
    status: git(
      repositoryPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    index: sha256(readFileSync(join(repositoryPath, ".git", "index"))),
    file: readFileSync(join(repositoryPath, "src", "value.txt"), "utf8"),
  });
  const initialState = protectedState();
  const apply = (
    store: SqliteGitApprovalStore,
    candidate: GitChangeProposalV1,
    review: unknown,
    overrides: Partial<{
      patch: Uint8Array;
      context: GitPlanBindingContext;
      trust: GitOperatorReviewTrustV1;
    }> = {},
  ) =>
    applyGitOperatorReviewFromPlan(store, {
      proposal: candidate,
      patch,
      context: contextBinding,
      trust,
      review,
      ...overrides,
    });
  const check = (
    store: SqliteGitApprovalStore,
    approvalId: string,
    candidate: GitChangeProposalV1,
    overrides: Partial<{
      patch: Uint8Array;
      context: GitPlanBindingContext;
      trust: GitOperatorReviewTrustV1;
    }> = {},
  ) =>
    matchesOperatorReviewedGitApprovalFromPlan(store, {
      approvalId,
      proposal: candidate,
      patch,
      context: contextBinding,
      trust,
      ...overrides,
    });
  return {
    scratch,
    repositoryPath,
    repositoryId,
    destinationRef,
    patch,
    plansPath,
    plans,
    approvalsPath,
    proposal,
    newProposal,
    contextBinding,
    trust,
    sign,
    effectOf,
    openStore,
    rawDatabase,
    counts,
    rows,
    apply,
    check,
    assertProtected: () => {
      assert.deepEqual(protectedState(), initialState);
    },
  };
}

function approvalOf(
  result: ReturnType<typeof applyGitOperatorReviewFromPlan>,
): GitChangeApprovalV1 {
  assert.equal(result.decision, "approve");
  assert.ok("approval" in result);
  return result.approval;
}

function mutableTrust(
  trust: GitOperatorReviewTrustV1,
  change: (copy: GitOperatorReviewTrustV1) => void,
): GitOperatorReviewTrustV1 {
  const copy = structuredClone(trust);
  change(copy);
  return copy;
}

function firstOperator(trust: GitOperatorReviewTrustV1) {
  const operator = trust.operators[0];
  assert.ok(operator);
  const key = operator.keys[0];
  const permission = operator.permissions[0];
  assert.ok(key);
  assert.ok(permission);
  return { operator, key, permission };
}

function observingPlans(
  plans: PlanStore,
  onGet: (call: number) => void,
): PlanStore & { calls: number } {
  const wrapper = {
    calls: 0,
    save: (plan: Parameters<PlanStore["save"]>[0]) => {
      plans.save(plan);
    },
    get: (actionId: string) => {
      wrapper.calls += 1;
      onGet(wrapper.calls);
      return plans.get(actionId);
    },
  };
  return wrapper;
}

test("prepare returns a deterministic metadata-only request bound to fresh staging", (context) => {
  const f = fixture(context);
  const first = prepareGitOperatorReviewFromPlan({
    proposal: f.proposal,
    patch: f.patch,
    context: f.contextBinding,
  });
  const authority = deriveGitApprovalAuthorityFromPlan(
    f.proposal,
    f.contextBinding,
  );
  const staged = stageGitChangeProposal(f.proposal, f.repositoryPath, f.patch);
  assert.deepEqual(Object.keys(first.request).sort(), [
    "authority",
    "authorityDigest",
    "effectDigest",
    "proposal",
    "requestVersion",
    "staged",
  ]);
  assert.equal(first.request.requestVersion, 1);
  assert.deepEqual(first.request.proposal, f.proposal);
  assert.notStrictEqual(first.request.proposal, f.proposal);
  assert.deepEqual(first.request.authority, authority);
  assert.equal(first.request.authorityDigest, digestCanonical(authority));
  assert.deepEqual(first.request.staged, staged);
  assert.equal(first.request.effectDigest, digestCanonical(staged));
  assert.equal(first.request.effectDigest, f.effectOf(f.proposal));
  assert.equal(
    first.request.staged.stagedPatchDigest,
    sha256(first.stagedPatch),
  );
  assert.match(
    Buffer.from(first.stagedPatch).toString("utf8"),
    new RegExp(PATCH_MARKER, "u"),
  );
  assert.equal(canonicalJson(first.request).includes(PATCH_MARKER), false);
  const second = prepareGitOperatorReviewFromPlan({
    proposal: f.proposal,
    patch: f.patch,
    context: f.contextBinding,
  });
  assert.equal(canonicalJson(second.request), canonicalJson(first.request));
  assert.deepEqual(second.stagedPatch, first.stagedPatch);

  for (const [name, input] of [
    ["patch", { patch: Buffer.from("other") }],
    [
      "policy",
      { context: { ...f.contextBinding, currentPolicy: deniedPolicy } },
    ],
    [
      "plan",
      { context: { ...f.contextBinding, plans: new InMemoryPlanStore() } },
    ],
  ] as const) {
    assert.throws(
      () =>
        prepareGitOperatorReviewFromPlan({
          proposal: f.proposal,
          patch: f.patch,
          context: f.contextBinding,
          ...input,
        }),
      Error,
      name,
    );
  }
  f.assertProtected();
});

test("prepare rederives authority after staging and rejects mismatch", (context) => {
  const f = fixture(context);
  const currentPolicy = structuredClone(policy);
  const plans = observingPlans(f.plans, (call) => {
    if (call === 2) currentPolicy.defaults.local_write = "deny";
  });
  assert.throws(
    () =>
      prepareGitOperatorReviewFromPlan({
        proposal: f.proposal,
        patch: f.patch,
        context: { ...f.contextBinding, currentPolicy, plans },
      }),
    /policy has changed/u,
  );
  assert.equal(plans.calls, 2);
});

test("an authenticated approval is atomically recorded and matches across reopen", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const review = f.sign(f.proposal);
  const result = f.apply(store, f.proposal, review);
  const approval = approvalOf(result);
  assert.equal(result.reviewDigest, gitOperatorReviewDigest(review.payload));
  assert.equal(result.proposalId, f.proposal.proposalId);
  assert.equal(approval.proposalId, f.proposal.proposalId);
  assert.equal(approval.expiresAt, review.payload.expiresAt);
  assert.equal(approval.effectDigest, review.payload.effectDigest);
  assert.equal(approval.authorityDigest, review.payload.authorityDigest);
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });
  const { approvals, decisions } = f.rows();
  assert.deepEqual(decisions, [
    {
      proposal_id: f.proposal.proposalId,
      review_digest: result.reviewDigest,
      decision: "approve",
      review_json: canonicalJson(review),
      approval_id: approval.approvalId,
      received_at: approval.grantedAt,
    },
  ]);
  assert.equal(approvals[0]?.approval_id, approval.approvalId);
  assert.equal(f.check(store, approval.approvalId, f.proposal), true);
  assert.equal(
    matchesGitApprovalFromPlan(store, {
      approvalId: approval.approvalId,
      proposal: f.proposal,
      patch: f.patch,
      context: f.contextBinding,
    }),
    true,
  );
  store.close();

  const reopened = f.openStore();
  assert.equal(f.check(reopened, approval.approvalId, f.proposal), true);
  assert.equal(f.check(reopened, "not-an-approval", f.proposal), false);
  reopened.close();

  const persisted = Buffer.concat(
    readdirSync(f.scratch)
      .filter((name) => name.startsWith("approvals.sqlite"))
      .map((name) => readFileSync(join(f.scratch, name))),
  );
  const pkcs8 = operatorPair.privateKey.export({
    type: "pkcs8",
    format: "der",
  });
  const pem = operatorPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  for (const secret of [
    Buffer.from(PATCH_MARKER),
    f.patch,
    pkcs8,
    pkcs8.subarray(pkcs8.length - 32),
    Buffer.from(pem.split("\n")[1] ?? "unreachable"),
  ]) {
    assert.equal(persisted.includes(secret), false);
  }
  f.assertProtected();
});

test("an authenticated denial persists a permanent tombstone without an approval", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const denial = f.sign(f.proposal, { decision: "deny" });
  const result = f.apply(store, f.proposal, denial);
  assert.deepEqual(result, {
    decision: "deny",
    proposalId: f.proposal.proposalId,
    reviewDigest: gitOperatorReviewDigest(denial.payload),
  });
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 1 });
  assert.equal(f.rows().decisions[0]?.approval_id, null);
  store.close();

  const reopened = f.openStore();
  assert.throws(
    () =>
      f.apply(
        reopened,
        f.proposal,
        f.sign(f.proposal, {
          expiresAt: new Date(Date.now() + 9 * MINUTE).toISOString(),
        }),
      ),
    /already recorded/u,
  );
  assert.throws(
    () =>
      grantGitChangeFromPlan(reopened, {
        proposal: f.proposal,
        patch: f.patch,
        reviewedEffectDigest: f.effectOf(f.proposal),
        expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
        context: f.contextBinding,
      }),
    /signed operator decision/u,
  );
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 1 });

  const fresh = f.newProposal();
  const approval = approvalOf(f.apply(reopened, fresh, f.sign(fresh)));
  assert.equal(f.check(reopened, approval.approvalId, fresh), true);
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 2 });
  f.assertProtected();
});

test("duplicate, conflicting, and replayed decisions are rejected after restart", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const original = f.sign(f.proposal);
  const approval = approvalOf(f.apply(store, f.proposal, original));
  assert.throws(
    () => f.apply(store, f.proposal, original),
    /already recorded/u,
  );
  store.close();

  const reopened = f.openStore();
  for (const review of [
    original,
    f.sign(f.proposal, { decision: "deny" }),
    f.sign(f.proposal, {
      expiresAt: new Date(Date.now() + 8 * MINUTE).toISOString(),
    }),
  ]) {
    assert.throws(
      () => f.apply(reopened, f.proposal, review),
      /already recorded/u,
    );
  }
  const other = f.newProposal();
  assert.throws(
    () => f.apply(reopened, other, original),
    /failed authentication/u,
  );
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });
  assert.equal(
    f.rows().decisions[0]?.review_digest,
    gitOperatorReviewDigest(original.payload),
  );
  assert.equal(f.check(reopened, approval.approvalId, f.proposal), true);
});

test("expired, premature, overlong, and unauthenticated reviews record nothing", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const now = Date.now();
  for (const review of [
    f.sign(f.proposal, {
      issuedAt: new Date(now - 1).toISOString(),
      expiresAt: new Date(now).toISOString(),
    }),
    f.sign(f.proposal, {
      issuedAt: new Date(now + 5 * MINUTE).toISOString(),
    }),
    f.sign(f.proposal, {
      expiresAt: new Date(now + 25 * MINUTE).toISOString(),
    }),
    f.sign(f.proposal, { audience: "reprogate:other-host" }),
    f.sign(
      f.proposal,
      { keyId: gitOperatorKeyId(otherPair.publicKey) },
      otherPair.privateKey,
    ),
    { ...f.sign(f.proposal), authenticated: true },
    null,
  ]) {
    assert.throws(
      () => f.apply(store, f.proposal, review),
      /failed authentication/u,
    );
  }
  // A signed claim about a different effect authenticates only preliminarily;
  // fresh staging then exposes the mismatch before anything is recorded.
  assert.throws(
    () =>
      f.apply(
        store,
        f.proposal,
        f.sign(f.proposal, { effectDigest: sha256("unreviewed effect") }),
      ),
    /Staged effect differs/u,
  );
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
  f.assertProtected();
});

test("signed expiry bounds the approval and a denial outlives its signed expiry", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const expiresAt = new Date(Date.now() + MINUTE).toISOString();
  const approved = f.sign(f.proposal, { expiresAt });
  const approval = approvalOf(f.apply(store, f.proposal, approved));
  assert.equal(approval.expiresAt, expiresAt);
  context.mock.timers.setTime(Date.now() + 1);
  const deniedProposal = f.newProposal();
  f.apply(
    store,
    deniedProposal,
    f.sign(deniedProposal, { decision: "deny", expiresAt }),
  );
  assert.equal(f.check(store, approval.approvalId, f.proposal), true);
  context.mock.timers.setTime(Date.parse(expiresAt) + 1);

  assert.equal(f.check(store, approval.approvalId, f.proposal), false);
  for (const candidate of [f.proposal, deniedProposal]) {
    assert.throws(
      () => f.apply(store, candidate, f.sign(candidate)),
      /already recorded/u,
    );
  }
  assert.throws(
    () =>
      grantGitChangeFromPlan(store, {
        proposal: deniedProposal,
        patch: f.patch,
        reviewedEffectDigest: f.effectOf(deniedProposal),
        expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
        context: f.contextBinding,
      }),
    /signed operator decision/u,
  );
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 2 });
});

test("legacy grants cannot become authenticated or override a signed decision", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const legacy = grantGitChangeFromPlan(store, {
    proposal: f.proposal,
    patch: f.patch,
    reviewedEffectDigest: f.effectOf(f.proposal),
    expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
    context: f.contextBinding,
  });
  for (const decision of ["approve", "deny"] as const) {
    assert.throws(
      () => f.apply(store, f.proposal, f.sign(f.proposal, { decision })),
      /already recorded/u,
    );
  }
  assert.equal(f.check(store, legacy.approvalId, f.proposal), false);
  assert.equal(
    matchesGitApprovalFromPlan(store, {
      approvalId: legacy.approvalId,
      proposal: f.proposal,
      patch: f.patch,
      context: f.contextBinding,
    }),
    true,
  );
  assert.equal(store.revoke(legacy.approvalId), true);
  assert.throws(
    () => f.apply(store, f.proposal, f.sign(f.proposal)),
    /already recorded/u,
  );
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 0 });

  const signed = f.newProposal();
  approvalOf(f.apply(store, signed, f.sign(signed)));
  assert.throws(
    () =>
      grantGitChangeFromPlan(store, {
        proposal: signed,
        patch: f.patch,
        reviewedEffectDigest: f.effectOf(signed),
        expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
        context: f.contextBinding,
      }),
    /signed operator decision/u,
  );
  assert.deepEqual(f.counts(), { approvals: 2, decisions: 1 });
});

test("revocation stays separate and replay or a fresh signature cannot reactivate", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const review = f.sign(f.proposal);
  const approval = approvalOf(f.apply(store, f.proposal, review));
  assert.equal(f.check(store, approval.approvalId, f.proposal), true);
  assert.equal(store.revoke(approval.approvalId), true);
  assert.equal(f.check(store, approval.approvalId, f.proposal), false);
  for (const candidate of [
    review,
    f.sign(f.proposal, {
      expiresAt: new Date(Date.now() + 7 * MINUTE).toISOString(),
    }),
  ]) {
    assert.throws(
      () => f.apply(store, f.proposal, candidate),
      /already recorded/u,
    );
  }
  store.close();
  const reopened = f.openStore();
  assert.equal(f.check(reopened, approval.approvalId, f.proposal), false);
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });
});

test("missing, altered, or swapped durable evidence fails closed", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const second = f.newProposal();
  const first = approvalOf(f.apply(store, f.proposal, f.sign(f.proposal)));
  const other = approvalOf(f.apply(store, second, f.sign(second)));
  const database = f.rawDatabase();
  const saved = f.rows();
  const restore = () => {
    database.exec(
      "DELETE FROM git_operator_review_decisions; DELETE FROM git_change_approvals;",
    );
    for (const row of saved.approvals) {
      database
        .prepare(
          `INSERT INTO git_change_approvals
           (approval_id, proposal_id, effect_digest, approval_json, status, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.approval_id,
          row.proposal_id,
          row.effect_digest,
          row.approval_json,
          row.status,
          row.revoked_at,
        );
    }
    for (const row of saved.decisions) {
      database
        .prepare(
          `INSERT INTO git_operator_review_decisions
           (proposal_id, review_digest, decision, review_json, approval_id, received_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.proposal_id,
          row.review_digest,
          row.decision,
          row.review_json,
          row.approval_id,
          row.received_at,
        );
    }
  };
  const decisionOf = (approvalId: string) => {
    const row = saved.decisions.find((item) => item.approval_id === approvalId);
    assert.ok(row);
    return row;
  };
  const approvalJson = (
    approvalId: string,
    change: (approval: Record<string, unknown>) => void,
  ) => {
    const row = saved.approvals.find((item) => item.approval_id === approvalId);
    assert.ok(row);
    const approval = JSON.parse(row.approval_json) as Record<string, unknown>;
    change(approval);
    database
      .prepare(
        `UPDATE git_change_approvals SET approval_json = ?, effect_digest = ?
         WHERE approval_id = ?`,
      )
      .run(JSON.stringify(approval), String(approval.effectDigest), approvalId);
  };
  const resignedJson = (change: Record<string, string>) => {
    const review = JSON.parse(
      decisionOf(first.approvalId).review_json,
    ) as GitOperatorReviewV1;
    const payload = { ...review.payload, ...change };
    database
      .prepare(
        `UPDATE git_operator_review_decisions
         SET review_json = ?, review_digest = ? WHERE approval_id = ?`,
      )
      .run(
        canonicalJson({ ...review, payload }),
        gitOperatorReviewDigest(payload),
        first.approvalId,
      );
  };
  const firstDecision = decisionOf(first.approvalId);
  const otherDecision = decisionOf(other.approvalId);
  const tampering: [string, () => void][] = [
    [
      "missing evidence",
      () => {
        database
          .prepare(
            "DELETE FROM git_operator_review_decisions WHERE approval_id = ?",
          )
          .run(first.approvalId);
      },
    ],
    [
      "signed decision flipped in JSON",
      () => {
        resignedJson({ decision: "deny" });
      },
    ],
    [
      "signed expiry extended in JSON",
      () => {
        resignedJson({
          expiresAt: new Date(Date.now() + 15 * MINUTE).toISOString(),
        });
      },
    ],
    [
      "review digest column altered",
      () => {
        database
          .prepare(
            "UPDATE git_operator_review_decisions SET review_digest = ? WHERE approval_id = ?",
          )
          .run(sha256("other digest"), first.approvalId);
      },
    ],
    [
      "non-canonical stored review JSON",
      () => {
        database
          .prepare(
            "UPDATE git_operator_review_decisions SET review_json = ? WHERE approval_id = ?",
          )
          .run(
            JSON.stringify(JSON.parse(firstDecision.review_json), null, 1),
            first.approvalId,
          );
      },
    ],
    [
      "evidence swapped between proposals",
      () => {
        const update = database.prepare(
          `UPDATE git_operator_review_decisions
           SET review_json = ?, review_digest = ? WHERE proposal_id = ?`,
        );
        update.run("{}", "swap", firstDecision.proposal_id);
        update.run(
          firstDecision.review_json,
          firstDecision.review_digest,
          otherDecision.proposal_id,
        );
        update.run(
          otherDecision.review_json,
          otherDecision.review_digest,
          firstDecision.proposal_id,
        );
      },
    ],
    [
      "approval linkage swapped between proposals",
      () => {
        const update = database.prepare(
          "UPDATE git_operator_review_decisions SET approval_id = ? WHERE proposal_id = ?",
        );
        update.run("swap", firstDecision.proposal_id);
        update.run(first.approvalId, otherDecision.proposal_id);
        update.run(other.approvalId, firstDecision.proposal_id);
      },
    ],
    [
      "decision proposal column altered",
      () => {
        database
          .prepare(
            "UPDATE git_operator_review_decisions SET proposal_id = ? WHERE approval_id = ?",
          )
          .run(sha256("other proposal"), first.approvalId);
      },
    ],
    [
      "decision column unlinked as a denial",
      () => {
        database
          .prepare(
            `UPDATE git_operator_review_decisions
             SET decision = 'deny', approval_id = NULL WHERE approval_id = ?`,
          )
          .run(first.approvalId);
      },
    ],
    [
      "received-at linkage altered",
      () => {
        database
          .prepare(
            "UPDATE git_operator_review_decisions SET received_at = ? WHERE approval_id = ?",
          )
          .run(new Date(0).toISOString(), first.approvalId);
      },
    ],
    [
      "approval expiry extended",
      () => {
        approvalJson(first.approvalId, (approval) => {
          approval.expiresAt = new Date(Date.now() + 15 * MINUTE).toISOString();
        });
      },
    ],
    [
      "candidate tree altered",
      () => {
        approvalJson(first.approvalId, (approval) => {
          approval.candidateTreeOid = "0".repeat(40);
        });
      },
    ],
    [
      "effect digest altered",
      () => {
        approvalJson(first.approvalId, (approval) => {
          approval.effectDigest = sha256("other effect");
        });
      },
    ],
    [
      "authority digest altered",
      () => {
        approvalJson(first.approvalId, (approval) => {
          approval.authorityDigest = sha256("other authority");
        });
      },
    ],
    [
      "approval revoked in the ledger",
      () => {
        database
          .prepare(
            "UPDATE git_change_approvals SET status = 'revoked' WHERE approval_id = ?",
          )
          .run(first.approvalId);
      },
    ],
  ];
  for (const [name, tamper] of tampering) {
    tamper();
    assert.equal(f.check(store, first.approvalId, f.proposal), false, name);
    assert.equal(f.check(store, first.approvalId, second), false, name);
    restore();
  }
  assert.equal(f.check(store, first.approvalId, f.proposal), true);
  assert.equal(f.check(store, other.approvalId, second), true);
  assert.equal(f.check(store, other.approvalId, f.proposal), false);
});

test("changed patch, proposal, plan, policy, catalog, workspace, or ref fails import and match", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const approval = approvalOf(f.apply(store, f.proposal, f.sign(f.proposal)));
  const pending = f.newProposal();
  const pendingReview = f.sign(pending);
  const widened = {
    ...f.proposal,
    allowedPaths: ["src/value.txt", "src/other.txt"],
  };
  const reidentified: GitChangeProposalV1 = {
    ...widened,
    proposalId: digestCanonical(
      Object.fromEntries(
        Object.entries(widened).filter(([key]) => key !== "proposalId"),
      ),
    ),
  };
  const variants: [
    string,
    {
      patch?: Uint8Array;
      context?: GitPlanBindingContext;
      proposal?: GitChangeProposalV1;
    },
  ][] = [
    ["patch", { patch: Buffer.from("other patch\n") }],
    ["proposal", { proposal: reidentified }],
    [
      "proposal integrity",
      { proposal: { ...f.proposal, createdAt: new Date().toISOString() } },
    ],
    [
      "plan",
      { context: { ...f.contextBinding, plans: new InMemoryPlanStore() } },
    ],
    [
      "policy",
      { context: { ...f.contextBinding, currentPolicy: deniedPolicy } },
    ],
    [
      "catalog",
      {
        context: {
          ...f.contextBinding,
          catalogTool: { ...tool, toolName: "other_tool" },
        },
      },
    ],
    [
      "ref",
      {
        context: { ...f.contextBinding, destinationRef: "refs/heads/other" },
      },
    ],
    [
      "repository",
      { context: { ...f.contextBinding, repositoryId: "other/repository" } },
    ],
  ];
  for (const [name, variant] of variants) {
    const { proposal: checkedProposal = f.proposal, ...overrides } = variant;
    assert.equal(
      f.check(store, approval.approvalId, checkedProposal, overrides),
      false,
      name,
    );
    assert.throws(
      () =>
        f.apply(store, variant.proposal ?? pending, pendingReview, overrides),
      Error,
      name,
    );
  }
  writeFileSync(join(f.repositoryPath, "untracked.txt"), "drift\n");
  assert.equal(f.check(store, approval.approvalId, f.proposal), false);
  assert.throws(() => f.apply(store, pending, pendingReview), /must be clean/u);
  rmSync(join(f.repositoryPath, "untracked.txt"));
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });

  assert.equal(f.check(store, approval.approvalId, f.proposal), true);
  approvalOf(f.apply(store, pending, pendingReview));
  f.assertProtected();
  git(f.repositoryPath, "commit", "-q", "--allow-empty", "-m", "moved");
  assert.equal(f.check(store, approval.approvalId, f.proposal), false);
});

test("disabled, removed, or narrowed keys and operators invalidate approvals under current trust", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const approval = approvalOf(f.apply(store, f.proposal, f.sign(f.proposal)));
  const pending = f.newProposal();
  const pendingReview = f.sign(pending);
  const variants: [string, GitOperatorReviewTrustV1][] = [
    [
      "key disabled",
      mutableTrust(f.trust, (trust) => {
        firstOperator(trust).key.enabled = false;
      }),
    ],
    [
      "key removed",
      mutableTrust(f.trust, (trust) => {
        firstOperator(trust).operator.keys = [];
      }),
    ],
    [
      "key rotated",
      mutableTrust(f.trust, (trust) => {
        firstOperator(trust).operator.keys = [
          {
            keyId: gitOperatorKeyId(otherPair.publicKey),
            publicKeyPem: otherPair.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            enabled: true,
          },
        ];
      }),
    ],
    [
      "operator disabled",
      mutableTrust(f.trust, (trust) => {
        firstOperator(trust).operator.enabled = false;
      }),
    ],
    [
      "operator removed",
      mutableTrust(f.trust, (trust) => {
        trust.operators = [];
      }),
    ],
    [
      "permission narrowed to another ref",
      mutableTrust(f.trust, (trust) => {
        firstOperator(trust).permission.destinationRef = "refs/heads/release";
      }),
    ],
    [
      "permission narrowed to another root",
      mutableTrust(f.trust, (trust) => {
        firstOperator(trust).permission.workspaceRootDigest = sha256("other");
      }),
    ],
    [
      "audience changed",
      mutableTrust(f.trust, (trust) => {
        trust.audience = "reprogate:other-host";
      }),
    ],
    [
      "maximum lifetime reduced",
      mutableTrust(f.trust, (trust) => {
        trust.maxReviewTtlMs = 1_000;
      }),
    ],
  ];
  for (const [name, trust] of variants) {
    assert.equal(
      f.check(store, approval.approvalId, f.proposal, { trust }),
      false,
      name,
    );
    assert.throws(
      () => f.apply(store, pending, pendingReview, { trust }),
      /failed authentication/u,
      name,
    );
  }
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });
  assert.equal(f.check(store, approval.approvalId, f.proposal), true);
});

test("post-staging authority, key, and time drift reject import before recording without a held write lock", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const lockFailures: string[] = [];
  const probeWriteLock = () => {
    const probe = new DatabaseSync(f.approvalsPath, { timeout: 0 });
    try {
      probe.exec("BEGIN IMMEDIATE");
      probe.exec("ROLLBACK");
    } catch (error) {
      lockFailures.push(error instanceof Error ? error.message : "unknown");
    } finally {
      probe.close();
    }
  };

  const baseline = observingPlans(f.plans, probeWriteLock);
  const baselineApproval = approvalOf(
    f.apply(store, f.proposal, f.sign(f.proposal), {
      context: { ...f.contextBinding, plans: baseline },
    }),
  );
  assert.equal(
    baseline.calls,
    2,
    "authority is derived before and after staging",
  );
  const checked = observingPlans(f.plans, probeWriteLock);
  assert.equal(
    f.check(store, baselineApproval.approvalId, f.proposal, {
      context: { ...f.contextBinding, plans: checked },
    }),
    true,
  );
  assert.equal(checked.calls, 2);
  assert.deepEqual(lockFailures, []);

  const pending = f.newProposal();
  const trust = structuredClone(f.trust);
  const currentPolicy = structuredClone(policy);
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let shortExpiry = 0;
  const invalidated = /no longer valid under current trust/u;
  const drifts: [string, (call: number) => void, RegExp, number?][] = [
    [
      "key disabled during staging",
      (call) => {
        if (call === 2) firstOperator(trust).key.enabled = false;
      },
      invalidated,
    ],
    [
      "permission removed during staging",
      (call) => {
        if (call === 2) firstOperator(trust).operator.permissions = [];
      },
      invalidated,
    ],
    [
      "policy changed during staging",
      (call) => {
        if (call === 2) currentPolicy.defaults.local_write = "deny";
      },
      /policy has changed/u,
    ],
    [
      "review expired during staging",
      (call) => {
        if (call === 2) context.mock.timers.setTime(shortExpiry + 1);
      },
      invalidated,
      MINUTE,
    ],
  ];
  for (const [name, onGet, expected, lifetime = 10 * MINUTE] of drifts) {
    shortExpiry = Date.now() + lifetime;
    const review = f.sign(pending, {
      expiresAt: new Date(shortExpiry).toISOString(),
    });
    const plans = observingPlans(f.plans, onGet);
    assert.throws(
      () =>
        f.apply(store, pending, review, {
          trust,
          context: { ...f.contextBinding, currentPolicy, plans },
        }),
      expected,
      name,
    );
    assert.equal(plans.calls, 2, name);
    Object.assign(trust, structuredClone(f.trust));
    currentPolicy.defaults.local_write = "approval_required";
  }
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });

  for (const [name, onGet] of drifts.slice(0, 3)) {
    const plans = observingPlans(f.plans, onGet);
    assert.equal(
      f.check(store, baselineApproval.approvalId, f.proposal, {
        trust,
        context: { ...f.contextBinding, currentPolicy, plans },
      }),
      false,
      name,
    );
    Object.assign(trust, structuredClone(f.trust));
    currentPolicy.defaults.local_write = "approval_required";
  }
  approvalOf(f.apply(store, pending, f.sign(pending)));
  f.assertProtected();
});

test("accessors and caller mutation cannot switch the recorded decision, proposal, or patch", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const denied = f.sign(f.proposal, { decision: "deny" });
  const approved = f.sign(f.proposal, {
    expiresAt: new Date(Date.now() + 9 * MINUTE).toISOString(),
  });
  let reads = 0;
  const switching = {
    get payload() {
      reads += 1;
      return reads === 1 ? denied.payload : approved.payload;
    },
    get signature() {
      return reads <= 1 ? denied.signature : approved.signature;
    },
  };
  const result = f.apply(store, f.proposal, switching);
  assert.equal(result.decision, "deny");
  assert.equal(reads, 1);
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 1 });
  assert.equal(f.rows().decisions[0]?.review_json, canonicalJson(denied));

  const pending = f.newProposal();
  const review = f.sign(pending);
  const callerProposal = structuredClone(pending);
  const callerPatch = Buffer.from(f.patch);
  const plans = observingPlans(f.plans, (call) => {
    if (call === 1) {
      callerPatch.fill(0x41);
      callerProposal.allowedPaths.push("src/other.txt");
      callerProposal.workspace.headCommit = "0".repeat(40);
      Object.assign(callerProposal, { proposalId: sha256("switched") });
    }
  });
  const approval = approvalOf(
    applyGitOperatorReviewFromPlan(store, {
      proposal: callerProposal,
      patch: callerPatch,
      context: { ...f.contextBinding, plans },
      trust: f.trust,
      review,
    }),
  );
  assert.equal(approval.proposalId, pending.proposalId);
  assert.equal(f.check(store, approval.approvalId, pending), true);

  let proposalReads = 0;
  const third = f.newProposal();
  const switchingProposal = {
    ...third,
    get workspace() {
      proposalReads += 1;
      return proposalReads === 1
        ? third.workspace
        : { ...third.workspace, headCommit: "0".repeat(40) };
    },
  };
  approvalOf(f.apply(store, switchingProposal, f.sign(third)));
  assert.equal(proposalReads, 1);
  f.assertProtected();
});

test("a failing SQLite trigger rolls back approval and evidence together", (context) => {
  const f = fixture(context);
  const store = f.openStore();
  const database = f.rawDatabase();
  database.exec(`
    CREATE TRIGGER inject_decision_failure
    BEFORE INSERT ON git_operator_review_decisions
    BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END;
  `);
  const review = f.sign(f.proposal);
  assert.throws(
    () => f.apply(store, f.proposal, review),
    /injected decision failure/u,
  );
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
  database.exec("DROP TRIGGER inject_decision_failure");
  const approval = approvalOf(f.apply(store, f.proposal, review));
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });
  assert.equal(f.check(store, approval.approvalId, f.proposal), true);

  const denied = f.newProposal();
  database.exec(`
    CREATE TRIGGER inject_approval_failure
    BEFORE INSERT ON git_change_approvals
    BEGIN SELECT RAISE(ABORT, 'injected approval failure'); END;
  `);
  const another = f.newProposal();
  assert.throws(
    () => f.apply(store, another, f.sign(another)),
    /injected approval failure/u,
  );
  f.apply(store, denied, f.sign(denied, { decision: "deny" }));
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 2 });
});

test("the decision table enforces coherent approval linkage", (context) => {
  let assertDatabaseClosed: () => void = () => {
    assert.fail("The constraint database was not opened");
  };
  // after hooks are FIFO: verify closure before the fixture removes SQLite files.
  context.after(() => {
    assertDatabaseClosed();
  });
  const f = fixture(context);
  f.openStore();
  const database = new DatabaseSync(f.approvalsPath, {
    enableForeignKeyConstraints: true,
  });
  assertDatabaseClosed = () => {
    assert.throws(() => database.prepare("SELECT 1"), /database is not open/u);
  };
  try {
    const insert = database.prepare(
      `INSERT INTO git_operator_review_decisions
     (proposal_id, review_digest, decision, review_json, approval_id, received_at)
     VALUES (?, ?, ?, '{}', ?, '2026-01-01T00:00:00.000Z')`,
    );
    assert.throws(
      () => insert.run(sha256("a"), sha256("a"), "approve", null),
      /CHECK constraint/u,
    );
    assert.throws(
      () => insert.run(sha256("b"), sha256("b"), "deny", "approval"),
      /CHECK constraint/u,
    );
    assert.throws(
      () => insert.run(sha256("c"), sha256("c"), "approve", "missing"),
      /FOREIGN KEY constraint/u,
    );
    assert.throws(
      () => insert.run(sha256("d"), sha256("d"), "maybe", null),
      /CHECK constraint/u,
    );
    insert.run(sha256("e"), sha256("e"), "deny", null);
    assert.throws(
      () => insert.run(sha256("e"), sha256("f"), "deny", null),
      /UNIQUE constraint/u,
    );
    assert.throws(
      () => insert.run(sha256("g"), sha256("e"), "deny", null),
      /UNIQUE constraint/u,
    );
  } finally {
    database.close();
  }
});

interface WorkerResult {
  ok: boolean;
  decision?: "approve" | "deny";
  approvalId?: string | null;
  error?: string;
}

function runWorker(
  inputPath: string,
): Promise<{ code: number | null; result: WorkerResult; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, inputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({
          code,
          result: JSON.parse(stdout) as WorkerResult,
          stderr,
        });
      } catch (error) {
        reject(
          new Error(`Worker output was not JSON: ${stdout} ${stderr}`, {
            cause: error,
          }),
        );
      }
    });
  });
}

test(
  "cross-process approve/approve and approve/deny races record exactly one coherent winner",
  { timeout: 180_000 },
  async (context) => {
    const f = fixture(context);
    f.openStore().close();
    const race = async (
      candidate: GitChangeProposalV1,
      reviews: [GitOperatorReviewV1, GitOperatorReviewV1],
    ) => {
      const startAt = Date.now() + 3_000;
      const paths = reviews.map((review, index) => {
        const path = join(
          f.scratch,
          `worker-${candidate.proposalId.slice(7, 15)}-${String(index)}.json`,
        );
        writeFileSync(
          path,
          JSON.stringify({
            plansPath: f.plansPath,
            approvalsPath: f.approvalsPath,
            repositoryPath: f.repositoryPath,
            repositoryId: f.repositoryId,
            destinationRef: f.destinationRef,
            catalogTool: tool,
            currentPolicy: policy,
            proposal: candidate,
            patchBase64: f.patch.toString("base64"),
            trust: f.trust,
            review,
            startAt,
          }),
        );
        return path;
      });
      const outcomes = await Promise.all(paths.map((path) => runWorker(path)));
      const winners = outcomes.filter((outcome) => outcome.result.ok);
      const losers = outcomes.filter((outcome) => !outcome.result.ok);
      assert.equal(winners.length, 1, JSON.stringify(outcomes));
      assert.equal(losers.length, 1, JSON.stringify(outcomes));
      const [winner] = winners;
      const [loser] = losers;
      assert.ok(winner);
      assert.ok(loser);
      assert.equal(winner.code, 0);
      assert.equal(loser.code, 1);
      assert.match(loser.result.error ?? "", /already recorded/u);
      return winner.result;
    };

    const first = f.newProposal();
    const firstWinner = await race(first, [
      f.sign(first),
      f.sign(first, {
        expiresAt: new Date(Date.now() + 9 * MINUTE).toISOString(),
      }),
    ]);
    assert.equal(firstWinner.decision, "approve");
    const second = f.newProposal();
    const secondWinner = await race(second, [
      f.sign(second),
      f.sign(second, { decision: "deny" }),
    ]);

    const { approvals, decisions } = f.rows();
    const firstDecisions = decisions.filter(
      (row) => row.proposal_id === first.proposalId,
    );
    const secondDecisions = decisions.filter(
      (row) => row.proposal_id === second.proposalId,
    );
    assert.equal(firstDecisions.length, 1);
    assert.equal(secondDecisions.length, 1);
    assert.equal(firstDecisions[0]?.approval_id, firstWinner.approvalId);
    assert.equal(secondDecisions[0]?.decision, secondWinner.decision);
    assert.equal(secondDecisions[0]?.approval_id, secondWinner.approvalId);
    assert.equal(approvals.length, secondWinner.decision === "approve" ? 2 : 1);
    const store = f.openStore();
    assert.equal(
      f.check(store, firstWinner.approvalId ?? "missing", first),
      true,
    );
    if (secondWinner.decision === "approve") {
      assert.equal(
        f.check(store, secondWinner.approvalId ?? "missing", second),
        true,
      );
    }
    f.assertProtected();
  },
);
