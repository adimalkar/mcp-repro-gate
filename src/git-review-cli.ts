import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import { SqliteExecutionStore } from "./execution-store.js";
import {
  snapshotGitChangeProposal,
  SqliteGitApprovalStore,
  type GitApprovalAuthority,
} from "./git-approval-store.js";
import type { GitChangeProposalV1 } from "./git-change-proposal.js";
import {
  authenticateGitOperatorReview,
  gitOperatorKeyId,
  signGitOperatorReview,
  type GitOperatorReviewPayloadV1,
  type GitOperatorReviewTrustV1,
} from "./git-operator-review.js";
import {
  applyGitOperatorReviewFromPlan,
  matchesOperatorReviewedGitApprovalFromPlan,
  prepareGitOperatorReviewFromPlan,
  type GitOperatorReviewRequestV1,
} from "./git-operator-review-plan.js";
import type { GitPlanBindingContext } from "./git-plan-binding.js";
import {
  assertOutsideProtectedRepository,
  loadGitReviewConfigSnapshot,
  readBoundedRegularFile,
  type GitReviewConfigOptions,
  type GitReviewConfigSnapshot,
} from "./git-review-config.js";
import type { PlanStore, PlannedAction } from "./kernel.js";

export interface GitReviewCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

// Patch matches the staging limit. A proposal holds up to 256 paths of up to
// 4096 UTF-16 units (at most 3 UTF-8 bytes each, about 3 MiB) plus fixed
// metadata. A request adds the proposal plus staged changedPaths (a subset of
// allowedPaths) and digests, so it gets twice the proposal bound.
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$(?![\s\S])/u;
const APPROVAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/u;
const TIMESTAMP_PATTERN =
  /^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$(?![\s\S])/u;

export const GIT_REVIEW_USAGE = `Usage:
  reprogate git-review prepare --config <absolute-path> --proposal <proposal.json> --patch <change.patch>
  reprogate git-review sign --config <absolute-path> --proposal <proposal.json> --patch <change.patch> --request <request.json> --operator <operator-id> --key-file <private-key.pem> --decision <approve|deny> --expires-at <canonical-UTC>
  reprogate git-review import --config <absolute-path> --proposal <proposal.json> --patch <change.patch> --review <review.json>
  reprogate git-review check --config <absolute-path> --proposal <proposal.json> --patch <change.patch> --approval-id <uuid>
  reprogate git-review revoke --config <absolute-path> --approval-id <uuid>

Every listed option is required exactly once, as "--name value". --config must
be absolute; other paths resolve against the current working directory.
--expires-at is canonical UTC such as 2030-01-01T00:00:00.000Z.
JSON results go to stdout; sign shows the escaped staged diff on stderr.
Exit status: 0 success or true, 1 failure or a false result
({"valid":false} or {"revoked":false}), 2 usage error.
`;

const COMMANDS = {
  prepare: ["config", "proposal", "patch"],
  sign: [
    "config",
    "proposal",
    "patch",
    "request",
    "operator",
    "key-file",
    "decision",
    "expires-at",
  ],
  import: ["config", "proposal", "patch", "review"],
  check: ["config", "proposal", "patch", "approval-id"],
  revoke: ["config", "approval-id"],
} as const;

type Command = keyof typeof COMMANDS;
type Options = ReadonlyMap<string, string>;

class UsageError extends Error {}

// Controls, format characters (including bidi embeddings and isolates),
// surrogates, private-use, unassigned, line/paragraph separators, default
// ignorable code points, and non-ASCII spaces are shown as escapes.
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}]/u;

function escapeCodePoint(codePoint: number, preserveNewline: boolean): string {
  switch (codePoint) {
    case 0x0a:
      return preserveNewline ? "\n" : "\\n";
    case 0x09:
      return "\\t";
    case 0x0d:
      return "\\r";
    case 0x5c:
      return "\\\\";
  }
  if (codePoint >= 0x20 && codePoint < 0x7f) {
    return String.fromCharCode(codePoint);
  }
  const character = String.fromCodePoint(codePoint);
  return INVISIBLE.test(character)
    ? `\\u{${codePoint.toString(16).toUpperCase()}}`
    : character;
}

