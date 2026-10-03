import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { digestCanonical, sha256 } from "../src/digest.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import {
  SqliteGitApprovalStore,
  snapshotGitChangeProposal,
} from "../src/git-approval-store.js";
import {
  createGitChangeIntent,
  createGitChangeIntentV2,
  createGitChangeProposal,
  createGitChangeProposalV2,
  gitChangeIntentFromProposal,
  matchesCurrentGitWorkspace,
  observeCleanGitWorkspace,
  observeGitPromotionWorkspace,
  observeGitWorkspaceForProposal,
  verifyGitChangeProposal,
  type CreateGitChangeProposalInput,
  type GitChangeProposal,
  type GitChangeProposalV1,
  type GitChangeProposalV2,
} from "../src/git-change-proposal.js";
import {
  ownGitChangeProposal,
  parseGitChangeProposalStructure,
  parseGitWorktreeList,
} from "../src/git-change-contract.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";
import {
  authenticateGitOperatorReview,
  gitOperatorKeyId,
  signGitOperatorReview,
  type GitOperatorReviewTrustV1,
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
import { ReproGateKernel } from "../src/kernel.js";
import type { CatalogTool, PolicyV1 } from "../src/types.js";

const MINUTE = 60_000;
// SHA-256 of the V1 schema file as shipped at the Task 1 baseline.
const V1_SCHEMA_SHA256 =
  "sha256:2db36d70f54733ea46eda1f3b87c7ee68f0b393fef51aca56cfd79076b38bf9d";

const operatorPair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");

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

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function commitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "ReproGate Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "ReproGate Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

/** An extra commit on top of HEAD that leaves every ref untouched. */
function orphanCommit(root: string): string {
  return execFileSync(
    "git",
    ["-C", root, "commit-tree", "-p", "HEAD", "-m", "other", "HEAD^{tree}"],
    { encoding: "utf8", env: commitEnv() },
  ).trim();
}

interface Fixture {
  scratch: string;
  root: string;
  closers: (() => void)[];
  patch: Buffer;
}

function newRepository(
  context: TestContext,
  objectFormat?: "sha256",
): Fixture | undefined {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate v2 é ünï ")),
  );
  const closers: (() => void)[] = [];
  context.after(() => {
    // Close databases first; they live inside the directory removed below.
    for (const close of closers.splice(0).reverse()) {
      try {
        close();
      } catch {
        // Already closed by the test.
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = join(scratch, "source repo é");
  mkdirSync(root);
  try {
    git(
      root,
      "init",
      "-q",
      "-b",
      "main",
      ...(objectFormat === undefined
        ? []
        : [`--object-format=${objectFormat}`]),
    );
  } catch (error) {
    if (objectFormat !== undefined) return undefined;
    throw error;
  }
  git(root, "config", "user.name", "ReproGate Test");
  git(root, "config", "user.email", "test@example.invalid");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "value.txt"), "before\n");
  git(root, "add", "src/value.txt");
  git(root, "commit", "-q", "-m", "initial");
  // Reviewer branch is checked out; the destination shares its base but is not.
  git(root, "switch", "-q", "-c", "reviewer");
  git(root, "branch", "target");
  writeFileSync(join(root, "src", "value.txt"), "after\n");
  git(root, "add", "src/value.txt");
  const patch = Buffer.from(git(root, "diff", "--cached", "--binary"));
  git(root, "reset", "-q", "--hard", "HEAD");
  return { scratch, root, closers, patch };
}

function repositoryFixture(context: TestContext): Fixture {
  const fixture = newRepository(context);
  assert.ok(fixture);
  return fixture;
}

function input(fixture: Fixture): CreateGitChangeProposalInput {
  return {
    repositoryPath: fixture.root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/target",
    actionId: sha256("planned action"),
    policyDigest: sha256("policy v1"),
    patch: fixture.patch,
    allowedPaths: ["src/value.txt"],
    expiresAt: new Date(Date.now() + 20 * MINUTE).toISOString(),
  };
}

/** Everything the observer must leave alone, captured without writing. */
function sourceState(root: string): Record<string, string> {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(`${path}=${readFileSync(path, "utf8")}`);
    }
  };
  walk(root);
  return {
    head: git(root, "symbolic-ref", "HEAD"),
    headFile: readFileSync(join(root, ".git", "HEAD"), "utf8"),
    refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: sha256(readFileSync(join(root, ".git", "index"))),
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    worktrees: git(root, "worktree", "list", "--porcelain"),
    files: files.sort().join("\n"),
    objects: git(root, "count-objects", "-v"),
  };
}

function rehash(proposal: GitChangeProposal): GitChangeProposal {
  const unsigned: Record<string, unknown> = { ...proposal };
  delete unsigned.proposalId;
  return {
    ...unsigned,
    proposalId: digestCanonical(unsigned),
  } as unknown as GitChangeProposal;
}

function v2Validator(): ReturnType<Ajv2020["compile"]> {
  const schema = JSON.parse(
    readFileSync("schemas/git-change-proposal-v2.schema.json", "utf8"),
  ) as object;
  // Structural snapshot profile; real canonical UTC time is authenticated by
  // the library's stricter review profile, not a JSON Schema format extension.
  return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
}

function v1Validator(): ReturnType<Ajv2020["compile"]> {
  const schema = JSON.parse(
    readFileSync("schemas/git-change-proposal.schema.json", "utf8"),
  ) as object;
  return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
}

test("V2 constructors bind a reviewer worktree to a distinct unchecked-out destination without writing", (context) => {
  const fixture = repositoryFixture(context);
  const { root } = fixture;
  const requested = input(fixture);
  const before = sourceState(root);
  const baseCommit = git(root, "rev-parse", "HEAD").trim();

  const workspace = observeGitPromotionWorkspace(root, "refs/heads/target");
  assert.deepEqual(workspace, {
    workspaceVersion: 2,
    source: "git_observed",
    destinationMode: "uncheckout_destination",
    rootDigest: sha256(realpathSync.native(root)),
    commonDirDigest: sha256(realpathSync.native(join(root, ".git"))),
    headRef: "refs/heads/reviewer",
    headCommit: baseCommit,
    headTree: git(root, "rev-parse", "HEAD^{tree}").trim(),
    destinationRef: "refs/heads/target",
    destinationOid: baseCommit,
    status: "clean",
  });

  const intent = createGitChangeIntentV2(requested);
  assert.equal(intent.intentVersion, 2);
  assert.deepEqual(intent.workspace, workspace);
  assert.equal(intent.patchDigest, sha256(fixture.patch));

  const proposal = createGitChangeProposalV2(requested);
  assert.equal(proposal.proposalVersion, 2);
  assert.deepEqual(proposal.workspace, workspace);
  assert.equal(verifyGitChangeProposal(proposal), true);
  assert.equal(matchesCurrentGitWorkspace(proposal, root, fixture.patch), true);
  assert.equal(JSON.stringify(proposal).includes("diff --git"), false);
  assert.deepEqual(gitChangeIntentFromProposal(proposal), intent);

  // Observation, intent, proposal and match checks were read-only.
  assert.deepEqual(sourceState(root), before);
  assert.equal(git(root, "rev-parse", "refs/heads/target").trim(), baseCommit);
});

