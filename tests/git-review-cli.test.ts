import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { sha256 } from "../src/digest.js";
import { SqliteExecutionStore } from "../src/execution-store.js";
import {
  createGitChangeIntent,
  createGitChangeProposal,
  type GitChangeProposalV1,
} from "../src/git-change-proposal.js";
import {
  gitOperatorKeyId,
  type GitOperatorReviewTrustV1,
} from "../src/git-operator-review.js";
import type { GitOperatorReviewRequestV1 } from "../src/git-operator-review-plan.js";
import { GIT_CHANGE_PROMOTE_SCOPE } from "../src/git-plan-binding.js";
import {
  escapeUntrustedText,
  renderUntrustedBytes,
  runGitReviewCli,
} from "../src/git-review-cli.js";
import {
  gitReviewConfigDigest,
  loadGitReviewConfig,
  parseGitReviewConfig,
  type GitReviewConfigV1,
} from "../src/git-review-config.js";
import { ReproGateKernel } from "../src/kernel.js";
import type { CatalogTool, PolicyV1 } from "../src/types.js";

const MINUTE = 60_000;
const PATCH_MARKER = "reprogate-cli-raw-patch-marker-7c2e";
const INPUT_MARKER = "reprogate-untrusted-input-marker-91ab";
const POSIX = process.platform !== "win32";
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const schemaDirectory = fileURLToPath(
  new URL("../../schemas/", import.meta.url),
);

const operatorPair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const operatorPem = operatorPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function pemBody(pem: string): string {
  return pem
    .split(/\r?\n/u)
    .filter((line) => line !== "" && !line.startsWith("-----"))
    .join("");
}

function secretNeedles(pem: string, jwkSeed: string): (string | Buffer)[] {
  const seed = Buffer.from(jwkSeed, "base64url");
  return [
    pemBody(pem),
    ...pem.split(/\r?\n/u).filter((line) => line.length > 20),
    jwkSeed,
    seed.toString("hex"),
    seed.toString("base64"),
    seed,
  ];
}

const operatorSecrets = secretNeedles(
  operatorPem,
  (operatorPair.privateKey.export({ format: "jwk" }) as { d: string }).d,
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

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

interface CliResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  out: string;
  err: string;
}

function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: null,
    env: options.env ?? process.env,
    cwd: options.cwd,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    out: result.stdout.toString("utf8"),
    err: result.stderr.toString("utf8"),
  };
}

function assertNoNeedles(
  needles: (string | Buffer)[],
  ...outputs: (string | Buffer)[]
): void {
  for (const output of outputs) {
    const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
    for (const needle of needles) {
      assert.equal(
        bytes.includes(needle),
        false,
        "secret or untrusted input bytes were disclosed",
      );
    }
  }
}

function assertAsciiJsonLine(result: CliResult): unknown {
  assert.match(result.out, /^[\x20-\x7e]+\n$/u);
  return JSON.parse(result.out) as unknown;
}

/** Fail-closed command: nonzero, no stdout, sanitized one-line-per-error stderr. */
function assertFailed(result: CliResult, pattern?: RegExp): void {
  assert.equal(result.status, 1, result.err);
  assert.equal(result.out, "");
  if (pattern !== undefined) assert.match(result.err, pattern);
}

function assertUsage(result: CliResult, pattern?: RegExp): void {
  assert.equal(result.status, 2, result.err);
  assert.equal(result.out, "");
  if (pattern !== undefined) assert.match(result.err, pattern);
}

interface FixtureOptions {
  files?: Record<string, Uint8Array>;
}

interface Env {
  env?: NodeJS.ProcessEnv;
}