/**
 * Escape one untrusted string for terminal display on a single line.
 * Backslash, \n, \t, \r and \u{H} escapes are unambiguous and lossless.
 */
export function escapeUntrustedText(value: string): string {
  let result = "";
  for (const character of value) {
    result += escapeCodePoint(character.codePointAt(0) ?? 0, false);
  }
  return result;
}

function decodeUtf8At(
  bytes: Uint8Array,
  index: number,
): { codePoint: number; length: number } | undefined {
  const first = bytes[index] ?? 0;
  if (first < 0x80) return { codePoint: first, length: 1 };
  let length: number;
  let codePoint: number;
  let minimum: number;
  if (first >= 0xc2 && first <= 0xdf) {
    [length, codePoint, minimum] = [2, first & 0x1f, 0x80];
  } else if (first >= 0xe0 && first <= 0xef) {
    [length, codePoint, minimum] = [3, first & 0x0f, 0x800];
  } else if (first >= 0xf0 && first <= 0xf4) {
    [length, codePoint, minimum] = [4, first & 0x07, 0x10000];
  } else {
    return undefined;
  }
  if (index + length > bytes.length) return undefined;
  for (let offset = 1; offset < length; offset += 1) {
    const next = bytes[index + offset] ?? 0;
    if ((next & 0xc0) !== 0x80) return undefined;
    codePoint = (codePoint << 6) | (next & 0x3f);
  }
  if (
    codePoint < minimum ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return undefined;
  }
  return { codePoint, length };
}

/**
 * Lossless, inert rendering of untrusted bytes. Newlines are preserved as
 * structure; valid UTF-8 is decoded strictly (never replaced), unsafe code
 * points become \u{H}, and every byte that is not part of valid UTF-8
 * becomes \xHH.
 */
export function renderUntrustedBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length;) {
    const decoded = decodeUtf8At(bytes, index);
    if (decoded === undefined) {
      const byte = bytes[index] ?? 0;
      parts.push(`\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`);
      index += 1;
    } else {
      parts.push(escapeCodePoint(decoded.codePoint, true));
      index += decoded.length;
    }
  }
  return parts.join("");
}

/** Canonical JSON with every non-printable-ASCII code unit \u-escaped. */
function asciiJson(value: unknown): string {
  const json = canonicalJson(value);
  let result = "";
  for (let index = 0; index < json.length; index += 1) {
    const unit = json.charCodeAt(index);
    result +=
      unit >= 0x20 && unit < 0x7f
        ? json.charAt(index)
        : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return `${result}\n`;
}

function parseOptions(command: Command, args: string[]): Options {
  const allowed: readonly string[] = COMMANDS[command];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    if (!flag.startsWith("--")) throw new UsageError("Unexpected argument");
    const name = flag.slice(2);
    if (!allowed.includes(name)) {
      throw new UsageError(`Unknown option ${escapeUntrustedText(flag)}`);
    }
    if (options.has(name)) throw new UsageError(`Duplicate option --${name}`);
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new UsageError(`Option --${name} requires a value`);
    }
    options.set(name, value);
  }
  for (const name of allowed) {
    if (!options.has(name)) {
      throw new UsageError(`Missing required option --${name}`);
    }
  }
  return options;
}

function option(options: Options, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new UsageError(`Missing option --${name}`);
  return value;
}

function approvalIdOption(options: Options): string {
  const value = option(options, "approval-id");
  if (!APPROVAL_ID_PATTERN.test(value)) {
    throw new UsageError("--approval-id must be a lowercase UUID");
  }
  return value;
}

