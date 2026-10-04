import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson } from "../src/canonical-json.js";
import {
  gitPromotionTimestampEpoch,
  parseGitPromotionAttempt,
  parsePreparedGitPromotionObjects,
  type GitPromotionAttemptV1,
} from "../src/git-promotion-contract.js";
import { InMemoryPlanStore, type PlanStore } from "../src/kernel.js";
import { createGitChangeProposal } from "../src/git-change-proposal.js";
import test, { type TestContext } from "node:test";
import { digestCanonical, sha256 } from "../src/digest.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import {
  SqliteGitApprovalStore,
  type ReserveGitPromotionFromPlanInput,
} from "../src/git-approval-store.js";
import {
  createGitChangeIntentV2,
  createGitChangeProposalV2,
} from "../src/git-change-proposal.js";
import {
  gitOperatorKeyId,
  signGitOperatorReview,
  type GitOperatorReviewTrustV1,
} from "../src/git-operator-review.js";
import {
  applyGitOperatorReviewFromPlan,
  matchesOperatorReviewedGitApprovalFromPlan,
} from "../src/git-operator-review-plan.js";
import {
  deriveGitApprovalAuthorityFromPlan,
  type GitPlanBindingContext,
} from "../src/git-plan-binding.js";
import { createGitPromotionHostControl } from "../src/git-promotion-host-control.js";
import { prepareGitPromotionObjects } from "../src/git-promotion-objects.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";
import { ReproGateKernel } from "../src/kernel.js";
import type { CatalogTool, PolicyV1 } from "../src/types.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args]);
}
function fixture(
  t: TestContext,
  mode: "approve" | "deny" | "legacy" = "approve",
  format?: "sha256",
  rootName = "repo",
) {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-journal-")),
  );
  const root = join(scratch, rootName);
  mkdirSync(root);
  git(
    root,
    "init",
    "-q",
    "-b",
    "source",
    ...(format ? [`--object-format=${format}`] : []),
  );
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "value.txt"), "before\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "target");
  writeFileSync(join(root, "value.txt"), "after\n");
  const patch = git(root, "diff", "--binary");
  git(root, "restore", "value.txt");
  const tool: CatalogTool = {
    toolRef: "git.change",
    serverRef: "reprogate.git",
    toolName: "promote_patch",
    description: "exact change",
    inputSchema: { type: "object" },
    effects: ["local_write"],
    scopes: ["git_change:promote"],
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
  const plans = new SqliteExecutionStore(join(scratch, "plans.sqlite"));
  const intent = {
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/target",
    patch,
    allowedPaths: ["value.txt"],
    expiresAt: new Date(Date.now() + 1_200_000).toISOString(),
  };
  const plan = new ReproGateKernel([tool], policy, plans).plan({
    toolRef: tool.toolRef,
    arguments: createGitChangeIntentV2(intent),
    ttlMs: 1_800_000,
  });
  const proposal = createGitChangeProposalV2({
    ...intent,
    actionId: plan.envelope.actionId,
    policyDigest: plan.policy.policyDigest,
  });
  const context: GitPlanBindingContext = {
    repositoryPath: root,
    repositoryId: intent.repositoryId,
    destinationRef: intent.destinationRef,
    catalogTool: tool,
    currentPolicy: policy,
    plans,
  };
  const pair = generateKeyPairSync("ed25519");
  const keyId = gitOperatorKeyId(pair.publicKey);
  const trust: GitOperatorReviewTrustV1 = {
    audience: "reprogate:test",
    maxReviewTtlMs: 1_800_000,
    operators: [
      {
        operatorId: "alice",
        enabled: true,
        keys: [
          {
            keyId,
            publicKeyPem: pair.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            enabled: true,
          },
        ],
        permissions: [
          {
            repositoryId: intent.repositoryId,
            workspaceRootDigest: proposal.workspace.rootDigest,
            destinationRef: intent.destinationRef,
          },
        ],
      },
    ],
  };
  const databasePath = join(scratch, "approvals.sqlite");
  const store = new SqliteGitApprovalStore(databasePath);
  const prepared = prepareGitPromotionObjects({
    proposal,
    repositoryPath: root,
    patch,
    attemptId: randomUUID(),
  });
  const review = signGitOperatorReview(
    {
      reviewVersion: 1,
      audience: trust.audience,
      operatorId: "alice",
      keyId,
      decision: mode === "deny" ? "deny" : "approve",
      proposalId: proposal.proposalId,
      authorityDigest: digestCanonical(
        deriveGitApprovalAuthorityFromPlan(proposal, context),
      ),
      effectDigest: prepared.effectDigest,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
    pair.privateKey,
  );
  const result =
    mode === "legacy"
      ? {
          approval: store.grant({
            proposal,
            repositoryPath: root,
            patch,
            authority: deriveGitApprovalAuthorityFromPlan(proposal, context),
            reviewedEffectDigest: prepared.effectDigest,
            expiresAt: review.payload.expiresAt,
          }),
        }
      : applyGitOperatorReviewFromPlan(store, {
          proposal,
          patch,
          context,
          trust,
          review,
        });
  const approval =
    "approval" in result
      ? result.approval
      : { approvalId: randomUUID(), expiresAt: review.payload.expiresAt };
  for (const path of [databasePath, join(scratch, "plans.sqlite")]) {
    for (const suffix of ["", "-wal", "-shm"]) chmodSync(path + suffix, 0o600);
  }
  const hostControl = {
    repositoryPath: root,
    approvalDatabasePath: databasePath,
    fencePath: join(scratch, "fence"),
    statePaths: [join(scratch, "plans.sqlite")],
  };
  const control = createGitPromotionHostControl(hostControl);
  const owner = control.acquire(prepared.attemptId);
  const closers = [
    () => {
      store.close();
    },
    () => {
      plans.close();
    },
  ];
  const asyncClosers: (() => Promise<void>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    // Reap EVERY owned child even if an earlier child fails cleanup. Keep all
    // fixture files when any reap is uncertain; never delete under a writer.
    for (const close of [...asyncClosers].reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const close of closers.reverse()) {
      try {
        close();
      } catch {
        /* already closed */
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Owned journal workers could not all be reaped",
      );
    rmSync(scratch, { recursive: true, force: true });
  });
  const snapshot = () => ({
    head: git(root, "symbolic-ref", "HEAD"),
    refs: git(
      root,
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
    ),
    index: readFileSync(join(root, ".git", "index")),
    file: readFileSync(join(root, "value.txt")),
    status: git(root, "status", "--porcelain=v1", "-z"),
  });
  const before = snapshot();
  return {
    scratch,
    root,
    patch,
    store,
    plans,
    proposal,
    prepared,
    trust,
    context,
    databasePath,
    hostControl,
    owner,
    control,
    approval,
    privateKeyBytes: pair.privateKey.export({ type: "pkcs8", format: "der" }),
    review,
    closers,
    asyncClosers,
    assertProtected: () => {
      assert.deepEqual(snapshot(), before);
    },
  };
}

function request(
  f: ReturnType<typeof fixture>,
): ReserveGitPromotionFromPlanInput {
  return {
    proposal: f.proposal,
    prepared: f.prepared,
    approvalId: f.approval.approvalId,
    context: f.context,
    trust: f.trust,
    hostControl: f.hostControl,
    owner: f.owner,
  };
}
function reserve(
  f: ReturnType<typeof fixture>,
  overrides: Partial<ReserveGitPromotionFromPlanInput> = {},
) {
  return f.store.reserveGitPromotionFromPlan({ ...request(f), ...overrides });
}

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
function registerEpochProjection(db: DatabaseSync) {
  db.function(
    "reprogate_promotion_epoch_ms",
    { deterministic: true },
    gitPromotionTimestampEpoch,
  );
}
function raw(
  f: ReturnType<typeof fixture>,
  operation: (db: DatabaseSync) => void,
) {
  const db = new DatabaseSync(f.databasePath);
  try {
    registerEpochProjection(db);
    operation(db);
  } finally {
    db.close();
  }
}
function noAttempt(f: ReturnType<typeof fixture>) {
  assert.equal(f.store.getGitPromotionAttempt(f.prepared.attemptId), undefined);
  raw(f, (db) => {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM git_promotion_attempts").get()?.n,
      0,
    );
  });
}
function firstOperator(trust: GitOperatorReviewTrustV1) {
  const operator = trust.operators[0];
  assert.ok(operator);
  const key = operator.keys[0];
  assert.ok(key);
  const permission = operator.permissions[0];
  assert.ok(permission);
  return { operator, key, permission };
}
function observingPlans(
  plans: PlanStore,
  observe: (n: number) => void,
): PlanStore {
  let n = 0;
  return {
    save: (plan) => {
      plans.save(plan);
    },
    get: (id) => {
      observe(++n);
      return plans.get(id);
    },
  };
}

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