test("V2 schema and runtime parsing agree and V1 schema bytes are unchanged", (context) => {
  const fixture = repositoryFixture(context);
  const proposal = createGitChangeProposalV2(input(fixture));
  const validateV2 = v2Validator();
  const validateV1 = v1Validator();
  assert.equal(validateV2(proposal), true, JSON.stringify(validateV2.errors));
  assert.equal(validateV1(proposal), false);

  const v1 = JSON.parse(
    JSON.stringify(
      createGitChangeProposal({
        ...input(fixture),
        repositoryPath: fixture.root,
        destinationRef: "refs/heads/reviewer",
      }),
    ),
  ) as GitChangeProposalV1;
  assert.equal(validateV1(v1), true);
  assert.equal(validateV2(v1), false);

  const mutations: ((value: Record<string, unknown>) => void)[] = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      delete value.workspace;
    },
    (value) => {
      value.proposalVersion = 1;
    },
    (value) => {
      (value.workspace as Record<string, unknown>).workspaceVersion = 1;
    },
    (value) => {
      (value.workspace as Record<string, unknown>).destinationMode =
        "checkout_destination";
    },
    (value) => {
      delete (value.workspace as Record<string, unknown>).commonDirDigest;
    },
    (value) => {
      delete (value.workspace as Record<string, unknown>).headRef;
    },
    (value) => {
      (value.workspace as Record<string, unknown>).unknown = 1;
    },
    (value) => {
      (value.workspace as Record<string, unknown>).headRef = "main";
    },
    (value) => {
      (value.workspace as Record<string, unknown>).commonDirDigest = "sha256:x";
    },
  ];
  for (const mutate of mutations) {
    const mutated = JSON.parse(JSON.stringify(proposal)) as Record<
      string,
      unknown
    >;
    mutate(mutated);
    assert.equal(validateV2(mutated), false);
    assert.throws(() => snapshotGitChangeProposal(mutated, "any"));
    assert.throws(() => snapshotGitChangeProposal(mutated, 2));
  }
  assert.deepEqual(
    snapshotGitChangeProposal(JSON.parse(JSON.stringify(proposal)), 2),
    proposal,
  );
  assert.deepEqual(
    snapshotGitChangeProposal(JSON.parse(JSON.stringify(proposal)), "any"),
    proposal,
  );

  assert.equal(
    sha256(readFileSync("schemas/git-change-proposal.schema.json")),
    V1_SCHEMA_SHA256,
  );
});

test("strict snapshot reads untrusted input once and enforces version separation", (context) => {
  const fixture = repositoryFixture(context);
  const proposal = createGitChangeProposalV2(input(fixture));

  let reads = 0;
  const hostile = {
    ...proposal,
    get repositoryId(): string {
      reads += 1;
      return reads === 1 ? proposal.repositoryId : "attacker/repository";
    },
  };
  const owned = snapshotGitChangeProposal(
    hostile,
    "any",
  ) as GitChangeProposalV2;
  assert.equal(reads, 1);
  assert.equal(owned.repositoryId, proposal.repositoryId);
  assert.notEqual(owned, proposal);
  assert.notEqual(owned.workspace, proposal.workspace);
  assert.notEqual(owned.allowedPaths, proposal.allowedPaths);
  owned.allowedPaths.push("mutated");
  assert.deepEqual(proposal.allowedPaths, ["src/value.txt"]);

  // The legacy default overload remains V1-only.
  assert.throws(() => snapshotGitChangeProposal(proposal));
  const v1 = createGitChangeProposal({
    ...input(fixture),
    destinationRef: "refs/heads/reviewer",
  });
  assert.deepEqual(snapshotGitChangeProposal(v1), v1);
  assert.deepEqual(snapshotGitChangeProposal(v1, "any"), v1);
  assert.throws(() => snapshotGitChangeProposal(v1, 2));

  // Mixed versions fail even when the self-hash is recomputed.
  const mixedA = rehash({
    ...proposal,
    proposalVersion: 1,
  } as unknown as GitChangeProposal);
  const mixedB = rehash({
    ...v1,
    proposalVersion: 2,
  } as unknown as GitChangeProposal);
  for (const mixed of [mixedA, mixedB]) {
    assert.equal(verifyGitChangeProposal(mixed), true);
    assert.throws(() => snapshotGitChangeProposal(mixed, "any"));
  }
  // V2 invariants: headRef differs from the destination and bases are equal.
  for (const workspace of [
    { ...proposal.workspace, headRef: proposal.workspace.destinationRef },
    { ...proposal.workspace, destinationOid: "0".repeat(40) },
  ]) {
    assert.throws(() =>
      snapshotGitChangeProposal(rehash({ ...proposal, workspace }), "any"),
    );
  }
});

test("V1 observation keeps requiring the destination to be the checked-out branch", (context) => {
  const fixture = repositoryFixture(context);
  assert.throws(
    () => observeCleanGitWorkspace(fixture.root, "refs/heads/target"),
    /checked-out branch/,
  );
  const workspace = observeCleanGitWorkspace(
    fixture.root,
    "refs/heads/reviewer",
  );
  assert.equal("workspaceVersion" in workspace, false);
  assert.equal(workspace.rootDigest, sha256(realpathSync(fixture.root)));
  const intent = createGitChangeIntent({
    ...input(fixture),
    destinationRef: "refs/heads/reviewer",
  });
  assert.equal(intent.intentVersion, 1);
});