function readJsonFile(path: string, maxBytes: number, label: string): unknown {
  const bytes = readBoundedRegularFile(resolve(path), maxBytes, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Parser diagnostics quote input; report only the failure class.
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

function readProposal(path: string): GitChangeProposalV1 {
  const value = readJsonFile(path, MAX_PROPOSAL_BYTES, "Git change proposal");
  try {
    return snapshotGitChangeProposal(value);
  } catch {
    throw new Error(
      "Git change proposal is malformed or failed its integrity check",
    );
  }
}

function readPatch(path: string): Uint8Array {
  return readBoundedRegularFile(resolve(path), MAX_PATCH_BYTES, "Patch");
}

/** Read-only plan view that observes config drift on every plan lookup. */
class ConfigCheckedPlanStore implements PlanStore {
  readonly #plans: PlanStore;
  readonly #assertUnchanged: () => void;

  constructor(plans: PlanStore, assertUnchanged: () => void) {
    this.#plans = plans;
    this.#assertUnchanged = assertUnchanged;
  }

  save(): void {
    throw new Error("Git review never writes action plans");
  }

  get(actionId: string): PlannedAction | undefined {
    this.#assertUnchanged();
    return this.#plans.get(actionId);
  }
}

/**
 * One operation's config snapshot. Re-reading is an observation of the
 * file, not a reservation: it detects drift at boundaries, nothing more.
 */
class GitReviewSession {
  readonly #path: string;
  readonly #options: GitReviewConfigOptions;
  readonly snapshot: GitReviewConfigSnapshot;

  constructor(path: string, options: GitReviewConfigOptions) {
    this.#path = path;
    this.#options = options;
    this.snapshot = loadGitReviewConfigSnapshot(path, options);
  }

  /**
   * Host trust whose every read re-observes the config file. The ledger
   * parses trust again inside its insertion transaction and at each final
   * authentication, so those late reads fail closed on drift instead of
   * reusing the value parsed when the session opened.
   */
  get trust(): GitOperatorReviewTrustV1 {
    const trusted = this.snapshot.config.trust;
    const checked = (read: () => unknown): PropertyDescriptor => ({
      enumerable: true,
      get: () => {
        this.assertUnchanged();
        return read();
      },
    });
    return Object.defineProperties({} as GitOperatorReviewTrustV1, {
      audience: checked(() => trusted.audience),
      maxReviewTtlMs: checked(() => trusted.maxReviewTtlMs),
      operators: checked(() => trusted.operators),
    });
  }

  assertUnchanged(): void {
    let digest;
    try {
      digest = loadGitReviewConfigSnapshot(this.#path, this.#options).digest;
    } catch {
      throw new Error(
        "Git review config changed or became invalid during the operation",
      );
    }
    if (digest !== this.snapshot.digest) {
      throw new Error("Git review config changed during the operation");
    }
  }

  context(plans: PlanStore): GitPlanBindingContext {
    const config = this.snapshot.config;
    return {
      repositoryPath: config.repositoryPath,
      repositoryId: config.repositoryId,
      destinationRef: config.destinationRef,
      catalogTool: config.catalogTool,
      currentPolicy: config.currentPolicy,
      plans: new ConfigCheckedPlanStore(plans, () => {
        this.assertUnchanged();
      }),
    };
  }

  openPlans(): SqliteExecutionStore {
    return new SqliteExecutionStore(this.snapshot.paths.planDatabasePath);
  }

  openApprovals(): SqliteGitApprovalStore {
    return new SqliteGitApprovalStore(this.snapshot.paths.approvalDatabasePath);
  }
}

function prepareRequest(
  session: GitReviewSession,
  proposal: GitChangeProposalV1,
  patch: Uint8Array,
): { request: GitOperatorReviewRequestV1; stagedPatch: Uint8Array } {
  const plans = session.openPlans();
  try {
    return prepareGitOperatorReviewFromPlan({
      proposal,
      patch,
      context: session.context(plans),
    });
  } finally {
    plans.close();
  }
}

function runPrepare(options: Options, io: GitReviewCliIo): number {
  const session = new GitReviewSession(option(options, "config"), {
    requirePlanDatabase: true,
  });
  const proposal = readProposal(option(options, "proposal"));
  const patch = readPatch(option(options, "patch"));
  const { request } = prepareRequest(session, proposal, patch);
  session.assertUnchanged();
  io.stdout(asciiJson(request));
  return 0;
}

function authorizedOperator(
  trust: GitOperatorReviewTrustV1,
  operatorId: string,
  authority: GitApprovalAuthority,
): GitOperatorReviewTrustV1["operators"][number] {
  const operator = trust.operators.find(
    (candidate) => candidate.operatorId === operatorId,
  );
  if (
    !operator?.enabled ||
    !operator.keys.some((key) => key.enabled) ||
    !operator.permissions.some(
      (permission) =>
        permission.repositoryId === authority.repositoryId &&
        permission.workspaceRootDigest === authority.workspaceRootDigest &&
        permission.destinationRef === authority.destinationRef,
    )
  ) {
    throw new Error(
      "Operator is not an enabled operator authorized for this repository scope",
    );
  }
  return operator;
}

function assertReviewExpiry(
  expiresAt: string,
  request: GitOperatorReviewRequestV1,
  trust: GitOperatorReviewTrustV1,
  issuedAt: number,
): void {
  const expiry = Date.parse(expiresAt);
  if (
    expiry <= issuedAt ||
    Date.parse(request.proposal.createdAt) > issuedAt ||
    expiry > Date.parse(request.proposal.expiresAt) ||
    expiry > Date.parse(request.authority.maxExpiresAt) ||
    expiry - issuedAt > trust.maxReviewTtlMs
  ) {
    throw new Error(
      "Review expiry must be in the future, within proposal and plan expiry, and within the host maximum review TTL",
    );
  }
}

function renderSigningReview(input: {
  request: GitOperatorReviewRequestV1;
  stagedPatch: Uint8Array;
  repositoryPath: string;
  operatorId: string;
  decision: string;
  expiresAt: string;
}): string {
  const { request, stagedPatch } = input;
  const { proposal, authority, staged } = request;
  const field = (label: string, value: string) =>
    `${label}: ${escapeUntrustedText(value)}\n`;
  const rendered = renderUntrustedBytes(stagedPatch);
  const lines = rendered.split("\n");
  const trailingNewline = rendered.endsWith("\n");
  if (trailingNewline) lines.pop();
  return [
    "==== ReproGate Git operator review: signing request ====\n",
    "Signing proves possession of the operator key only. It does not prove a human\n",
    "inspected this diff, and this tool does not scan the diff for secrets.\n",
    "Untrusted values are escaped: \\\\ is a backslash, \\xHH is a raw byte that is\n",
    "not valid UTF-8, \\t \\r \\n are tab, carriage return and newline, and \\u{H} is\n",
    'an escaped control, format or invisible code point. Diff lines start with "| ".\n',
    field("decision", input.decision),
    field("operatorId", input.operatorId),
    field("expiresAt", input.expiresAt),
    field("repositoryId", authority.repositoryId),
    field("repositoryPath", input.repositoryPath),
    field("destinationRef", authority.destinationRef),
    field("baseCommit", staged.baseCommit),
    field("candidateTreeOid", staged.candidateTreeOid),
    field("proposalId", proposal.proposalId),
    field("actionId", authority.actionId),
    field("policyDigest", authority.policyDigest),
    field("workspaceRootDigest", authority.workspaceRootDigest),
    field("authorityDigest", request.authorityDigest),
    field("effectDigest", request.effectDigest),
    field("patchDigest", proposal.patchDigest),
    field("stagedPatchDigest", staged.stagedPatchDigest),
    field("proposalExpiresAt", proposal.expiresAt),
    field("planMaxExpiresAt", authority.maxExpiresAt),
    `changedPaths (${String(staged.changedPaths.length)}):\n`,
    ...staged.changedPaths.map((path) => `  - ${escapeUntrustedText(path)}\n`),
    `---- BEGIN UNTRUSTED DIFF (${String(stagedPatch.byteLength)} bytes) ----\n`,
    ...lines.map((line) => `| ${line}\n`),
    trailingNewline ? "" : "(no trailing newline)\n",
    "---- END UNTRUSTED DIFF ----\n",
  ].join("");
}

const UNSAFE_KEY_FILE =
  "Signing key file must be a regular, non-linked file owned by the current user and not accessible by group or others";

/** Load a private Ed25519 key from a protected file without disclosing it. */
function loadSigningKey(path: string, protectedRoots: string[]): KeyObject {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "unknown error";
    throw new Error(`Signing key file could not be inspected (${code})`, {
      cause: error,
    });
  }
  if (!stats.isFile() || stats.nlink !== 1n) throw new Error(UNSAFE_KEY_FILE);
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (
      (stats.mode & 0o077n) !== 0n ||
      (uid !== undefined && stats.uid !== BigInt(uid))
    ) {
      throw new Error(UNSAFE_KEY_FILE);
    }
  }
  assertOutsideProtectedRepository(path, protectedRoots, "Signing key file");
  const bytes = readBoundedRegularFile(
    path,
    MAX_KEY_BYTES,
    "Signing key file",
    {
      noFollow: true,
      verify: (opened) => {
        if (
          opened.dev !== stats.dev ||
          opened.ino !== stats.ino ||
          opened.nlink !== 1n
        ) {
          throw new Error(UNSAFE_KEY_FILE);
        }
      },
    },
  );
  try {
    const key = createPrivateKey({ key: bytes, format: "pem" });
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("Unsupported key");
    }
    return key;
  } catch {
    throw new Error(
      "Signing key could not be loaded as an unencrypted Ed25519 private key",
    );
  } finally {
    bytes.fill(0);
  }
}