function fixture(context: TestContext, options: FixtureOptions = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-git-review-cli-"));
  context.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const repositoryPath = join(scratch, "repository");
  const statePath = join(scratch, "state");
  const keysPath = join(scratch, "keys");
  mkdirSync(repositoryPath);
  mkdirSync(statePath);
  mkdirSync(keysPath, { mode: 0o700 });
  git(repositoryPath, "init", "-q", "-b", "main");
  git(repositoryPath, "config", "user.name", "ReproGate Test");
  git(repositoryPath, "config", "user.email", "test@example.invalid");
  mkdirSync(join(repositoryPath, "src"));
  writeFileSync(join(repositoryPath, "src", "value.txt"), "before\n");
  git(repositoryPath, "add", "src/value.txt");
  git(repositoryPath, "commit", "-q", "-m", "initial");
  const files = options.files ?? {
    "src/value.txt": Buffer.from(`after ${PATCH_MARKER}\n`),
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(repositoryPath, path)), { recursive: true });
    writeFileSync(join(repositoryPath, path), bytes);
  }
  const allowedPaths = Object.keys(files);
  git(repositoryPath, "add", "--", ...allowedPaths);
  const patch = execFileSync("git", [
    "-C",
    repositoryPath,
    "diff",
    "--cached",
    "--binary",
  ]);
  git(repositoryPath, "reset", "-q", "--hard", "HEAD");

  const repositoryId = "example/repository";
  const destinationRef = "refs/heads/main";
  const intentInput = {
    repositoryPath,
    repositoryId,
    destinationRef,
    patch,
    allowedPaths,
    expiresAt: new Date(Date.now() + 40 * MINUTE).toISOString(),
  };
  const plansPath = join(statePath, "plans.sqlite");
  const plans = new SqliteExecutionStore(plansPath);
  let plan;
  try {
    plan = new ReproGateKernel([tool], policy, plans).plan({
      toolRef: tool.toolRef,
      arguments: createGitChangeIntent(intentInput),
      ttlMs: 60 * MINUTE,
    });
  } finally {
    plans.close();
  }
  let lastCreatedAt = 0;
  const newProposal = (): GitChangeProposalV1 => {
    while (Date.now() <= lastCreatedAt) sleep(1);
    const created = createGitChangeProposal({
      ...intentInput,
      actionId: plan.envelope.actionId,
      policyDigest: plan.policy.policyDigest,
    });
    lastCreatedAt = Date.parse(created.createdAt);
    return created;
  };
  const proposal = newProposal();
  const proposalPath = join(statePath, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
  const patchPath = join(statePath, "change.patch");
  writeFileSync(patchPath, patch);
  const keyPath = join(keysPath, "operator.pem");
  writeFileSync(keyPath, operatorPem, { mode: 0o600 });

  const trust: GitOperatorReviewTrustV1 = {
    audience: "reprogate:test-host",
    maxReviewTtlMs: 30 * MINUTE,
    operators: [
      {
        operatorId: "alice",
        enabled: true,
        keys: [
          {
            keyId: gitOperatorKeyId(operatorPair.publicKey),
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
  const approvalsPath = join(statePath, "approvals.sqlite");
  const config: GitReviewConfigV1 = {
    configVersion: 1,
    repositoryPath,
    repositoryId,
    destinationRef,
    planDatabasePath: plansPath,
    approvalDatabasePath: approvalsPath,
    catalogTool: tool,
    currentPolicy: policy,
    trust,
  };
  const configPath = join(statePath, "git-review.json");
  const writeConfig = (value: unknown, path = configPath) => {
    writeFileSync(path, JSON.stringify(value, null, 2));
  };
  writeConfig(config);
  const requestPath = join(statePath, "request.json");
  const reviewPath = join(statePath, "review.json");
  const expiry = (offsetMs = 10 * MINUTE) =>
    new Date(Date.now() + offsetMs).toISOString();

  const prepare = (o: Env & { proposal?: string; patch?: string } = {}) =>
    runCli(
      [
        "git-review",
        "prepare",
        "--config",
        configPath,
        "--proposal",
        o.proposal ?? proposalPath,
        "--patch",
        o.patch ?? patchPath,
      ],
      o,
    );
  const sign = (
    o: Env & {
      proposal?: string;
      patch?: string;
      request?: string;
      operator?: string;
      keyFile?: string;
      decision?: string;
      expiresAt?: string;
    } = {},
  ) =>
    runCli(
      [
        "git-review",
        "sign",
        "--config",
        configPath,
        "--proposal",
        o.proposal ?? proposalPath,
        "--patch",
        o.patch ?? patchPath,
        "--request",
        o.request ?? requestPath,
        "--operator",
        o.operator ?? "alice",
        "--key-file",
        o.keyFile ?? keyPath,
        "--decision",
        o.decision ?? "approve",
        "--expires-at",
        o.expiresAt ?? expiry(),
      ],
      o,
    );
  const importReview = (
    o: Env & { proposal?: string; patch?: string; review?: string } = {},
  ) =>
    runCli(
      [
        "git-review",
        "import",
        "--config",
        configPath,
        "--proposal",
        o.proposal ?? proposalPath,
        "--patch",
        o.patch ?? patchPath,
        "--review",
        o.review ?? reviewPath,
      ],
      o,
    );
  const check = (
    approvalId: string,
    o: Env & { proposal?: string; patch?: string } = {},
  ) =>
    runCli(
      [
        "git-review",
        "check",
        "--config",
        configPath,
        "--proposal",
        o.proposal ?? proposalPath,
        "--patch",
        o.patch ?? patchPath,
        "--approval-id",
        approvalId,
      ],
      o,
    );
  const revoke = (approvalId: string, o: Env = {}) =>
    runCli(
      [
        "git-review",
        "revoke",
        "--config",
        configPath,
        "--approval-id",
        approvalId,
      ],
      o,
    );
  /** prepare -> request file -> sign -> review file, asserting success. */
  const signedReview = (
    decision: "approve" | "deny" = "approve",
    proposalFile = proposalPath,
  ) => {
    const prepared = prepare({ proposal: proposalFile });
    assert.equal(prepared.status, 0, prepared.err);
    writeFileSync(requestPath, prepared.stdout);
    const signed = sign({ proposal: proposalFile, decision });
    assert.equal(signed.status, 0, signed.err);
    writeFileSync(reviewPath, signed.stdout);
    return { prepared, signed };
  };
  const approve = (): string => {
    signedReview("approve");
    const imported = importReview();
    assert.equal(imported.status, 0, imported.err);
    const result = assertAsciiJsonLine(imported) as {
      decision: string;
      approval: { approvalId: string };
    };
    assert.equal(result.decision, "approve");
    return result.approval.approvalId;
  };
  const counts = () => {
    if (!existsSync(approvalsPath)) return { approvals: 0, decisions: 0 };
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
  const stateDatabaseBytes = () =>
    readdirSync(statePath)
      .filter((name) => name.includes(".sqlite"))
      .map((name) => readFileSync(join(statePath, name)));
  const protectedState = () => ({
    head: git(repositoryPath, "rev-parse", "HEAD"),
    ref: git(repositoryPath, "rev-parse", destinationRef),
    status: git(
      repositoryPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored",
    ),
    index: sha256(readFileSync(join(repositoryPath, ".git", "index"))),
    files: Object.keys(files).map((path) =>
      existsSync(join(repositoryPath, path))
        ? sha256(readFileSync(join(repositoryPath, path)))
        : null,
    ),
  });
  const initialState = protectedState();
  return {
    scratch,
    repositoryPath,
    statePath,
    keysPath,
    patch,
    plansPath,
    approvalsPath,
    proposal,
    proposalPath,
    patchPath,
    keyPath,
    newProposal,
    trust,
    config,
    configPath,
    writeConfig,
    requestPath,
    reviewPath,
    expiry,
    prepare,
    sign,
    importReview,
    check,
    revoke,
    signedReview,
    approve,
    counts,
    stateDatabaseBytes,
    assertProtected: () => {
      assert.deepEqual(protectedState(), initialState);
    },
  };
}

/** Test-side inverse of the documented display escape format. */
function decodeRendered(text: string): Buffer {
  const out: Buffer[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] !== "\\") {
      const codePoint = text.codePointAt(index) ?? 0;
      const character = String.fromCodePoint(codePoint);
      out.push(Buffer.from(character, "utf8"));
      index += character.length;
      continue;
    }
    const kind = text[index + 1];
    if (kind === "\\") {
      out.push(Buffer.from("\\"));
      index += 2;
    } else if (kind === "t" || kind === "r" || kind === "n") {
      out.push(Buffer.from(kind === "t" ? "\t" : kind === "r" ? "\r" : "\n"));
      index += 2;
    } else if (kind === "x") {
      out.push(Buffer.from([parseInt(text.slice(index + 2, index + 4), 16)]));
      index += 4;
    } else if (kind === "u" && text[index + 2] === "{") {
      const end = text.indexOf("}", index);
      const codePoint = parseInt(text.slice(index + 3, end), 16);
      out.push(Buffer.from(String.fromCodePoint(codePoint), "utf8"));
      index = end + 1;
    } else {
      throw new Error(`Undocumented escape at ${String(index)}`);
    }
  }
  return Buffer.concat(out);
}

// Code points that must never reach a terminal unescaped (newline allowed).
const UNSAFE_DISPLAY_RANGES: [number, number][] = [
  [0x00, 0x09],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe0fff],
];

function assertDisplaySafe(text: string): void {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    assert.equal(
      UNSAFE_DISPLAY_RANGES.some(
        ([low, high]) => codePoint >= low && codePoint <= high,
      ),
      false,
      `unescaped U+${codePoint.toString(16)}`,
    );
  }
}

function extractDiff(stderr: string): string {
  const lines = stderr.split("\n");
  const begin = lines.findIndex((line) =>
    line.startsWith("---- BEGIN UNTRUSTED DIFF"),
  );
  const end = lines.indexOf("---- END UNTRUSTED DIFF ----");
  assert.ok(begin >= 0 && end > begin, "diff must be clearly delimited");
  const body = lines.slice(begin + 1, end);
  for (const line of body) assert.ok(line.startsWith("| "), line);
  return body.map((line) => `${line.slice(2)}\n`).join("");
}

test("git-review prepare, sign, import, check and revoke round trip over real subprocesses", (context) => {
  const f = fixture(context);
  const prepared = f.prepare();
  assert.equal(prepared.status, 0, prepared.err);
  const request = assertAsciiJsonLine(prepared) as GitOperatorReviewRequestV1;
  assert.deepEqual(Object.keys(request).sort(), [
    "authority",
    "authorityDigest",
    "effectDigest",
    "proposal",
    "requestVersion",
    "staged",
  ]);
  assert.equal(request.proposal.proposalId, f.proposal.proposalId);
  assert.equal(prepared.out.includes(PATCH_MARKER), false);
  // Deterministic: a second prepare yields byte-identical metadata.
  assert.equal(f.prepare().out, prepared.out);
  writeFileSync(f.requestPath, prepared.stdout);

  const signed = f.sign();
  assert.equal(signed.status, 0, signed.err);
  const review = assertAsciiJsonLine(signed) as {
    payload: Record<string, unknown>;
    signature: Record<string, unknown>;
  };
  assert.equal(review.payload.decision, "approve");
  assert.equal(review.payload.operatorId, "alice");
  assert.equal(review.payload.proposalId, f.proposal.proposalId);
  assert.equal(review.payload.effectDigest, request.effectDigest);
  assert.equal(review.payload.authorityDigest, request.authorityDigest);
  assert.equal(signed.out.includes(PATCH_MARKER), false);
  // Full diff and metadata are on stderr, delimited as untrusted.
  assert.match(signed.err, /BEGIN UNTRUSTED DIFF/u);
  assert.match(signed.err, /does not prove a human/u);
  assert.ok(signed.err.includes(PATCH_MARKER));
  for (const value of [
    request.staged.baseCommit,
    request.staged.candidateTreeOid,
    request.staged.stagedPatchDigest,
    request.authorityDigest,
    request.effectDigest,
    "refs/heads/main",
    "example/repository",
    "src/value.txt",
    String(review.payload.expiresAt),
  ]) {
    assert.ok(signed.err.includes(value), value);
  }
  assert.equal(
    sha256(decodeRendered(extractDiff(signed.err))),
    request.staged.stagedPatchDigest,
  );
  writeFileSync(f.reviewPath, signed.stdout);

  const imported = f.importReview();
  assert.equal(imported.status, 0, imported.err);
  const decision = assertAsciiJsonLine(imported) as {
    decision: string;
    proposalId: string;
    reviewDigest: string;
    approval: { approvalId: string; expiresAt: string };
  };
  assert.equal(decision.decision, "approve");
  assert.equal(decision.proposalId, f.proposal.proposalId);
  assert.equal(decision.approval.expiresAt, review.payload.expiresAt);
  const approvalId = decision.approval.approvalId;

  const valid = f.check(approvalId);
  assert.equal(valid.status, 0, valid.err);
  assert.deepEqual(assertAsciiJsonLine(valid), { valid: true });

  const revoked = f.revoke(approvalId);
  assert.equal(revoked.status, 0, revoked.err);
  assert.deepEqual(assertAsciiJsonLine(revoked), { revoked: true });

  const after = f.check(approvalId);
  assert.equal(after.status, 1);
  assert.deepEqual(assertAsciiJsonLine(after), { valid: false });
  const again = f.revoke(approvalId);
  assert.equal(again.status, 1);
  assert.deepEqual(assertAsciiJsonLine(again), { revoked: false });
  // Replay after revocation is still refused (first decision is permanent).
  assertFailed(f.importReview(), /already recorded/u);
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 1 });

  const outputs = [prepared, signed, imported, valid, revoked, after, again];
  assertNoNeedles(
    operatorSecrets,
    ...outputs.flatMap((result) => [result.stdout, result.stderr]),
    ...f.stateDatabaseBytes(),
  );
  assertNoNeedles(
    [PATCH_MARKER],
    ...outputs
      .filter((result) => result !== signed)
      .flatMap((result) => [result.stdout, result.stderr]),
    signed.stdout,
    ...f.stateDatabaseBytes(),
  );
  f.assertProtected();
});

