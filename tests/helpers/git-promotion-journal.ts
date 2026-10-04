import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "../../src/digest.js";
import { SqliteExecutionStore } from "../../src/execution-store.js";
import {
  SqliteGitApprovalStore,
  type ReserveGitPromotionFromPlanInput,
} from "../../src/git-approval-store.js";
import {
  createGitChangeIntentV2,
  createGitChangeProposalV2,
} from "../../src/git-change-proposal.js";
import { applyGitOperatorReviewFromPlan } from "../../src/git-operator-review-plan.js";
import {
  gitOperatorKeyId,
  signGitOperatorReview,
  type GitOperatorReviewTrustV1,
} from "../../src/git-operator-review.js";
import {
  deriveGitApprovalAuthorityFromPlan,
  type GitPlanBindingContext,
} from "../../src/git-plan-binding.js";
import { gitPromotionTimestampEpoch } from "../../src/git-promotion-contract.js";
import { createGitPromotionHostControl } from "../../src/git-promotion-host-control.js";
import { prepareGitPromotionObjects } from "../../src/git-promotion-objects.js";
import { ReproGateKernel, type PlanStore } from "../../src/kernel.js";
import type { CatalogTool, PolicyV1 } from "../../src/types.js";
// Shared fixtures only: importing this module registers no tests.

export function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args]);
}
export function fixture(
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

export function request(
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
export function reserve(
  f: ReturnType<typeof fixture>,
  overrides: Partial<ReserveGitPromotionFromPlanInput> = {},
) {
  return f.store.reserveGitPromotionFromPlan({ ...request(f), ...overrides });
}
export function registerEpochProjection(db: DatabaseSync) {
  db.function(
    "reprogate_promotion_epoch_ms",
    { deterministic: true },
    gitPromotionTimestampEpoch,
  );
}
export function raw(
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
export function noAttempt(f: ReturnType<typeof fixture>) {
  assert.equal(f.store.getGitPromotionAttempt(f.prepared.attemptId), undefined);
  raw(f, (db) => {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM git_promotion_attempts").get()?.n,
      0,
    );
  });
}
export function firstOperator(trust: GitOperatorReviewTrustV1) {
  const operator = trust.operators[0];
  assert.ok(operator);
  const key = operator.keys[0];
  assert.ok(key);
  const permission = operator.permissions[0];
  assert.ok(permission);
  return { operator, key, permission };
}
export function observingPlans(
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

// Probe the filesystem before creating raw-name regressions. Only demonstrated
// encoding limitations may skip; unexpected permissions/I/O errors still fail.
export function rawFilenameSupported(
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

export function modeledRawFilenameProbe(t: TestContext) {
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

export function copyClosedLedger(
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

export function attemptCount(path: string): number {
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

export function openObserved(t: TestContext, path: string) {
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

// Copy genuine linked approval/review rows into a fresh Store-created ledger.
// No constraints/triggers are removed; failed inserts must not consume anything.
export function linkedJournalProbe(
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
export interface WorkerMessage {
  event: string;
  record?: unknown;
}
export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export function startWorker(
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
        new URL("../fixtures/git-promotion-journal-worker.js", import.meta.url),
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

export async function journalWorkerRegressionGuard<T>(
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

export function noJournalWaiters(
  w: ReturnType<typeof startWorker>,
  reaped = false,
) {
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