// Probe the filesystem before creating raw-name regressions. Only demonstrated
// encoding limitations may skip; unexpected permissions/I/O errors still fail.
function rawFilenameSupported(
  t: Pick<TestContext, "skip">,
  scratch: string,
  options: {
    platform?: NodeJS.Platform;
    writeProbe?: (path: string | Buffer) => void;
  } = {},
): boolean {
  const writeProbe =
    options.writeProbe ??
    ((path: string | Buffer) => {
      writeFileSync(path, "probe");
    });
  const name = Buffer.concat([
    Buffer.from("encoding-probe-"),
    Buffer.from([0xff]),
  ]);
  const path = Buffer.concat([Buffer.from(scratch + sep), name]);
  const controlPath = join(scratch, "encoding-probe-valid");
  // Prove this location accepts ordinary filenames before attributing a
  // rejection/normalization specifically to the malformed byte fixture.
  writeProbe(controlPath);
  let created = false;
  try {
    const verifyControl = () => {
      assert.ok(statSync(scratch).isDirectory(), "Probe parent must exist");
      assert.equal(readFileSync(controlPath, "utf8"), "probe");
      assert.deepEqual(
        realpathSync.native(controlPath, { encoding: "buffer" }),
        Buffer.from(controlPath),
        "Ordinary control filename must roundtrip exactly",
      );
    };
    // Ordinary-path failures stay outside the raw-name error classification.
    verifyControl();
    try {
      writeProbe(path);
      created = true;
      const observed = realpathSync.native(path, { encoding: "buffer" });
      const names = readdirSync(scratch, { encoding: "buffer" });
      if (
        !names.some((entry) => entry.equals(name)) &&
        names.some((entry) => entry.equals(Buffer.from(name.toString("utf8"))))
      ) {
        t.skip(
          "Filesystem substituted invalid filename bytes with UTF-8 U+FFFD (byte roundtrip probe)",
        );
        return false;
      }
      assert.deepEqual(observed, path);
      assert.ok(names.some((entry) => entry.equals(name)));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        ["EILSEQ", "EINVAL"].includes(code ?? "") ||
        (!created &&
          (options.platform ?? process.platform) === "win32" &&
          code === "ENOENT")
      ) {
        // Hosted Windows rejects a malformed Buffer filename at creation with
        // ENOENT. Reprove the existing parent/control now, so missing ordinary
        // paths or concurrent fixture deletion can never masquerade as this gap.
        verifyControl();
        assert.equal(
          readdirSync(scratch, { encoding: "buffer" }).some((entry) =>
            entry.equals(name),
          ),
          false,
        );
        t.skip(
          `Filesystem rejected invalid filename bytes with ${String((error as NodeJS.ErrnoException).code)} (byte roundtrip probe)`,
        );
        return false;
      }
      throw error;
    }
  } finally {
    if (created) rmSync(path, { force: true });
    rmSync(controlPath, { force: true });
  }
}