test("V2 observation rejects unsafe destinations and sources", (context) => {
  const fixture = repositoryFixture(context);
  const { root } = fixture;
  const reject = (destination: string, pattern?: RegExp) => {
    assert.throws(
      () => observeGitPromotionWorkspace(root, destination),
      pattern ?? /\S/u,
    );
  };

  // The source's own branch, a non-branch ref, and a missing branch.
  reject("refs/heads/reviewer", /must differ/);
  reject("refs/tags/anything", /local branch ref/);
  reject("refs/heads/missing", /direct local branch/);
  reject("refs/heads/bad..name");

  // A symbolic destination.
  git(root, "symbolic-ref", "refs/heads/alias", "refs/heads/target");
  reject("refs/heads/alias", /direct local branch/);
  git(root, "symbolic-ref", "--delete", "refs/heads/alias");

  // Mismatched destination and source base.
  git(root, "update-ref", "refs/heads/target", orphanCommit(root));
  reject("refs/heads/target", /inconsistent/);
  git(root, "update-ref", "refs/heads/target", "HEAD");
  assert.doesNotThrow(() =>
    observeGitPromotionWorkspace(root, "refs/heads/target"),
  );

  // Linked worktree checking out the destination.
  const linked = join(fixture.scratch, "linked worktree");
  git(root, "worktree", "add", "-q", linked, "target");
  reject("refs/heads/target", /checked out in a worktree/);
  git(root, "worktree", "remove", "--force", linked);
  assert.doesNotThrow(() =>
    observeGitPromotionWorkspace(root, "refs/heads/target"),
  );

  // The destination checked out in the primary worktree with a linked source.
  git(root, "switch", "-q", "target");
  reject("refs/heads/target", /must differ/);
  git(root, "switch", "-q", "reviewer");

  // A linked worktree may be the source; the primary checking out the
  // destination still blocks it, and the common directory is the shared one.
  const source = join(fixture.scratch, "linked source");
  git(root, "worktree", "add", "-q", "-b", "linked-reviewer", source);
  const fromLinked = observeGitPromotionWorkspace(source, "refs/heads/target");
  assert.equal(fromLinked.headRef, "refs/heads/linked-reviewer");
  assert.equal(
    fromLinked.commonDirDigest,
    sha256(realpathSync.native(join(root, ".git"))),
  );
  assert.notEqual(fromLinked.rootDigest, sha256(realpathSync.native(root)));
  git(root, "switch", "-q", "target");
  assert.throws(
    () => observeGitPromotionWorkspace(source, "refs/heads/target"),
    /checked out in a worktree/,
  );
  git(root, "switch", "-q", "reviewer");
  git(root, "worktree", "remove", "--force", source);

  // Dirty tracked and untracked files.
  writeFileSync(join(root, "src", "value.txt"), "dirty\n");
  reject("refs/heads/target", /clean/);
  git(root, "restore", "src/value.txt");
  writeFileSync(join(root, "untracked.txt"), "new\n");
  reject("refs/heads/target", /clean/);
  rmSync(join(root, "untracked.txt"));

  // Nested path, bare repository, detached source.
  assert.throws(
    () => observeGitPromotionWorkspace(join(root, "src"), "refs/heads/target"),
    /Git worktree root/,
  );
  const bare = join(fixture.scratch, "bare.git");
  git(fixture.scratch, "clone", "-q", "--bare", root, bare);
  assert.throws(() => observeGitPromotionWorkspace(bare, "refs/heads/target"));

  git(root, "switch", "-q", "--detach");
  assert.throws(
    () => observeGitPromotionWorkspace(root, "refs/heads/target"),
    /symbolic local branch/,
  );
});

test("V2 drift in refs, source branch, common directory or root fails the current-workspace check", (context) => {
  const fixture = repositoryFixture(context);
  const { root } = fixture;
  const requested = input(fixture);
  const proposal = createGitChangeProposalV2(requested);
  const matches = (path = root) =>
    matchesCurrentGitWorkspace(proposal, path, fixture.patch);
  assert.equal(matches(), true);

  // Moved destination, then restored.
  git(root, "update-ref", "refs/heads/target", orphanCommit(root));
  assert.equal(matches(), false);
  git(root, "update-ref", "refs/heads/target", "HEAD");
  assert.equal(matches(), true);

  // Different source branch at the same commit.
  git(root, "switch", "-q", "-c", "other-reviewer");
  assert.equal(matches(), false);
  git(root, "switch", "-q", "reviewer");
  assert.equal(matches(), true);

  // Destination becomes checked out elsewhere.
  const linked = join(fixture.scratch, "linked");
  git(root, "worktree", "add", "-q", linked, "target");
  assert.equal(matches(), false);
  git(root, "worktree", "remove", "--force", linked);
  assert.equal(matches(), true);

  // Forged common directory or root witnesses fail even with a valid self-hash.
  for (const forged of [
    { commonDirDigest: sha256("other common dir") },
    { rootDigest: sha256("other root") },
    { headRef: "refs/heads/elsewhere" },
  ]) {
    const mutated = rehash({
      ...proposal,
      workspace: { ...proposal.workspace, ...forged },
    });
    assert.equal(verifyGitChangeProposal(mutated), true);
    assert.equal(
      matchesCurrentGitWorkspace(mutated, root, fixture.patch),
      false,
    );
  }

  // A byte-identical copy has the same commits but different root and common dir.
  const copy = join(fixture.scratch, "copy");
  cpSync(root, copy, { recursive: true });
  assert.equal(matches(copy), false);
  const moved = join(fixture.scratch, "moved");
  renameSync(copy, moved);
  assert.equal(matches(moved), false);
});

test("V2 observation ignores inherited Git redirection variables", (context) => {
  const fixture = repositoryFixture(context);
  const { root } = fixture;
  const moduleUrl = new URL("../src/git-change-proposal.js", import.meta.url);
  const script = `import { observeGitPromotionWorkspace } from ${JSON.stringify(moduleUrl.href)};
    process.stdout.write(JSON.stringify(observeGitPromotionWorkspace(process.argv[1], "refs/heads/target")));`;
  const observed = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, root],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_DIR: join(root, "not-the-repository"),
        GIT_COMMON_DIR: join(root, "not-the-common-dir"),
        GIT_WORK_TREE: join(root, "src"),
        GIT_INDEX_FILE: join(root, "wrong-index"),
      },
    },
  );
  assert.deepEqual(
    JSON.parse(observed),
    observeGitPromotionWorkspace(root, "refs/heads/target"),
  );
});

test("V2 supports SHA-256 object format repositories", (context) => {
  const fixture = newRepository(context, "sha256");
  if (fixture === undefined) {
    context.skip("This Git build cannot initialise SHA-256 repositories");
    return;
  }
  const proposal = createGitChangeProposalV2(input(fixture));
  assert.equal(proposal.workspace.headCommit.length, 64);
  assert.equal(
    matchesCurrentGitWorkspace(proposal, fixture.root, fixture.patch),
    true,
  );
  const staged = stageGitChangeProposal(proposal, fixture.root, fixture.patch);
  assert.equal(staged.baseCommit, proposal.workspace.headCommit);
  assert.equal(staged.candidateTreeOid.length, 64);
});

interface PlanFixture {
  fixture: Fixture;
  plans: SqliteExecutionStore;
  approvals: () => SqliteGitApprovalStore;
  approvalsPath: string;
  context: GitPlanBindingContext;
  trust: GitOperatorReviewTrustV1;
  proposal: GitChangeProposalV2;
  keyId: ReturnType<typeof gitOperatorKeyId>;
}