function runSign(options: Options, io: GitReviewCliIo): number {
  const operatorId = option(options, "operator");
  if (!IDENTIFIER_PATTERN.test(operatorId)) {
    throw new UsageError("--operator must be a configured operator identifier");
  }
  const decision = option(options, "decision");
  if (decision !== "approve" && decision !== "deny") {
    throw new UsageError("--decision must be approve or deny");
  }
  const expiresAt = option(options, "expires-at");
  const expiry = Date.parse(expiresAt);
  if (
    !TIMESTAMP_PATTERN.test(expiresAt) ||
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== expiresAt
  ) {
    throw new UsageError(
      "--expires-at must be a canonical UTC timestamp such as 2030-01-01T00:00:00.000Z",
    );
  }
  const keyPath = resolve(option(options, "key-file"));

  const session = new GitReviewSession(option(options, "config"), {
    requirePlanDatabase: true,
  });
  const proposal = readProposal(option(options, "proposal"));
  const patch = readPatch(option(options, "patch"));
  const claimed = readJsonFile(
    option(options, "request"),
    MAX_REQUEST_BYTES,
    "Prepared review request",
  );
  const { request, stagedPatch } = prepareRequest(session, proposal, patch);
  let claimedJson: string | undefined;
  try {
    claimedJson = canonicalJson(claimed);
  } catch {
    claimedJson = undefined;
  }
  if (claimedJson !== canonicalJson(request)) {
    throw new Error(
      "Prepared review request does not match the freshly regenerated request",
    );
  }
  if (sha256(stagedPatch) !== request.staged.stagedPatchDigest) {
    throw new Error("Staged diff does not match the staged patch digest");
  }
  session.assertUnchanged();
  const operator = authorizedOperator(
    session.trust,
    operatorId,
    request.authority,
  );
  assertReviewExpiry(expiresAt, request, session.trust, Date.now());
  io.stderr(
    renderSigningReview({
      request,
      stagedPatch,
      repositoryPath: session.snapshot.config.repositoryPath,
      operatorId,
      decision,
      expiresAt,
    }),
  );

  // All Git staging and authority rederivation is complete. No Git
  // subprocess runs after the private key is loaded.
  const privateKey = loadSigningKey(
    keyPath,
    session.snapshot.paths.protectedRoots,
  );
  let keyId;
  try {
    keyId = gitOperatorKeyId(createPublicKey(privateKey));
  } catch {
    throw new Error("Signing key could not be loaded");
  }
  if (!operator.keys.some((key) => key.enabled && key.keyId === keyId)) {
    throw new Error("Signing key is not an enabled key for this operator");
  }
  session.assertUnchanged();
  const issuedAt = new Date();
  assertReviewExpiry(expiresAt, request, session.trust, issuedAt.getTime());
  const payload: GitOperatorReviewPayloadV1 = {
    reviewVersion: 1,
    audience: session.trust.audience,
    operatorId,
    keyId,
    decision,
    proposalId: request.proposal.proposalId,
    authorityDigest: request.authorityDigest,
    effectDigest: request.effectDigest,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
  };
  let review;
  try {
    review = signGitOperatorReview(payload, privateKey);
  } catch {
    throw new Error("Git operator review signing failed");
  }
  const authenticated = authenticateGitOperatorReview(
    review,
    request.proposal,
    request.authority,
    request.effectDigest,
    session.trust,
  );
  if (authenticated === undefined) {
    throw new Error("Signed review failed authentication under host trust");
  }
  session.assertUnchanged();
  io.stdout(asciiJson(authenticated));
  return 0;
}