test("signed deny records a permanent tombstone; replays and conflicting decisions fail", (context) => {
  const f = fixture(context);
  f.signedReview("deny");
  const denyReview = readFileSync(f.reviewPath);
  const imported = f.importReview();
  assert.equal(imported.status, 0, imported.err);
  const result = assertAsciiJsonLine(imported) as Record<string, unknown>;
  assert.equal(result.decision, "deny");
  assert.equal("approval" in result, false);
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 1 });

  assertFailed(f.importReview(), /already recorded/u);
  // A later approve for the denied proposal cannot override the tombstone.
  f.signedReview("approve");
  assertFailed(f.importReview(), /already recorded/u);
  writeFileSync(f.reviewPath, denyReview);
  assertFailed(f.importReview());
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 1 });

  // An approve replay for a separate proposal is first-decision only, too.
  const second = f.newProposal();
  const secondPath = join(f.statePath, "second.json");
  writeFileSync(secondPath, JSON.stringify(second));
  f.signedReview("approve", secondPath);
  assert.equal(f.importReview({ proposal: secondPath }).status, 0);
  assertFailed(f.importReview({ proposal: secondPath }), /already recorded/u);
  // A review for one proposal cannot be imported against another.
  const third = f.newProposal();
  const thirdPath = join(f.statePath, "third.json");
  writeFileSync(thirdPath, JSON.stringify(third));
  assertFailed(f.importReview({ proposal: thirdPath }), /authentication/u);
  assert.deepEqual(f.counts(), { approvals: 1, decisions: 2 });
  f.assertProtected();
});

test("sign refuses stale or tampered prepared requests and out-of-bounds expiry before reading the key", (context) => {
  const f = fixture(context);
  const prepared = f.prepare();
  assert.equal(prepared.status, 0);
  writeFileSync(f.requestPath, prepared.stdout);
  const missingKey = join(f.keysPath, "does-not-exist.pem");

  // A request prepared for another proposal of the same plan is stale.
  const other = f.newProposal();
  const otherPath = join(f.statePath, "other.json");
  writeFileSync(otherPath, JSON.stringify(other));
  const stale = f.sign({ proposal: otherPath, keyFile: missingKey });
  assertFailed(stale, /does not match the freshly regenerated request/u);
  assert.doesNotMatch(stale.err, /BEGIN UNTRUSTED DIFF/u);

  const request = JSON.parse(prepared.out) as GitOperatorReviewRequestV1;
  const tampered = [
    { ...request, effectDigest: `sha256:${"0".repeat(64)}` },
    {
      ...request,
      staged: { ...request.staged, changedPaths: ["src/other.txt"] },
    },
    { ...request, extra: true },
    { ...request, authority: { ...request.authority, destinationRef: "x" } },
  ];
  for (const value of tampered) {
    writeFileSync(f.requestPath, JSON.stringify(value));
    assertFailed(
      f.sign({ keyFile: missingKey }),
      /does not match the freshly regenerated request/u,
    );
  }
  writeFileSync(f.requestPath, `{"x": "${INPUT_MARKER}"`);
  const malformed = f.sign({ keyFile: missingKey });
  assertFailed(malformed, /Prepared review request is not valid UTF-8 JSON/u);
  assertNoNeedles([INPUT_MARKER], malformed.stderr);

  writeFileSync(f.requestPath, prepared.stdout);
  // Formatting differences are fine: comparison is over canonical JSON.
  writeFileSync(f.requestPath, JSON.stringify(request, null, 4));
  for (const [expiresAt, pattern] of [
    [new Date(Date.now() - MINUTE).toISOString(), /expiry/u],
    [f.expiry(39 * MINUTE), /expiry/u],
    [
      new Date(Date.parse(f.proposal.expiresAt) + MINUTE).toISOString(),
      /expiry/u,
    ],
  ] as const) {
    assertFailed(f.sign({ keyFile: missingKey, expiresAt }), pattern);
  }
  assertFailed(
    f.sign({ keyFile: missingKey, operator: "mallory" }),
    /not an enabled operator authorized/u,
  );
  // Once inputs are verified, the missing key file is the failure.
  const keyed = f.sign({ keyFile: missingKey });
  assertFailed(keyed, /Signing key file/u);
  assert.match(keyed.err, /END UNTRUSTED DIFF/u);
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
  f.assertProtected();
});