function planFixture(context: TestContext): PlanFixture {
  const fixture = repositoryFixture(context);
  const requested = {
    ...input(fixture),
  };
  const plans = new SqliteExecutionStore(join(fixture.scratch, "plans.sqlite"));
  fixture.closers.push(() => {
    plans.close();
  });
  const kernel = new ReproGateKernel([tool], policy, plans);
  const plan = kernel.plan({
    toolRef: tool.toolRef,
    arguments: createGitChangeIntentV2(requested),
    ttlMs: 30 * MINUTE,
  });
  const proposal = createGitChangeProposalV2({
    ...requested,
    actionId: plan.envelope.actionId,
    policyDigest: plan.policy.policyDigest,
  });
  const approvalsPath = join(fixture.scratch, "approvals.sqlite");
  const keyId = gitOperatorKeyId(operatorPair.publicKey);
  return {
    fixture,
    plans,
    approvalsPath,
    approvals: () => {
      const store = new SqliteGitApprovalStore(approvalsPath);
      fixture.closers.push(() => {
        store.close();
      });
      return store;
    },
    context: {
      repositoryPath: fixture.root,
      repositoryId: requested.repositoryId,
      destinationRef: requested.destinationRef,
      catalogTool: tool,
      currentPolicy: policy,
      plans,
    },
    trust: {
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
              repositoryId: requested.repositoryId,
              workspaceRootDigest: proposal.workspace.rootDigest,
              destinationRef: requested.destinationRef,
            },
          ],
        },
      ],
    },
    proposal,
    keyId,
  };
}

function signed(
  fixture: PlanFixture,
  request: {
    proposal: GitChangeProposal;
    authorityDigest: string;
    effectDigest: string;
  },
  privateKey = operatorPair.privateKey,
  overrides: Record<string, unknown> = {},
) {
  return signGitOperatorReview(
    {
      reviewVersion: 1,
      audience: fixture.trust.audience,
      operatorId: "alice",
      keyId: fixture.keyId,
      decision: "approve",
      proposalId: request.proposal.proposalId,
      authorityDigest: request.authorityDigest,
      effectDigest: request.effectDigest,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * MINUTE).toISOString(),
      ...overrides,
    },
    privateKey,
  );
}

function rowCounts(path: string): { approvals: number; decisions: number } {
  const database = new DatabaseSync(path, { readOnly: true });
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
}

test("a persisted V2 plan round-trips prepare, sign, import and check with the unchanged V1 review protocol", (context) => {
  const f = planFixture(context);
  const { fixture, proposal } = f;
  const before = sourceState(fixture.root);
  const refBefore = git(fixture.root, "rev-parse", "refs/heads/target");

  // The persisted exact-action arguments bind the V2 intent.
  const intent = gitChangeIntentFromProposal(proposal);
  assert.equal(intent.intentVersion, 2);
  const plan = f.plans.get(proposal.actionId);
  assert.equal(plan?.envelope.input.argumentsDigest, digestCanonical(intent));
  const authority = deriveGitApprovalAuthorityFromPlan(proposal, f.context);
  assert.equal(authority.workspaceRootDigest, proposal.workspace.rootDigest);

  const { request, stagedPatch } = prepareGitOperatorReviewFromPlan({
    proposal,
    patch: fixture.patch,
    context: f.context,
  });
  assert.equal(request.requestVersion, 2);
  assert.equal(request.proposal.proposalVersion, 2);
  assert.deepEqual(Object.keys(request).sort(), [
    "authority",
    "authorityDigest",
    "effectDigest",
    "proposal",
    "requestVersion",
    "staged",
  ]);
  assert.equal(request.staged.stageVersion, 1);
  assert.deepEqual(Object.keys(request.staged).sort(), [
    "baseCommit",
    "candidateTreeOid",
    "changedPaths",
    "proposalId",
    "stageVersion",
    "stagedPatchDigest",
  ]);
  assert.equal(request.effectDigest, digestCanonical(request.staged));
  assert.equal(request.authorityDigest, digestCanonical(request.authority));
  assert.equal(request.staged.baseCommit, proposal.workspace.headCommit);
  assert.equal(request.staged.stagedPatchDigest, sha256(stagedPatch));
  assert.equal(JSON.stringify(request).includes("diff --git"), false);

  const review = signed(f, request);
  assert.equal(review.payload.reviewVersion, 1);
  const authenticated = authenticateGitOperatorReview(
    review,
    proposal,
    request.authority,
    request.effectDigest,
    f.trust,
  );
  assert.ok(authenticated);
  assert.equal(Object.isFrozen(authenticated), true);
  assert.equal(Object.isFrozen(authenticated.payload), true);

  const store = f.approvals();
  const recorded = applyGitOperatorReviewFromPlan(store, {
    proposal,
    patch: fixture.patch,
    context: f.context,
    trust: f.trust,
    review,
  });
  assert.equal(recorded.decision, "approve");
  assert.equal(recorded.approval.approvalVersion, 1);
  assert.equal(recorded.approval.effectDigest, request.effectDigest);
  assert.equal(recorded.approval.authorityDigest, request.authorityDigest);
  assert.equal(
    matchesOperatorReviewedGitApprovalFromPlan(store, {
      approvalId: recorded.approval.approvalId,
      proposal,
      patch: fixture.patch,
      context: f.context,
      trust: f.trust,
    }),
    true,
  );
  assert.deepEqual(rowCounts(f.approvalsPath), { approvals: 1, decisions: 1 });

  // Foreign keys remain enforced for the signed-decision linkage.
  const raw = new DatabaseSync(f.approvalsPath);
  fixture.closers.push(() => {
    raw.close();
  });
  raw.exec("PRAGMA foreign_keys = ON");
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() =>
    raw
      .prepare(
        `INSERT INTO git_operator_review_decisions
         (proposal_id, review_digest, decision, review_json, approval_id,
          received_at) VALUES (?, ?, 'approve', '{}', 'missing', ?)`,
      )
      .run(sha256("orphan"), sha256("orphan review"), new Date().toISOString()),
  );

  // The whole library path never moved a ref or touched the source worktree.
  assert.deepEqual(sourceState(fixture.root), before);
  assert.equal(git(fixture.root, "rev-parse", "refs/heads/target"), refBefore);
});

test("V1 callers keep a V1 review request and a legacy proposal still prepares", (context) => {
  const f = planFixture(context);
  const { fixture } = f;
  const requested = {
    ...input(fixture),
    destinationRef: "refs/heads/reviewer",
  };
  const kernel = new ReproGateKernel([tool], policy, f.plans);
  const plan = kernel.plan({
    toolRef: tool.toolRef,
    arguments: createGitChangeIntent(requested),
    ttlMs: 30 * MINUTE,
  });
  const v1 = createGitChangeProposal({
    ...requested,
    actionId: plan.envelope.actionId,
    policyDigest: plan.policy.policyDigest,
  });
  assert.equal(gitChangeIntentFromProposal(v1).intentVersion, 1);
  const { request } = prepareGitOperatorReviewFromPlan({
    proposal: v1,
    patch: fixture.patch,
    context: { ...f.context, destinationRef: "refs/heads/reviewer" },
  });
  const version: 1 = request.requestVersion;
  assert.equal(version, 1);
  assert.equal(request.proposal.proposalVersion, 1);
});