function runImport(options: Options, io: GitReviewCliIo): number {
  const session = new GitReviewSession(option(options, "config"), {
    requirePlanDatabase: true,
  });
  const proposal = readProposal(option(options, "proposal"));
  const patch = readPatch(option(options, "patch"));
  const review = readJsonFile(
    option(options, "review"),
    MAX_REVIEW_BYTES,
    "Signed review",
  );
  const plans = session.openPlans();
  try {
    const approvals = session.openApprovals();
    try {
      const result = applyGitOperatorReviewFromPlan(approvals, {
        proposal,
        patch,
        context: session.context(plans),
        trust: session.trust,
        review,
      });
      io.stdout(asciiJson(result));
      return 0;
    } finally {
      approvals.close();
    }
  } finally {
    plans.close();
  }
}

function runCheck(options: Options, io: GitReviewCliIo): number {
  const approvalId = approvalIdOption(options);
  const session = new GitReviewSession(option(options, "config"), {
    requirePlanDatabase: true,
    requireApprovalDatabase: true,
  });
  const proposal = readProposal(option(options, "proposal"));
  const patch = readPatch(option(options, "patch"));
  let valid: boolean;
  const plans = session.openPlans();
  try {
    const approvals = session.openApprovals();
    try {
      valid = matchesOperatorReviewedGitApprovalFromPlan(approvals, {
        approvalId,
        proposal,
        patch,
        context: session.context(plans),
        trust: session.trust,
      });
    } finally {
      approvals.close();
    }
  } finally {
    plans.close();
  }
  if (valid) {
    try {
      session.assertUnchanged();
    } catch {
      valid = false;
    }
  }
  io.stdout(asciiJson({ valid }));
  return valid ? 0 : 1;
}