test("argument parsing requires explicit decision/expiry and fails closed on unknown, duplicate or positional options", (context) => {
  const f = fixture(context);
  const base = [
    "git-review",
    "sign",
    "--config",
    f.configPath,
    "--proposal",
    f.proposalPath,
    "--patch",
    f.patchPath,
    "--request",
    f.requestPath,
    "--operator",
    "alice",
    "--key-file",
    f.keyPath,
  ];
  const expiry = f.expiry();
  assertUsage(runCli([...base, "--expires-at", expiry]), /--decision/u);
  assertUsage(runCli([...base, "--decision", "approve"]), /--expires-at/u);
  for (const decision of ["maybe", "APPROVE", "approve "]) {
    assertUsage(
      runCli([...base, "--decision", decision, "--expires-at", expiry]),
      /--decision must be approve or deny/u,
    );
  }
  for (const value of [
    "2030-01-01",
    "2030-01-01T00:00:00Z",
    "2030-02-30T00:00:00.000Z",
    "tomorrow",
  ]) {
    assertUsage(
      runCli([...base, "--decision", "approve", "--expires-at", value]),
      /--expires-at/u,
    );
  }
  const full = [...base, "--decision", "approve", "--expires-at", expiry];
  assertUsage(runCli([...full, "--force", "yes"]), /Unknown option/u);
  assertUsage(runCli([...full, "--decision", "deny"]), /Duplicate option/u);
  assertUsage(runCli([...full, "positional"]), /Unexpected argument/u);
  assertUsage(runCli([...base, "--decision"]), /requires a value/u);
  assertUsage(
    runCli([...base, "--decision", "--expires-at", expiry]),
    /requires a value/u,
  );
  assertUsage(runCli([...full.slice(0, -2), `--expires-at=${expiry}`]));
  assertUsage(
    runCli([
      ...full.slice(0, 2),
      "--operator",
      "bad\u001bid",
      ...full.slice(2),
    ]),
  );
  const escaped = runCli([...full, "--evil\u001b[2J\u202E", "x"]);
  assertUsage(escaped, /Unknown option/u);
  assert.equal(escaped.stderr.includes(0x1b), false);
  assert.equal(escaped.err.includes("\u202E"), false);

  for (const args of [
    ["git-review"],
    ["git-review", "promote"],
    ["git-review", "prepare"],
    ["git-review", "prepare", "--config", f.configPath],
    ["git-review", "revoke", "--config", f.configPath],
    ["git-review", "revoke", "--config", f.configPath, "--approval-id", "x"],
    [
      "git-review",
      "revoke",
      "--config",
      f.configPath,
      "--approval-id",
      "00000000-0000-4000-8000-000000000000",
      "--patch",
      f.patchPath,
    ],
    [
      "git-review",
      "check",
      "--config",
      f.configPath,
      "--proposal",
      f.proposalPath,
      "--patch",
      f.patchPath,
    ],
  ]) {
    assertUsage(runCli(args));
  }
  const help = runCli(["git-review", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.out, /git-review sign --config/u);
  assert.match(help.out, /--decision <approve\|deny>/u);
  assert.equal(existsSync(f.approvalsPath), false);
  f.assertProtected();
});

test("legacy Phase 2 CLI commands and usage remain available", () => {
  const unknown = runCli(["nonsense"]);
  assert.equal(unknown.status, 2);
  for (const command of [
    "serve",
    "demo",
    "approve",
    "verify-receipt",
    "git-review",
  ]) {
    assert.ok(unknown.err.includes(command), command);
  }
  const demo = runCli(["demo"]);
  assert.equal(demo.status, 0, demo.err);
  assert.match(demo.out, /Phase 1 plans and binds actions/u);
  const approve = runCli(["approve"]);
  assert.equal(approve.status, 1);
  assert.match(approve.err, /Usage: reprogate approve/u);
});

test("policy, catalog, trust, patch, workspace and ref drift fail closed", (context) => {
  const f = fixture(context);
  f.signedReview("approve");
  const changed: Record<string, unknown>[] = [
    {
      ...f.config,
      currentPolicy: {
        ...policy,
        rules: [
          {
            id: "same-decision",
            priority: 1,
            match: { toolRef: tool.toolRef },
            decision: "approval_required",
            reason: "Changes the policy digest only",
          },
        ],
      },
    },
    {
      ...f.config,
      catalogTool: { ...tool, scopes: [...(tool.scopes ?? []), "extra:scope"] },
    },
    {
      ...f.config,
      trust: {
        ...f.trust,
        operators: f.trust.operators.map((operator) => ({
          ...operator,
          enabled: false,
        })),
      },
    },
  ];
  for (const value of changed) {
    f.writeConfig(value);
    assertFailed(f.importReview());
    assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
  }
  f.writeConfig(f.config);
  const otherPatch = join(f.statePath, "other.patch");
  writeFileSync(otherPatch, Buffer.concat([f.patch, Buffer.from("\n")]));
  assertFailed(f.importReview({ patch: otherPatch }));
  assertFailed(f.prepare({ patch: otherPatch }));

  const imported = f.importReview();
  assert.equal(imported.status, 0, imported.err);
  const { approval } = JSON.parse(imported.out) as {
    approval: { approvalId: string };
  };
  const checkFalse = (args: { patch?: string } = {}) => {
    const result = f.check(approval.approvalId, args);
    assert.equal(result.status, 1, result.err);
    assert.deepEqual(assertAsciiJsonLine(result), { valid: false });
  };
  const checkTrue = () => {
    const result = f.check(approval.approvalId);
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(assertAsciiJsonLine(result), { valid: true });
  };
  checkFalse({ patch: otherPatch });
  for (const value of changed) {
    f.writeConfig(value);
    checkFalse();
  }
  f.writeConfig(f.config);
  checkTrue();

  const untracked = join(f.repositoryPath, "untracked.txt");
  writeFileSync(untracked, "dirty\n");
  checkFalse();
  assertFailed(f.prepare());
  rmSync(untracked);
  checkTrue();
  f.assertProtected();

  writeFileSync(join(f.repositoryPath, "src", "value.txt"), "moved\n");
  git(f.repositoryPath, "commit", "-q", "-am", "move ref");
  checkFalse();
  assertFailed(f.prepare());
  // Revocation only touches ledger state and works on moved refs.
  const revoked = f.revoke(approval.approvalId);
  assert.equal(revoked.status, 0, revoked.err);
  assert.deepEqual(assertAsciiJsonLine(revoked), { revoked: true });
});

test(
  "host config changes during staging are detected at post-stage boundaries",
  { skip: !POSIX },
  (context) => {
    const f = fixture(context);
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const wrapperDirectory = join(f.scratch, "bin");
    mkdirSync(wrapperDirectory);
    const wrapper = join(wrapperDirectory, "git");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'if [ -n "$REPROGATE_TEST_GIT_LOG" ]; then echo "$*" >> "$REPROGATE_TEST_GIT_LOG"; fi',
        'case " $* " in *" apply --cached "*)',
        '  if [ -n "$REPROGATE_TEST_MUTATE_FROM" ]; then cp "$REPROGATE_TEST_MUTATE_FROM" "$REPROGATE_TEST_MUTATE_TO"; fi;;',
        "esac",
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const mutatedPath = join(f.statePath, "mutated.json");
    // Description is not part of plan authority: only the drift check sees it.
    f.writeConfig(
      {
        ...f.config,
        catalogTool: { ...tool, description: "Changed during staging" },
      },
      mutatedPath,
    );
    const baseEnv = {
      ...process.env,
      PATH: `${wrapperDirectory}${delimiter}${process.env.PATH ?? ""}`,
    };
    const mutateEnv = {
      ...baseEnv,
      REPROGATE_TEST_MUTATE_FROM: mutatedPath,
      REPROGATE_TEST_MUTATE_TO: f.configPath,
    };
    const restore = () => {
      f.writeConfig(f.config);
    };

    assertFailed(f.prepare({ env: mutateEnv }), /config changed/u);
    restore();
    const prepareLog = join(f.scratch, "prepare.log");
    const prepared = f.prepare({
      env: { ...baseEnv, REPROGATE_TEST_GIT_LOG: prepareLog },
    });
    assert.equal(prepared.status, 0, prepared.err);
    writeFileSync(f.requestPath, prepared.stdout);

    assertFailed(f.sign({ env: mutateEnv }), /config changed/u);
    restore();
    // Every Git subprocess sign runs is the same as prepare: none after key load.
    const signLog = join(f.scratch, "sign.log");
    const signed = f.sign({
      env: { ...baseEnv, REPROGATE_TEST_GIT_LOG: signLog },
    });
    assert.equal(signed.status, 0, signed.err);
    assert.equal(
      readFileSync(signLog, "utf8").split("\n").length,
      readFileSync(prepareLog, "utf8").split("\n").length,
    );
    writeFileSync(f.reviewPath, signed.stdout);

    assertFailed(f.importReview({ env: mutateEnv }), /config changed/u);
    restore();
    assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
    const imported = f.importReview();
    assert.equal(imported.status, 0, imported.err);
    const { approval } = JSON.parse(imported.out) as {
      approval: { approvalId: string };
    };
    const drifted = f.check(approval.approvalId, { env: mutateEnv });
    assert.equal(drifted.status, 1);
    assert.deepEqual(assertAsciiJsonLine(drifted), { valid: false });
    restore();
    assert.equal(f.check(approval.approvalId).status, 0);
    f.assertProtected();
  },
);

test("unsafe database and state paths are rejected; revoke works on a dirty repository", (context) => {
  const f = fixture(context);
  const attempt = (value: Record<string, unknown>, pattern: RegExp) => {
    f.writeConfig(value);
    assertFailed(f.prepare(), pattern);
    assert.throws(() => loadGitReviewConfig(f.configPath), pattern);
  };
  const inside = join(f.repositoryPath, "approvals.sqlite");
  attempt(
    { ...f.config, approvalDatabasePath: inside },
    /outside the protected repository/u,
  );
  attempt(
    {
      ...f.config,
      approvalDatabasePath: join(f.repositoryPath, ".git", "a.sqlite"),
    },
    /outside the protected repository/u,
  );
  attempt(
    { ...f.config, approvalDatabasePath: "approvals.sqlite" },
    /absolute/u,
  );
  attempt({ ...f.config, repositoryPath: "repository" }, /absolute/u);
  attempt(
    { ...f.config, planDatabasePath: f.approvalsPath },
    /must already exist/u,
  );
  attempt(
    { ...f.config, approvalDatabasePath: f.plansPath },
    /must be different files/u,
  );
  attempt(
    { ...f.config, planDatabasePath: join(f.statePath, "missing", "p.sqlite") },
    /parent directory must exist/u,
  );
  attempt({ ...f.config, repositoryPath: f.statePath }, /Git worktree root/u);

  const alias = join(f.statePath, "alias.sqlite");
  linkSync(f.plansPath, alias);
  attempt({ ...f.config }, /hard-linked/u);
  rmSync(alias);

  if (POSIX) {
    const repoLink = join(f.statePath, "repo-link");
    symlinkSync(f.repositoryPath, repoLink);
    attempt(
      { ...f.config, approvalDatabasePath: join(repoLink, "a.sqlite") },
      /outside the protected repository/u,
    );
    const target = join(f.statePath, "target.sqlite");
    writeFileSync(target, "");
    const fileLink = join(f.statePath, "link.sqlite");
    symlinkSync(target, fileLink);
    attempt({ ...f.config, approvalDatabasePath: fileLink }, /regular file/u);
    const wal = `${f.approvalsPath}-wal`;
    symlinkSync(join(f.repositoryPath, "src", "value.txt"), wal);
    attempt({ ...f.config }, /sidecar must be a regular file/u);
    rmSync(wal);
  }
  assert.equal(existsSync(inside), false);
  f.writeConfig(f.config);
  f.assertProtected();

  const approvalId = f.approve();
  // Revoke requires an existing ledger but never stages, so a dirty or
  // moved-ref repository does not block ledger-only revocation.
  writeFileSync(join(f.repositoryPath, "untracked.txt"), "dirty\n");
  const missingLedger = {
    ...f.config,
    approvalDatabasePath: join(f.statePath, "none.sqlite"),
  };
  f.writeConfig(missingLedger);
  assertFailed(f.revoke(approvalId), /must already exist/u);
  assertFailed(f.check(approvalId), /must already exist/u);
  f.writeConfig({
    ...f.config,
    planDatabasePath: join(f.statePath, "gone.sqlite"),
  });
  const revoked = f.revoke(approvalId);
  assert.equal(revoked.status, 0, revoked.err);
  assert.deepEqual(assertAsciiJsonLine(revoked), { revoked: true });
});

test("bounded malformed config and inputs fail without echoing their contents", (context) => {
  const f = fixture(context);
  const config = f.configPath;
  const check = (pattern: RegExp, result = f.prepare()) => {
    assertFailed(result, pattern);
    assertNoNeedles([INPUT_MARKER], result.stderr);
  };
  writeFileSync(config, `{"configVersion": 1, "x": "${INPUT_MARKER}`);
  check(/config is not valid UTF-8 JSON/u);
  writeFileSync(
    config,
    Buffer.concat([
      Buffer.from('{"a":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
  );
  check(/config is not valid UTF-8 JSON/u);
  writeFileSync(config, JSON.stringify({ ...f.config, [INPUT_MARKER]: 1 }));
  check(/config failed strict validation/u);
  writeFileSync(
    config,
    `${JSON.stringify(f.config)}${" ".repeat(1024 * 1024)}`,
  );
  check(/exceeds the 1048576 byte limit/u);
  f.writeConfig({
    ...f.config,
    trust: {
      ...f.trust,
      operators: [
        {
          ...f.trust.operators[0],
          keys: [
            { ...f.trust.operators[0]?.keys[0], publicKeyPem: operatorPem },
          ],
        },
      ],
    },
  });
  check(/host trust/u);
  assertNoNeedles(operatorSecrets, f.prepare().stderr);
  f.writeConfig({
    ...f.config,
    catalogTool: { ...tool, inputSchema: undefined },
  });
  check(/inputSchema/u);
  f.writeConfig({
    ...f.config,
    catalogTool: { ...tool, effects: ["local_read"] },
  });
  check(/local_write/u);
  rmSync(config);
  mkdirSync(config);
  check(/regular file/u);
  rmSync(config, { recursive: true });
  if (POSIX) {
    execFileSync("mkfifo", [config]);
    check(/regular file/u);
    rmSync(config);
  }
  f.writeConfig(f.config);
  const relative = runCli(
    [
      "git-review",
      "prepare",
      "--config",
      "state/git-review.json",
      "--proposal",
      f.proposalPath,
      "--patch",
      f.patchPath,
    ],
    { cwd: f.scratch },
  );
  assertFailed(relative, /absolute/u);
  // Other input paths explicitly resolve against the working directory.
  const relativeInputs = runCli(
    [
      "git-review",
      "prepare",
      "--config",
      config,
      "--proposal",
      "state/proposal.json",
      "--patch",
      "state/change.patch",
    ],
    { cwd: f.scratch },
  );
  assert.equal(relativeInputs.status, 0, relativeInputs.err);

  const proposalPath = join(f.statePath, "bad-proposal.json");
  writeFileSync(proposalPath, `{"proposalVersion":1,"x":"${INPUT_MARKER}"`);
  check(
    /proposal is not valid UTF-8 JSON/u,
    f.prepare({ proposal: proposalPath }),
  );
  writeFileSync(
    proposalPath,
    JSON.stringify({ ...f.proposal, allowedPaths: ["src/other.txt"] }),
  );
  check(
    /proposal is malformed or failed its integrity check/u,
    f.prepare({ proposal: proposalPath }),
  );
  writeFileSync(
    proposalPath,
    JSON.stringify({ ...f.proposal, [INPUT_MARKER]: true }),
  );
  check(/proposal is malformed/u, f.prepare({ proposal: proposalPath }));
  writeFileSync(proposalPath, " ".repeat(4 * 1024 * 1024 + 1));
  check(/exceeds/u, f.prepare({ proposal: proposalPath }));

  const patchPath = join(f.statePath, "big.patch");
  writeFileSync(patchPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  check(
    /Patch exceeds the 4194304 byte limit/u,
    f.prepare({ patch: patchPath }),
  );

  f.signedReview("approve");
  const review = JSON.parse(readFileSync(f.reviewPath, "utf8")) as {
    payload: Record<string, unknown>;
    signature: { value: string };
  };
  const reviewPath = join(f.statePath, "bad-review.json");
  writeFileSync(reviewPath, `{"payload": "${INPUT_MARKER}`);
  check(
    /review is not valid UTF-8 JSON/u,
    f.importReview({ review: reviewPath }),
  );
  writeFileSync(reviewPath, " ".repeat(64 * 1024 + 1));
  check(/exceeds/u, f.importReview({ review: reviewPath }));
  const flipped = review.signature.value.startsWith("A") ? "B" : "A";
  writeFileSync(
    reviewPath,
    JSON.stringify({
      ...review,
      signature: {
        ...review.signature,
        value: flipped + review.signature.value.slice(1),
      },
    }),
  );
  check(/authentication/u, f.importReview({ review: reviewPath }));
  writeFileSync(
    reviewPath,
    JSON.stringify({
      ...review,
      payload: { ...review.payload, decision: "deny" },
    }),
  );
  check(/authentication/u, f.importReview({ review: reviewPath }));
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
  f.assertProtected();
});

test("private signing keys must be safe Ed25519 authorized files and are never disclosed", (context) => {
  const f = fixture(context);
  const prepared = f.prepare();
  writeFileSync(f.requestPath, prepared.stdout);
  const keyFile = (name: string, contents: string | Buffer, mode = 0o600) => {
    const path = join(f.keysPath, name);
    writeFileSync(path, contents, { mode });
    return path;
  };
  const allOutputs: Buffer[] = [];
  const refused = (
    path: string,
    pattern: RegExp,
    needles: (string | Buffer)[] = [],
  ) => {
    const result = f.sign({ keyFile: path });
    assertFailed(result, pattern);
    // The key is read only after staging and diff rendering complete.
    assert.match(result.err, /END UNTRUSTED DIFF/u);
    assertNoNeedles(
      [...operatorSecrets, ...needles, INPUT_MARKER],
      result.stdout,
      result.stderr,
    );
    allOutputs.push(result.stdout, result.stderr);
  };
  const markerPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(INPUT_MARKER).toString("base64")}\n-----END PRIVATE KEY-----\n`;
  refused(
    keyFile("garbage.pem", markerPem),
    /Signing key could not be loaded/u,
    [Buffer.from(INPUT_MARKER).toString("base64")],
  );
  refused(
    keyFile("raw.pem", `${INPUT_MARKER}\n`),
    /Signing key could not be loaded/u,
  );
  refused(
    keyFile(
      "public.pem",
      operatorPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ),
    /Signing key could not be loaded/u,
  );
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecPem = ec.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  refused(keyFile("ec.pem", ecPem), /Signing key could not be loaded/u, [
    pemBody(ecPem),
  ]);
  const encrypted = operatorPair.privateKey
    .export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-passphrase",
    })
    .toString();
  refused(
    keyFile("encrypted.pem", encrypted),
    /Signing key could not be loaded/u,
    [pemBody(encrypted)],
  );
  const otherPem = otherPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const otherSecrets = secretNeedles(
    otherPem,
    (otherPair.privateKey.export({ format: "jwk" }) as { d: string }).d,
  );
  refused(
    keyFile("other.pem", otherPem),
    /not an enabled key for this operator/u,
    otherSecrets,
  );
  refused(
    keyFile("big.pem", `${operatorPem}${" ".repeat(16 * 1024)}`),
    /Signing key/u,
  );
  mkdirSync(join(f.keysPath, "directory.pem"));
  refused(join(f.keysPath, "directory.pem"), /Signing key file/u);

  const hard = keyFile("hard.pem", operatorPem);
  linkSync(hard, join(f.keysPath, "hard-alias.pem"));
  refused(hard, /Signing key file must be a regular, non-linked file/u);
  const inRepository = join(f.repositoryPath, ".git", "operator.pem");
  writeFileSync(inRepository, operatorPem, { mode: 0o600 });
  refused(inRepository, /outside the protected repository/u);
  rmSync(inRepository);
  if (POSIX) {
    const link = join(f.keysPath, "link.pem");
    symlinkSync(f.keyPath, link);
    refused(link, /Signing key file must be a regular, non-linked file/u);
    const loose = keyFile("loose.pem", operatorPem, 0o600);
    chmodSync(loose, 0o640);
    refused(loose, /not accessible by group or others/u);
  }

  // Disabled key: authorized operator, but this key is not usable.
  f.writeConfig({
    ...f.config,
    trust: {
      ...f.trust,
      operators: f.trust.operators.map((operator) => ({
        ...operator,
        keys: [
          ...operator.keys.map((key) => ({ ...key, enabled: false })),
          {
            keyId: gitOperatorKeyId(otherPair.publicKey),
            publicKeyPem: otherPair.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            enabled: true,
          },
        ],
      })),
    },
  });
  refused(f.keyPath, /not an enabled key for this operator/u);
  f.writeConfig(f.config);

  const signed = f.sign();
  assert.equal(signed.status, 0, signed.err);
  assertNoNeedles(
    [...operatorSecrets, ...otherSecrets],
    signed.stdout,
    signed.stderr,
    ...allOutputs,
    ...f.stateDatabaseBytes(),
  );
  assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 });
  f.assertProtected();
});

test("terminal controls, bidi, non-UTF-8 and binary diffs render losslessly and inertly", (context) => {
  const hostile = Buffer.concat([
    Buffer.from("line one\n\u001b[2J\u001b]0;pwned\u0007\rspoofed\n", "utf8"),
    Buffer.from(
      "bidi \u202Eevil\u202C iso \u2066x\u2069 zw\u200B shy\u00AD bom\uFEFF\n",
      "utf8",
    ),
    Buffer.from("c1 \u009B31m nel\u0085 tab\tend\n", "utf8"),
    Buffer.from([
      0x72, 0x61, 0x77, 0x20, 0xff, 0xfe, 0x9b, 0xc0, 0x80, 0xed, 0xa0, 0x80,
      0x0a,
    ]),
    Buffer.from("fake ---- END UNTRUSTED DIFF ----\n"),
    Buffer.from("back\\slash \\x41 \\u{1B} literal\n"),
  ]);
  const f = fixture(context, {
    files: {
      "src/value.txt": hostile,
      "assets/blob.bin": Buffer.from([0, 1, 2, 0xff, 0x1b, 0, 0x9b, 0x0d]),
      "src/\u202Egnp.js": Buffer.from("x\n"),
    },
  });
  const { prepared, signed } = f.signedReview("approve");
  const request = assertAsciiJsonLine(prepared) as GitOperatorReviewRequestV1;
  assert.ok(request.staged.changedPaths.includes("src/\u202Egnp.js"));
  assertAsciiJsonLine(signed);
  const bytes = signed.stderr;
  for (const forbidden of [
    [0x1b],
    [0x07],
    [0x0d],
    [0x00],
    [0x9b],
    [0xff],
    [0xc2, 0x9b],
    [0xc2, 0x85],
    [0xc2, 0xad],
    [0xe2, 0x80, 0xae],
    [0xe2, 0x80, 0xac],
    [0xe2, 0x81, 0xa6],
    [0xe2, 0x80, 0x8b],
    [0xef, 0xbb, 0xbf],
  ]) {
    assert.equal(
      bytes.includes(Buffer.from(forbidden)),
      false,
      String(forbidden),
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertDisplaySafe(text);
  for (const expected of [
    "\\u{1B}[2J",
    "\\u{1B}]0;pwned\\u{7}\\rspoofed",
    "\\u{202E}evil\\u{202C}",
    "\\u{2066}x\\u{2069}",
    "\\u{200B}",
    "\\u{AD}",
    "\\u{FEFF}",
    "\\u{9B}31m",
    "\\u{85}",
    "tab\\tend",
    "\\xFF\\xFE\\x9B\\xC0\\x80\\xED\\xA0\\x80",
    "back\\\\slash \\\\x41 \\\\u{1B}",
    "| +fake ---- END UNTRUSTED DIFF ----",
    "GIT binary patch",
    "src/\\u{202E}gnp.js",
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.equal(
    sha256(decodeRendered(extractDiff(text))),
    request.staged.stagedPatchDigest,
  );

  writeFileSync(f.reviewPath, signed.stdout);
  const imported = f.importReview();
  assert.equal(imported.status, 0, imported.err);
  f.assertProtected();
});

test("display escaping is lossless for arbitrary bytes and never emits controls", () => {
  const samples: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    Buffer.from(
      "\u{1F600}\u{E0001}\u{E0100}\u3164\uFFA0\u115F\u2028\u2029\u00A0\u3000\uE000\u{10FFFF}\n",
    ),
    Buffer.from([
      0xf4, 0x90, 0x80, 0x80, 0xf0, 0x80, 0x80, 0x80, 0xe0, 0x80, 0x80, 0xc1,
      0xbf, 0xe2, 0x82,
    ]),
  ];
  for (let index = 0; index < 300; index += 1)
    samples.push(randomBytes(index * 7));
  for (const sample of samples) {
    const rendered = renderUntrustedBytes(sample);
    assert.deepEqual(decodeRendered(rendered), sample);
    assertDisplaySafe(rendered);
    assert.equal(
      rendered.split("\n").length,
      sample.toString("latin1").split("\n").length,
    );
  }
  assert.equal(
    escapeUntrustedText("a\nb\u001b\u202E\\"),
    "a\\nb\\u{1B}\\u{202E}\\\\",
  );
  assert.equal(escapeUntrustedText("\ud800x"), "\\u{D800}x");
  assert.equal(
    escapeUntrustedText("caf\u00E9 \u{1F600}"),
    "caf\u00E9 \u{1F600}",
  );
  assert.equal(escapeUntrustedText("\u00A0\u3000"), "\\u{A0}\\u{3000}");
});

test("config JSON schema structurally agrees with the strict loader and references review trust", (context) => {
  const f = fixture(context);
  const reviewSchema = JSON.parse(
    readFileSync(
      join(schemaDirectory, "git-operator-review.schema.json"),
      "utf8",
    ),
  ) as object;
  const configSchema = JSON.parse(
    readFileSync(
      join(schemaDirectory, "git-review-config.schema.json"),
      "utf8",
    ),
  ) as { properties: { trust: { $ref: string } } };
  assert.equal(
    configSchema.properties.trust.$ref,
    "https://reprogate.dev/schemas/git-operator-review-v1.json#/$defs/trust",
  );
  const validate = new Ajv2020({ strict: true })
    .addSchema(reviewSchema)
    .addSchema(configSchema)
    .getSchema("https://reprogate.dev/schemas/git-review-config-v1.json");
  assert.ok(validate);
  const config = JSON.parse(JSON.stringify(f.config)) as Record<
    string,
    unknown
  >;
  const operator = f.trust.operators[0];
  assert.ok(operator);
  const without = (key: string) =>
    Object.fromEntries(Object.entries(config).filter(([name]) => name !== key));
  const cases: unknown[] = [
    config,
    {
      ...config,
      catalogTool: { ...tool, artifactDigest: `sha256:${"a".repeat(64)}` },
    },
    { ...config, extra: true },
    ...Object.keys(config).map(without),
    { ...config, configVersion: 2 },
    { ...config, repositoryId: "repo/*" },
    { ...config, destinationRef: "main" },
    { ...config, destinationRef: "refs/heads/*" },
    { ...config, planDatabasePath: "" },
    { ...config, catalogTool: { ...tool, extra: 1 } },
    { ...config, catalogTool: { ...tool, artifactDigest: "sha256:ABC" } },
    { ...config, catalogTool: { ...tool, effects: [] } },
    { ...config, catalogTool: { ...tool, effects: ["local_read"] } },
    { ...config, catalogTool: { ...tool, scopes: ["other"] } },
    {
      ...config,
      catalogTool: Object.fromEntries(
        Object.entries(tool).filter(([key]) => key !== "scopes"),
      ),
    },
    {
      ...config,
      catalogTool: Object.fromEntries(
        Object.entries(tool).filter(([key]) => key !== "inputSchema"),
      ),
    },
    {
      ...config,
      currentPolicy: {
        ...policy,
        defaults: { ...policy.defaults, destructive: undefined },
      },
    },
    {
      ...config,
      currentPolicy: {
        ...policy,
        rules: [
          {
            id: "r",
            priority: 1,
            match: {},
            decision: "allow",
            reason: "r",
            extra: 1,
          },
        ],
      },
    },
    {
      ...config,
      currentPolicy: {
        ...policy,
        rules: [
          { id: "r", priority: 1.5, match: {}, decision: "allow", reason: "r" },
        ],
      },
    },
    { ...config, trust: { ...f.trust, extra: true } },
    {
      ...config,
      trust: {
        ...f.trust,
        operators: [
          {
            ...operator,
            permissions: [
              { ...operator.permissions[0], destinationRef: "refs/heads/*" },
            ],
          },
        ],
      },
    },
    null,
    [],
  ];
  for (const value of cases) {
    let parses = true;
    try {
      parseGitReviewConfig(JSON.parse(JSON.stringify(value)) as unknown);
    } catch {
      parses = false;
    }
    assert.equal(
      validate(JSON.parse(JSON.stringify(value))),
      parses,
      JSON.stringify(value),
    );
  }
  // Semantic key identity remains a library check beyond the structural schema.
  const mismatched = {
    ...config,
    trust: {
      ...f.trust,
      operators: [
        {
          ...operator,
          keys: [
            {
              ...operator.keys[0],
              keyId: gitOperatorKeyId(otherPair.publicKey),
            },
          ],
        },
      ],
    },
  };
  assert.equal(validate(mismatched), true);
  assert.throws(() => parseGitReviewConfig(mismatched), /host trust/u);

  const loaded = loadGitReviewConfig(f.configPath);
  assert.equal(
    gitReviewConfigDigest(loaded),
    gitReviewConfigDigest(parseGitReviewConfig(config)),
  );
  // Formatting does not change the canonical drift digest; content does.
  writeFileSync(f.configPath, JSON.stringify(f.config));
  assert.equal(
    gitReviewConfigDigest(loadGitReviewConfig(f.configPath)),
    gitReviewConfigDigest(loaded),
  );
  copyFileSync(f.configPath, join(f.statePath, "copy.json"));
  f.writeConfig({
    ...f.config,
    catalogTool: { ...tool, description: "changed" },
  });
  assert.notEqual(
    gitReviewConfigDigest(loadGitReviewConfig(f.configPath)),
    gitReviewConfigDigest(loaded),
  );
});

/** In-process CLI run, so a test hook can sit on the real SQLite calls. */
function runInProcess(args: string[]): CliResult {
  let out = "";
  let err = "";
  const status = runGitReviewCli(args, {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  });
  return {
    status,
    stdout: Buffer.from(out),
    stderr: Buffer.from(err),
    out,
    err,
  };
}

test("import re-observes config drift inside the insertion transaction", (context) => {
  const lateChanges: [string, (f: ReturnType<typeof fixture>) => unknown][] = [
    [
      "operator key disabled",
      (f) => ({
        ...f.config,
        trust: {
          ...f.trust,
          operators: f.trust.operators.map((operator) => ({
            ...operator,
            keys: operator.keys.map((key) => ({ ...key, enabled: false })),
          })),
        },
      }),
    ],
    [
      "operator removed",
      (f) => ({ ...f.config, trust: { ...f.trust, operators: [] } }),
    ],
    [
      "audience changed",
      (f) => ({
        ...f.config,
        trust: { ...f.trust, audience: "reprogate:other-host" },
      }),
    ],
    [
      "permission removed",
      (f) => ({
        ...f.config,
        trust: {
          ...f.trust,
          operators: f.trust.operators.map((operator) => ({
            ...operator,
            permissions: [],
          })),
        },
      }),
    ],
    [
      "non-trust catalog field changed",
      (f) => ({
        ...f.config,
        catalogTool: { ...tool, description: "Changed before insertion" },
      }),
    ],
  ];
  for (const [label, change] of lateChanges) {
    const f = fixture(context);
    // The signed review is generated before the hook exists.
    f.signedReview("approve");
    const mutated = change(f);
    let armed = true;
    const exec: (this: DatabaseSync, sql: string) => void = Reflect.get(
      DatabaseSync.prototype,
      "exec",
    );
    context.mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, sql: string) {
        if (armed && sql === "BEGIN IMMEDIATE") {
          armed = false;
          f.writeConfig(mutated);
        }
        exec.call(this, sql);
      },
    );
    const result = runInProcess([
      "import",
      "--config",
      f.configPath,
      "--proposal",
      f.proposalPath,
      "--patch",
      f.patchPath,
      "--review",
      f.reviewPath,
    ]);
    context.mock.restoreAll();
    assert.equal(armed, false, `${label}: transaction hook did not run`);
    assert.equal(result.status, 1, `${label}: ${result.err}`);
    assert.equal(result.out, "", label);
    assert.match(result.err, /no longer valid under current trust/u, label);
    assert.deepEqual(f.counts(), { approvals: 0, decisions: 0 }, label);
    f.assertProtected();
  }
});

test("check re-observes config drift at the final authentication", (context) => {
  const f = fixture(context);
  const approvalId = f.approve();
  const database = DatabaseSync.prototype;
  const prepare = Reflect.get(database, "prepare") as (
    this: DatabaseSync,
    sql: string,
  ) => unknown;
  let selects = 0;
  context.mock.method(
    database,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      // The second reviewed-approval read follows authority rederivation.
      if (sql.includes("FROM git_operator_review_decisions")) {
        selects += 1;
        if (selects === 2) {
          f.writeConfig({
            ...f.config,
            trust: { ...f.trust, audience: "reprogate:other-host" },
          });
        }
      }
      return prepare.call(this, sql);
    },
  );
  const result = runInProcess([
    "check",
    "--config",
    f.configPath,
    "--proposal",
    f.proposalPath,
    "--patch",
    f.patchPath,
    "--approval-id",
    approvalId,
  ]);
  context.mock.restoreAll();
  assert.equal(selects >= 2, true);
  assert.equal(result.status, 1, result.err);
  assert.deepEqual(assertAsciiJsonLine(result), { valid: false });
  f.writeConfig(f.config);
  assert.equal(f.check(approvalId).status, 0);
  f.assertProtected();
});