test("V2 field, version, key, effect and plan mutations fail closed without recording anything", (context) => {
  const f = planFixture(context);
  const { fixture, proposal } = f;
  const { request } = prepareGitOperatorReviewFromPlan({
    proposal,
    patch: fixture.patch,
    context: f.context,
  });
  const store = f.approvals();
  const apply = (candidate: unknown, review: unknown) =>
    applyGitOperatorReviewFromPlan(store, {
      proposal: candidate as GitChangeProposal,
      patch: fixture.patch,
      context: f.context,
      trust: f.trust,
      review,
    });
  const good = signed(f, request);

  // Wrong key, effect, authority and proposal bindings.
  assert.throws(() =>
    apply(proposal, signed(f, request, otherPair.privateKey)),
  );
  assert.throws(() =>
    apply(
      proposal,
      signed(f, request, undefined, { effectDigest: sha256("x") }),
    ),
  );
  assert.throws(() =>
    apply(
      proposal,
      signed(f, request, undefined, { authorityDigest: sha256("y") }),
    ),
  );
  assert.throws(() =>
    apply(proposal, {
      ...good,
      payload: { ...good.payload, proposalId: sha256("z") },
    }),
  );

  // Tampered proposal fields, with and without a recomputed self-hash.
  const forged: unknown[] = [
    { ...proposal, allowedPaths: ["other.txt"] },
    { ...proposal, proposalVersion: 1 },
    rehash({ ...proposal, allowedPaths: ["src/other.txt"] }),
    rehash({ ...proposal, proposalVersion: 1 } as unknown as GitChangeProposal),
    rehash({
      ...proposal,
      workspace: { ...proposal.workspace, commonDirDigest: sha256("other") },
    }),
    rehash({
      ...proposal,
      workspace: { ...proposal.workspace, headRef: "refs/heads/elsewhere" },
    }),
    rehash({
      ...proposal,
      workspace: { ...proposal.workspace, destinationMode: "checkout" },
    } as unknown as GitChangeProposal),
    { ...proposal, extra: true },
  ];
  for (const candidate of forged) {
    assert.throws(() => apply(candidate, good));
    assert.throws(() =>
      deriveGitApprovalAuthorityFromPlan(
        candidate as GitChangeProposal,
        f.context,
      ),
    );
    assert.equal(
      authenticateGitOperatorReview(
        good,
        candidate as GitChangeProposal,
        request.authority,
        request.effectDigest,
        f.trust,
      ),
      undefined,
    );
  }

  // A plan whose persisted arguments digest binds another intent version.
  const kernel = new ReproGateKernel([tool], policy, f.plans);
  const v1Arguments = kernel.plan({
    toolRef: tool.toolRef,
    arguments: { ...createGitChangeIntentV2(input(fixture)), intentVersion: 1 },
    ttlMs: 30 * MINUTE,
  });
  const mismatched = createGitChangeProposalV2({
    ...input(fixture),
    actionId: v1Arguments.envelope.actionId,
    policyDigest: v1Arguments.policy.policyDigest,
  });
  assert.throws(
    () => deriveGitApprovalAuthorityFromPlan(mismatched, f.context),
    /exact Git change intent/,
  );

  // Source drift after preparation invalidates the proposal.
  git(
    fixture.root,
    "update-ref",
    "refs/heads/target",
    orphanCommit(fixture.root),
  );
  assert.throws(() => apply(proposal, good), /no longer matches|inconsistent/);
  git(fixture.root, "update-ref", "refs/heads/target", "HEAD");

  assert.deepEqual(rowCounts(f.approvalsPath), { approvals: 0, decisions: 0 });

  // The same signed review is still accepted for the exact V2 proposal.
  assert.equal(apply(proposal, good).decision, "approve");
});

test("regression: UTF-8 destination checkout is detected without changing path bytes", (context) => {
  const fixture = repositoryFixture(context);
  const destination = "refs/heads/tárget";
  git(fixture.root, "branch", "tárget");
  assert.doesNotThrow(() =>
    observeGitPromotionWorkspace(fixture.root, destination),
  );
  const linked = join(fixture.scratch, "linked é 工作树");
  git(fixture.root, "worktree", "add", "-q", linked, "tárget");
  const records = parseGitWorktreeList(
    execFileSync("git", [
      "-C",
      fixture.root,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]),
  );
  assert.ok(
    records.some((entry) =>
      entry.path.equals(Buffer.from(realpathSync.native(linked), "utf8")),
    ),
  );
  assert.throws(
    () => observeGitPromotionWorkspace(fixture.root, destination),
    /checked out in a worktree/,
  );
  git(fixture.root, "worktree", "remove", "--force", linked);
  git(fixture.root, "branch", "-m", "reviewer", "réviewer");
  const proposal = createGitChangeProposalV2({
    ...input(fixture),
    destinationRef: destination,
  });
  assert.equal(proposal.workspace.headRef, "refs/heads/réviewer");
  assert.equal(
    matchesCurrentGitWorkspace(proposal, fixture.root, fixture.patch),
    true,
  );
});

test("regression: porcelain requires complete shapes and unique metadata", (context) => {
  const fixture = repositoryFixture(context);
  const oid = git(fixture.root, "rev-parse", "HEAD").trim();
  const record = (...fields: string[]) =>
    Buffer.from(`${fields.join("\0")}\0\0`);
  const invalid = [
    record("worktree /a"),
    record("worktree /a", `HEAD ${oid}`),
    record("worktree /a", "detached"),
    record("worktree /a", "bare", "detached"),
    record("worktree /a", `HEAD ${oid}`, "detached", "locked", "locked again"),
    record(
      "worktree /a",
      `HEAD ${oid}`,
      "branch refs/heads/a",
      "prunable",
      "prunable again",
    ),
    Buffer.concat([
      Buffer.from(`worktree /a\0HEAD ${oid}\0branch refs/heads/`),
      Buffer.from([0xff]),
      Buffer.from("\0\0"),
    ]),
  ];
  const accepted = invalid.flatMap((raw, index) => {
    try {
      parseGitWorktreeList(raw);
      return [index];
    } catch {
      return [];
    }
  });
  assert.deepEqual(accepted, [], "malformed records accepted");
  const rawPath = Buffer.from([0x2f, 0xc3, 0xa9, 0xff]);
  assert.deepEqual(
    parseGitWorktreeList(
      Buffer.concat([
        Buffer.from("worktree "),
        rawPath,
        Buffer.from(`\0HEAD ${oid}\0detached\0\0`),
      ]),
    )[0]?.path,
    rawPath,
  );
  const bare = join(fixture.scratch, "bare.git");
  git(fixture.scratch, "clone", "-q", "--bare", fixture.root, bare);
  const detached = join(fixture.scratch, "detached");
  git(fixture.root, "worktree", "add", "-q", "--detach", detached);
  for (const root of [fixture.root, bare]) {
    assert.doesNotThrow(() =>
      parseGitWorktreeList(
        execFileSync("git", [
          "-C",
          root,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]),
      ),
    );
  }
});