function runRevoke(options: Options, io: GitReviewCliIo): number {
  const approvalId = approvalIdOption(options);
  // Ledger-only: no patch, proposal, staging, clean worktree or key needed.
  const session = new GitReviewSession(option(options, "config"), {
    requirePlanDatabase: false,
    requireApprovalDatabase: true,
  });
  let revoked: boolean;
  const approvals = session.openApprovals();
  try {
    session.assertUnchanged();
    revoked = approvals.revoke(approvalId);
  } finally {
    approvals.close();
  }
  io.stdout(asciiJson({ revoked }));
  return revoked ? 0 : 1;
}

const RUNNERS: Record<
  Command,
  (options: Options, io: GitReviewCliIo) => number
> = {
  prepare: runPrepare,
  sign: runSign,
  import: runImport,
  check: runCheck,
  revoke: runRevoke,
};

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

/** Run `reprogate git-review ...`; returns the process exit status. */
export function runGitReviewCli(args: string[], io: GitReviewCliIo): number {
  const [command, ...rest] = args;
  if (
    args.length === 1 &&
    (command === "--help" || command === "-h" || command === "help")
  ) {
    io.stdout(GIT_REVIEW_USAGE);
    return 0;
  }
  try {
    if (!isCommand(command)) {
      throw new UsageError("Unknown or missing git-review subcommand");
    }
    return RUNNERS[command](parseOptions(command, rest), io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`reprogate git-review: ${error.message}\n${GIT_REVIEW_USAGE}`);
      return 2;
    }
    io.stderr(
      `reprogate git-review: ${
        error instanceof Error
          ? escapeUntrustedText(error.message)
          : "Unknown git-review error"
      }\n`,
    );
    return 1;
  }
}