function modeledRawFilenameProbe(t: TestContext) {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate-raw-name-model-")),
  );
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const skips: string[] = [];
  const context = {
    skip: (message?: string) => {
      skips.push(message ?? "");
    },
  };
  return { scratch, skips, context };
}

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

function copyClosedLedger(
  f: ReturnType<typeof fixture>,
  paths: (string | Buffer)[],
) {
  // Closing the last approval handle checkpoints WAL. Close plan handles too,
  // and reopen only after copying: fixtures never copy a live SQLite ledger.
  f.store.close();
  f.plans.close();
  assert.equal(existsSync(f.databasePath + "-wal"), false);
  for (const path of paths) {
    copyFileSync(f.databasePath, path);
    chmodSync(path, 0o600);
  }
  f.plans = new SqliteExecutionStore(join(f.scratch, "plans.sqlite"));
  f.context.plans = f.plans;
  f.closers.push(() => {
    f.plans.close();
  });
}

function attemptCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    return Number(
      db.prepare("SELECT count(*) AS n FROM git_promotion_attempts").get()?.n,
    );
  } finally {
    db.close();
  }
}

function openObserved(t: TestContext, path: string) {
  const closed: DatabaseSync[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the actual connection via call below.
  const close = DatabaseSync.prototype.close;
  const observer = t.mock.method(
    DatabaseSync.prototype,
    "close",
    function (this: DatabaseSync) {
      close.call(this);
      closed.push(this);
    },
  );
  try {
    return {
      store: new SqliteGitApprovalStore(path),
      error: undefined,
      closed,
    };
  } catch (error) {
    return { store: undefined, error, closed };
  } finally {
    observer.mock.restore();
  }
}

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
          1,
          "failed constructor closes its actual private connection",
        );
        assert.throws(
          () => opened.closed[0]?.prepare("SELECT 1"),
          /not open|closed/u,
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

// Copy genuine linked approval/review rows into a fresh Store-created ledger.
// No constraints/triggers are removed; failed inserts must not consume anything.
function linkedJournalProbe(
  f: ReturnType<typeof fixture>,
  operation: (
    db: DatabaseSync,
    row: Record<string, import("node:sqlite").SQLOutputValue>,
    insert: (row: Record<string, import("node:sqlite").SQLOutputValue>) => void,
  ) => void,
) {
  const path = join(f.scratch, `epoch-${randomUUID()}.sqlite`);
  new SqliteGitApprovalStore(path).close();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    registerEpochProjection(db);
    raw(f, (origin) => {
      for (const table of [
        "git_change_approvals",
        "git_operator_review_decisions",
      ]) {
        for (const row of origin.prepare(`SELECT * FROM ${table}`).all()) {
          const columns = Object.keys(row);
          db.prepare(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          ).run(...columns.map((key) => row[key] ?? null));
        }
      }
      const row = origin.prepare("SELECT * FROM git_promotion_attempts").get();
      assert.ok(row);
      const columns = Object.keys(row);
      const statement = db.prepare(
        `INSERT INTO git_promotion_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      const insert = (value: typeof row) => {
        statement.run(...columns.map((key) => value[key] ?? null));
      };
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      operation(db, row, insert);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    });
  } finally {
    db.close();
  }
}

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
interface WorkerMessage {
  event: string;
  record?: unknown;
}
function startWorker(
  f: ReturnType<typeof fixture>,
  mode:
    | "reserve"
    | "before-commit"
    | "after-commit"
    | "wait"
    | "wait-expiry"
    | "silent"
    | "exit-before-event"
    | "event-stall",
  timeoutMs = 10_000,
  execPath = process.execPath,
) {
  const path = join(f.scratch, `worker-${randomUUID()}.json`);
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
      clockAt: f.approval.expiresAt,
      request: { ...request(f), context },
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    execPath,
    [
      fileURLToPath(
        new URL("./fixtures/git-promotion-journal-worker.js", import.meta.url),
      ),
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const events: WorkerMessage[] = [];
  const listeners = new Set<() => void>();
  let buffered = "";
  let stderr = "";
  let workerError: Error | undefined;
  interface WorkerExit {
    code: number | null;
    signal: NodeJS.Signals | null;
  }
  let closedResult: WorkerExit | undefined;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const captureError = (error: Error) => {
    workerError = error;
    notify();
  };
  const captureOutput = (chunk: string) => {
    buffered += chunk;
    try {
      assert.ok(
        Buffer.byteLength(buffered) <= 16 * 1024 * 1024,
        "Owned worker output exceeds bound",
      );
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end === -1) break;
        const message = JSON.parse(buffered.slice(0, end)) as WorkerMessage;
        assert.equal(typeof message.event, "string");
        events.push(message);
        buffered = buffered.slice(end + 1);
      }
    } catch (error) {
      captureError(new Error("Invalid owned worker event", { cause: error }));
    }
    notify();
  };
  const captureStderr = (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  };
  child.stdout.setEncoding("utf8").on("data", captureOutput);
  child.stderr.setEncoding("utf8").on("data", captureStderr);
  // Retain spawn errors even before a wait begins, with no eager rejecting
  // promise. The single lifecycle monitor is removed once stdio is closed.
  child.on("error", captureError);
  child.once("close", (code, signal) => {
    closedResult = { code, signal };
    notify();
    child.off("error", captureError);
    child.stdout.off("data", captureOutput);
    child.stderr.off("data", captureStderr);
  });
  const boundedWait = (
    event: string | undefined,
    waitMs: number,
    stopOwned = false,
  ): Promise<WorkerMessage | WorkerExit> =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
        child.off("exit", onExit);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const check = () => {
        const found =
          event === undefined
            ? closedResult
            : events.find((message) => message.event === event);
        if (found) {
          cleanup();
          resolve(found);
        } else if (workerError && !(stopOwned && child.pid === undefined)) {
          fail(workerError);
        } else if (
          event !== undefined &&
          (closedResult || child.exitCode !== null || child.signalCode !== null)
        ) {
          fail(
            new Error(
              `Worker exited before ${event}: ${String(child.exitCode)}/${String(child.signalCode)}: ${stderr}`,
            ),
          );
        }
      };
      const onExit = () => {
        check();
      };
      const timer = setTimeout(() => {
        fail(
          new Error(
            event === undefined
              ? "Owned journal worker did not close"
              : `Owned journal worker did not emit ${event}`,
          ),
        );
      }, waitMs);
      listeners.add(check);
      child.once("exit", onExit);
      if (
        stopOwned &&
        !closedResult &&
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          assert.ok(child.pid, "Only this owned spawned child may be stopped");
          assert.equal(
            child.exitCode,
            null,
            "Owned worker must be live before kill",
          );
          assert.equal(
            child.signalCode,
            null,
            "Owned worker must be live before kill",
          );
          assert.equal(
            child.kill("SIGKILL"),
            true,
            "Owned worker kill must succeed before waiting for close",
          );
        } catch (error) {
          fail(
            new Error("Owned journal worker could not be stopped", {
              cause: error,
            }),
          );
          return;
        }
      }
      check();
    });
  const stop = async (waitMs = 10_000): Promise<void> => {
    await boundedWait(undefined, waitMs, true);
  };
  f.asyncClosers.push(stop);
  return {
    child,
    events,
    wait: (event: string, waitMs = timeoutMs) =>
      boundedWait(event, waitMs) as Promise<WorkerMessage>,
    get closed() {
      return boundedWait(undefined, timeoutMs) as Promise<WorkerExit>;
    },
    stop,
    pendingWaitCount: () => listeners.size,
  };
}

async function journalWorkerRegressionGuard<T>(
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error("Regression guard: journal worker wait is unbounded"),
          );
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function noJournalWaiters(w: ReturnType<typeof startWorker>, reaped = false) {
  assert.equal(w.pendingWaitCount(), 0, "leftover journal waiter");
  assert.equal(w.child.listenerCount("exit"), 0, "leftover child exit waiter");
  if (reaped) {
    for (const event of ["error", "close"])
      assert.equal(
        w.child.listenerCount(event),
        0,
        `leftover child ${event} listener`,
      );
    assert.equal(w.child.stdout.listenerCount("data"), 0);
    assert.equal(w.child.stderr.listenerCount("data"), 0);
  }
}

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
  { timeout: 60_000 },
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
    { timeout: 60_000 },
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