test("regression: rehashed malformed V1 is rejected by every decision boundary", (context) => {
  const f = planFixture(context);
  const requested = {
    ...input(f.fixture),
    destinationRef: "refs/heads/reviewer",
  };
  const plan = new ReproGateKernel([tool], policy, f.plans).plan({
    toolRef: tool.toolRef,
    arguments: createGitChangeIntent(requested),
    ttlMs: 30 * MINUTE,
  });
  const proposal = createGitChangeProposal({
    ...requested,
    actionId: plan.envelope.actionId,
    policyDigest: plan.policy.policyDigest,
  });
  const planContext = {
    ...f.context,
    destinationRef: requested.destinationRef,
  };
  const bad = [
    rehash({ ...proposal, extra: true } as GitChangeProposal),
    rehash({
      ...proposal,
      workspace: { ...proposal.workspace, extra: true },
    } as GitChangeProposal),
  ];
  const failures: string[] = [];
  for (const candidate of bad) {
    assert.equal(verifyGitChangeProposal(candidate), true);
    const checks: Record<string, () => void> = {
      snapshot: () => {
        assert.throws(() => snapshotGitChangeProposal(candidate, "any"));
      },
      own: () => {
        assert.throws(() => ownGitChangeProposal(candidate));
      },
      matches: () => {
        assert.equal(
          matchesCurrentGitWorkspace(
            candidate,
            f.fixture.root,
            f.fixture.patch,
          ),
          false,
        );
      },
      stage: () => {
        assert.throws(() =>
          stageGitChangeProposal(candidate, f.fixture.root, f.fixture.patch),
        );
      },
      intent: () => {
        assert.throws(() => gitChangeIntentFromProposal(candidate));
      },
      plan: () => {
        assert.throws(() =>
          deriveGitApprovalAuthorityFromPlan(candidate, planContext),
        );
      },
      prepare: () => {
        assert.throws(() =>
          prepareGitOperatorReviewFromPlan({
            proposal: candidate,
            patch: f.fixture.patch,
            context: planContext,
          }),
        );
      },
    };
    for (const [name, check] of Object.entries(checks)) {
      try {
        check();
      } catch {
        failures.push(name);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("regression: caller fields including discriminators are captured once before dispatch", (context) => {
  const f = planFixture(context);
  const failures: string[] = [];
  const operations: Record<string, (p: GitChangeProposal) => unknown> = {
    any: (p) => parseGitChangeProposalStructure(p, "snapshot", "any"),
    direct: (p) => parseGitChangeProposalStructure(p, "snapshot", 2),
    own: ownGitChangeProposal,
    snapshot: (p) => snapshotGitChangeProposal(p, "any"),
    intent: gitChangeIntentFromProposal,
    matches: (p) => {
      assert.equal(
        matchesCurrentGitWorkspace(p, f.fixture.root, f.fixture.patch),
        true,
      );
    },
    stage: (p) => stageGitChangeProposal(p, f.fixture.root, f.fixture.patch),
    plan: (p) => deriveGitApprovalAuthorityFromPlan(p, f.context),
    prepare: (p) =>
      prepareGitOperatorReviewFromPlan({
        proposal: p,
        patch: f.fixture.patch,
        context: f.context,
      }),
  };
  for (const [name, operation] of Object.entries(operations)) {
    const counts: Record<string, number> = {};
    const once = (key: string, value: unknown) => {
      counts[key] = (counts[key] ?? 0) + 1;
      return value;
    };
    const paths = [...f.proposal.allowedPaths];
    Object.defineProperty(paths, "0", {
      enumerable: true,
      configurable: true,
      get: () => once("path", f.proposal.allowedPaths[0]),
    });
    const workspace = {
      ...f.proposal.workspace,
      get headRef() {
        return once("headRef", f.proposal.workspace.headRef);
      },
    };
    const hostile = {
      ...f.proposal,
      get proposalVersion() {
        return once("version", 2);
      },
      get repositoryId() {
        return once("repository", f.proposal.repositoryId);
      },
      get workspace() {
        return once("workspace", workspace);
      },
      get allowedPaths() {
        return once("paths", paths);
      },
    } as GitChangeProposal;
    try {
      operation(hostile);
      assert.deepEqual(counts, {
        version: 1,
        repository: 1,
        workspace: 1,
        headRef: 1,
        paths: 1,
        path: 1,
      });
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("regression: V2 structural schema agrees on bounds, uniqueness, times, digests and OIDs", (context) => {
  const proposal = createGitChangeProposalV2(input(repositoryFixture(context)));
  const validate = v2Validator();
  const failures: string[] = [];
  const cases: [string, Partial<GitChangeProposalV2>, boolean][] = [
    ["repo boundary", { repositoryId: "x".repeat(256) }, true],
    ["repo overlong", { repositoryId: "x".repeat(257) }, false],
    [
      "ref boundary",
      {
        workspace: {
          ...proposal.workspace,
          headRef: "refs/heads/" + "x".repeat(1013),
        },
      },
      true,
    ],
    [
      "ref overlong",
      {
        workspace: {
          ...proposal.workspace,
          headRef: "refs/heads/" + "x".repeat(1014),
        },
      },
      false,
    ],
    ["path boundary", { allowedPaths: ["x".repeat(4096)] }, true],
    ["path overlong", { allowedPaths: ["x".repeat(4097)] }, false],
    ["duplicates", { allowedPaths: ["x", "x"] }, false],
    ["time boundary", { createdAt: "x".repeat(64) }, true],
    ["time overlong", { createdAt: "x".repeat(65) }, false],
    ["empty time", { createdAt: "" }, false],
    [
      "digest newline",
      {
        patchDigest: (sha256("x") + "\n") as GitChangeProposalV2["patchDigest"],
      },
      false,
    ],
    [
      "OID newline",
      { workspace: { ...proposal.workspace, headTree: "a".repeat(40) + "\n" } },
      false,
    ],
    [
      "SHA256 OID",
      { workspace: { ...proposal.workspace, headTree: "a".repeat(64) } },
      true,
    ],
    [
      "uppercase OID",
      { workspace: { ...proposal.workspace, headTree: "A".repeat(40) } },
      false,
    ],
  ];
  for (const field of ["repositoryId", "createdAt", "expiresAt"] as const) {
    const limit = field === "repositoryId" ? 256 : 64;
    cases.push(
      [`${field} empty`, { [field]: "" }, false],
      [`${field} limit`, { [field]: "x".repeat(limit) }, true],
      [`${field} overflow`, { [field]: "x".repeat(limit + 1) }, false],
      [`${field} Unicode limit`, { [field]: "😀".repeat(limit) }, true],
      [`${field} Unicode overflow`, { [field]: "😀".repeat(limit + 1) }, false],
    );
  }
  for (const field of ["headRef", "destinationRef"] as const) {
    cases.push(
      [
        `${field} empty`,
        { workspace: { ...proposal.workspace, [field]: "" } },
        false,
      ],
      [
        `${field} minimum prefix`,
        { workspace: { ...proposal.workspace, [field]: "refs/heads/" } },
        true,
      ],
      [
        `${field} Unicode limit`,
        {
          workspace: {
            ...proposal.workspace,
            [field]: "refs/heads/" + "😀".repeat(1024 - "refs/heads/".length),
          },
        },
        true,
      ],
      [
        `${field} limit`,
        {
          workspace: {
            ...proposal.workspace,
            [field]: "refs/heads/".padEnd(1024, "x"),
          },
        },
        true,
      ],
      [
        `${field} overflow`,
        {
          workspace: {
            ...proposal.workspace,
            [field]: "refs/heads/".padEnd(1025, "x"),
          },
        },
        false,
      ],
    );
  }
  for (const field of ["headTree", "headCommit", "destinationOid"] as const) {
    for (const oid of [
      "",
      "a".repeat(39),
      "a".repeat(41),
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(40),
      "a".repeat(40) + "\n",
    ]) {
      cases.push([
        `${field} invalid OID`,
        { workspace: { ...proposal.workspace, [field]: oid } },
        false,
      ]);
    }
  }
  cases.push(
    ["path Unicode limit", { allowedPaths: ["😀".repeat(4096)] }, true],
    ["path Unicode overflow", { allowedPaths: ["😀".repeat(4097)] }, false],
    ["empty path", { allowedPaths: [""] }, false],
    ["no paths", { allowedPaths: [] }, false],
    [
      "path count limit",
      {
        allowedPaths: Array.from(
          { length: 256 },
          (_, index) => `path${String(index)}`,
        ),
      },
      true,
    ],
    [
      "path count overflow",
      {
        allowedPaths: Array.from(
          { length: 257 },
          (_, index) => `path${String(index)}`,
        ),
      },
      false,
    ],
  );
  for (const [name, mutation, expected] of cases) {
    const candidate = rehash({ ...proposal, ...mutation });
    let runtime = false;
    try {
      snapshotGitChangeProposal(candidate, "any");
      runtime = true;
    } catch {
      /* rejected */
    }
    const schema = validate(candidate) === true;
    if (schema !== expected || runtime !== expected)
      failures.push(
        `${name}: schema=${String(schema)} runtime=${String(runtime)} expected=${String(expected)}`,
      );
  }
  for (const field of ["createdAt", "expiresAt"] as const) {
    for (const value of [null, 7, true, {}, []]) {
      const candidate = { ...proposal, [field]: value };
      assert.equal(validate(candidate), false);
      assert.throws(() =>
        parseGitChangeProposalStructure(candidate, "snapshot", "any"),
      );
    }
  }
  assert.deepEqual(failures, []);
});

function accessorProposal(proposal: GitChangeProposal): {
  hostile: GitChangeProposal;
  counts: Record<string, number>;
  expected: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const expected: Record<string, number> = {};
  const accessor = (
    target: object,
    key: string,
    label: string,
    value: unknown,
  ) => {
    expected[label] = 1;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        counts[label] = (counts[label] ?? 0) + 1;
        return counts[label] === 1 ? value : undefined;
      },
    });
  };
  const workspace = { ...proposal.workspace };
  for (const [key, value] of Object.entries(proposal.workspace)) {
    accessor(workspace, key, `workspace.${key}`, value);
  }
  const paths = [...proposal.allowedPaths];
  for (const [index, value] of proposal.allowedPaths.entries()) {
    accessor(paths, String(index), `allowedPaths.${String(index)}`, value);
  }
  const hostile = { ...proposal };
  for (const [key, value] of Object.entries(proposal)) {
    accessor(
      hostile,
      key,
      key,
      key === "workspace" ? workspace : key === "allowedPaths" ? paths : value,
    );
  }
  return { hostile, counts, expected };
}

test("both versions consume detached once-read snapshots through plan, ledger and authentication flows", (context) => {
  const f = planFixture(context);
  const requested = {
    ...input(f.fixture),
    destinationRef: "refs/heads/reviewer",
  };
  const plan = new ReproGateKernel([tool], policy, f.plans).plan({
    toolRef: tool.toolRef,
    arguments: createGitChangeIntent(requested),
    ttlMs: 30 * MINUTE,
  });
  const v1 = createGitChangeProposal({
    ...requested,
    actionId: plan.envelope.actionId,
    policyDigest: plan.policy.policyDigest,
  });
  for (const proposal of [v1, f.proposal]) {
    const planContext = {
      ...f.context,
      destinationRef: proposal.workspace.destinationRef,
    };
    const { request } = prepareGitOperatorReviewFromPlan({
      proposal,
      patch: f.fixture.patch,
      context: planContext,
    });
    const review = signed(f, request);
    const trust = {
      ...f.trust,
      operators: f.trust.operators.map((operator) => ({
        ...operator,
        permissions: operator.permissions.map((permission) => ({
          ...permission,
          destinationRef: proposal.workspace.destinationRef,
        })),
      })),
    };
    const store = f.approvals();
    let approvalId = "";
    const operations: Record<string, (p: GitChangeProposal) => unknown> = {
      any: (p) => parseGitChangeProposalStructure(p, "snapshot", "any"),
      direct: (p) =>
        parseGitChangeProposalStructure(
          p,
          "snapshot",
          proposal.proposalVersion,
        ),
      review: (p) => parseGitChangeProposalStructure(p, "review", "any"),
      snapshot: (p) => snapshotGitChangeProposal(p, "any"),
      own: ownGitChangeProposal,
      intent: gitChangeIntentFromProposal,
      observe: (p) => observeGitWorkspaceForProposal(p, f.fixture.root),
      matches: (p) => {
        assert.equal(
          matchesCurrentGitWorkspace(p, f.fixture.root, f.fixture.patch),
          true,
        );
      },
      stage: (p) => stageGitChangeProposal(p, f.fixture.root, f.fixture.patch),
      plan: (p) => deriveGitApprovalAuthorityFromPlan(p, planContext),
      prepare: (p) =>
        prepareGitOperatorReviewFromPlan({
          proposal: p,
          patch: f.fixture.patch,
          context: planContext,
        }),
      authenticate: (p) => {
        const authenticated = authenticateGitOperatorReview(
          review,
          p,
          request.authority,
          request.effectDigest,
          trust,
        );
        assert.equal(authenticated?.payload.decision, "approve");
        assert.equal(Object.isFrozen(authenticated.payload), true);
      },
      grant: (p) => {
        approvalId = grantGitChangeFromPlan(store, {
          proposal: p,
          patch: f.fixture.patch,
          context: planContext,
          reviewedEffectDigest: request.effectDigest,
          expiresAt: new Date(Date.now() + MINUTE).toISOString(),
        }).approvalId;
      },
      ledgerMatch: (p) => {
        assert.equal(
          matchesGitApprovalFromPlan(store, {
            proposal: p,
            approvalId,
            patch: f.fixture.patch,
            context: planContext,
          }),
          true,
        );
      },
    };
    for (const [name, operation] of Object.entries(operations)) {
      const { hostile, counts, expected } = accessorProposal(proposal);
      operation(hostile);
      assert.deepEqual(counts, expected, name);
    }
    const intent = gitChangeIntentFromProposal(proposal);
    assert.notEqual(intent.workspace, proposal.workspace);
    assert.notEqual(intent.allowedPaths, proposal.allowedPaths);
    intent.allowedPaths.push("unsigned");
    intent.workspace.destinationRef = "refs/heads/unsigned";
    assert.equal(verifyGitChangeProposal(proposal), true);
  }
});

test("bounded capture rejects hostile, circular, inherited, sparse and switching-version shapes without normalization", (context) => {
  const fixture = repositoryFixture(context);
  const proposal = createGitChangeProposalV2(input(fixture));
  const v1 = createGitChangeProposal({
    ...input(fixture),
    destinationRef: "refs/heads/reviewer",
  });
  const sparse = new Array<string>(1);
  let normalizationCalls = 0;
  const oversized: unknown[] = [];
  oversized.length = 1_000_000;
  const circular = { ...proposal, repositoryId: {} };
  circular.repositoryId = circular;
  const inputs: unknown[] = [
    circular,
    { ...proposal, workspace: proposal },
    { ...proposal, allowedPaths: [proposal] },
    { ...proposal, allowedPaths: oversized },
    { ...proposal, allowedPaths: sparse },
    {
      ...proposal,
      allowedPaths: Object.assign([...proposal.allowedPaths], { extra: true }),
    },
    { ...proposal, allowedPaths: ["x".repeat(8193)] },
    {
      ...proposal,
      repositoryId: {
        toJSON() {
          normalizationCalls += 1;
          return proposal.repositoryId;
        },
      },
    },
    {
      ...proposal,
      toJSON() {
        normalizationCalls += 1;
        return proposal;
      },
    },
    Object.create(proposal),
    Object.setPrototypeOf({ ...proposal }, { inherited: true }),
    {
      ...proposal,
      workspace: Object.setPrototypeOf(
        { ...proposal.workspace },
        { inherited: true },
      ) as unknown,
    },
    { ...proposal, [Symbol("extra")]: true },
    Object.defineProperty({ ...proposal }, "extra", {
      value: true,
      enumerable: false,
    }),
    Object.defineProperty({ ...proposal }, "repositoryId", {
      get() {
        throw new Error("hostile getter");
      },
      enumerable: true,
    }),
  ];
  for (const hostile of inputs) {
    assert.throws(() =>
      parseGitChangeProposalStructure(hostile, "snapshot", "any"),
    );
  }
  assert.equal(normalizationCalls, 0);
  for (const [version, workspace] of [
    [1, proposal.workspace],
    [2, v1.workspace],
  ] as const) {
    let reads = 0;
    const switching = {
      ...proposal,
      workspace,
      get proposalVersion() {
        reads += 1;
        return reads === 1 ? version : version === 1 ? 2 : 1;
      },
    } as unknown as GitChangeProposal;
    assert.throws(() => snapshotGitChangeProposal(switching, "any"));
    assert.equal(reads, 1);
  }
  const plainNull = Object.assign(
    Object.create(null) as Record<string, unknown>,
    proposal,
  );
  assert.deepEqual(snapshotGitChangeProposal(plainNull, "any"), proposal);
  const keyReads = { root: 0, workspace: 0, paths: 0 };
  const proxy = <T extends object>(target: T, label: keyof typeof keyReads) =>
    new Proxy(target, {
      ownKeys(value) {
        keyReads[label] += 1;
        if (keyReads[label] !== 1) throw new Error("Shape reread");
        return Reflect.ownKeys(value);
      },
      get() {
        throw new Error("Original property reread");
      },
    });
  const proxyRoot = proxy(
    {
      ...proposal,
      workspace: proxy({ ...proposal.workspace }, "workspace"),
      allowedPaths: proxy([...proposal.allowedPaths], "paths"),
    },
    "root",
  );
  assert.deepEqual(snapshotGitChangeProposal(proxyRoot, "any"), proposal);
  assert.deepEqual(keyReads, { root: 1, workspace: 1, paths: 1 });
});

test("structural snapshots never replace strict operator-review identity, ref and real-time validation", (context) => {
  const f = planFixture(context);
  const { request } = prepareGitOperatorReviewFromPlan({
    proposal: f.proposal,
    patch: f.fixture.patch,
    context: f.context,
  });
  const mutations: Partial<GitChangeProposalV2>[] = [
    { repositoryId: "repository identity with spaces" },
    { workspace: { ...f.proposal.workspace, headRef: "refs/heads/bad..ref" } },
    {
      workspace: {
        ...f.proposal.workspace,
        destinationRef: "refs/heads/tárget",
      },
    },
    { createdAt: "2026-02-30T00:00:00.000Z" },
    { createdAt: "2026-01-01T00:00:00Z" },
    { createdAt: "not a timestamp" },
  ];
  for (const mutation of mutations) {
    const candidate = rehash({ ...f.proposal, ...mutation });
    assert.doesNotThrow(() => snapshotGitChangeProposal(candidate, "any"));
    assert.throws(() =>
      parseGitChangeProposalStructure(candidate, "review", "any"),
    );
    const review = signed(f, { ...request, proposal: candidate });
    assert.equal(
      authenticateGitOperatorReview(
        review,
        candidate,
        request.authority,
        request.effectDigest,
        f.trust,
      ),
      undefined,
    );
  }
});

test("the porcelain worktree parser accepts real records and fails closed otherwise", () => {
  const oid = "a".repeat(40);
  const record = (...attributes: string[]) => `${attributes.join("\0")}\0\0`;
  const valid =
    record("worktree /a b/é", `HEAD ${oid}`, "branch refs/heads/main") +
    record("worktree /detached", `HEAD ${oid}`, "detached", "locked why\nnot") +
    record("worktree /bare", "bare") +
    record(
      "worktree /gone",
      `HEAD ${oid}`,
      "branch refs/heads/x",
      "prunable gone",
    );
  const parsed = parseGitWorktreeList(Buffer.from(valid, "utf8"));
  assert.deepEqual(
    parsed.map((entry) => entry.branch),
    ["refs/heads/main", undefined, undefined, "refs/heads/x"],
  );
  assert.equal(parsed[0]?.path.toString("utf8"), "/a b/é");

  const malformed = [
    "",
    "\0\0",
    valid.slice(0, -1),
    valid.slice(0, -2),
    record("HEAD " + oid),
    record("worktree "),
    record("worktree /a", "HEAD nothex"),
    record("worktree /a", `HEAD ${oid}`, `HEAD ${oid}`),
    record(
      "worktree /a",
      `HEAD ${oid}`,
      "branch refs/heads/a",
      "branch refs/heads/b",
    ),
    record("worktree /a", "branch refs/heads/a"),
    record("worktree /a", `HEAD ${oid}`, "detached", "branch refs/heads/a"),
    record("worktree /a", "bare", `HEAD ${oid}`),
    record("worktree /a", "unknown value"),
    record("worktree /a", "branch heads/a", `HEAD ${oid}`),
    record("worktree /a") + "worktree /b\0",
    record("worktree /a").repeat(1025),
  ];
  for (const raw of malformed) {
    assert.throws(() => parseGitWorktreeList(Buffer.from(raw, "utf8")));
  }
});
