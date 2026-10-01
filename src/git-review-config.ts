import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod/v4";

import { digestCanonical } from "./digest.js";
import {
  parseGitOperatorReviewTrust,
  type GitOperatorReviewTrustV1,
} from "./git-operator-review.js";
import { GIT_CHANGE_PROMOTE_SCOPE } from "./git-plan-binding.js";
import { evaluatePolicy } from "./policy.js";
import type { CatalogTool, Digest, PolicyV1 } from "./types.js";

/**
 * Host-only configuration for out-of-band Git operator review. Separate from
 * the Phase 2 runtime configuration: no backends, observers or HMAC secrets,
 * and never a private signing key.
 */
export interface GitReviewConfigV1 {
  configVersion: 1;
  repositoryPath: string;
  repositoryId: string;
  destinationRef: string;
  planDatabasePath: string;
  approvalDatabasePath: string;
  catalogTool: CatalogTool;
  currentPolicy: PolicyV1;
  trust: GitOperatorReviewTrustV1;
}

export interface GitReviewConfigOptions {
  /** Plan operations read persisted plans and must not create an empty DB. */
  requirePlanDatabase?: boolean;
  /** Check and revoke read an existing ledger; import may create it. */
  requireApprovalDatabase?: boolean;
}

/** Canonicalized filesystem locations observed during validation. */
export interface GitReviewStatePaths {
  protectedRoots: string[];
  planDatabasePath: string;
  approvalDatabasePath: string;
}

export interface GitReviewConfigSnapshot {
  config: GitReviewConfigV1;
  digest: Digest;
  paths: GitReviewStatePaths;
}

export const MAX_GIT_REVIEW_CONFIG_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_GIT_FILE_BYTES = 4096;
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

// Mirrors the operator review identifier and branch-ref profiles so a
// configured repository and destination can match host trust permissions.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$(?![\s\S])/u;
const REF_PATTERN =
  /^refs\/heads\/(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|\.(?:\/|$)))(?!.*\/$)[A-Za-z0-9_+@-][A-Za-z0-9_./+@-]*$(?![\s\S])/u;

const digestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$(?![\s\S])/u)
  .transform((value) => value as Digest);
const effectSchema = z.enum([
  "local_read",
  "local_write",
  "process_exec",
  "network_read",
  "network_write",
  "credential_use",
  "destructive",
]);
const decisionSchema = z.enum(["allow", "approval_required", "deny"]);
const stringArray = z.array(z.string().min(1));
const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);

// Catalog and policy shapes follow runtime-config.ts. artifactDigest is
// optional, as in plan-bound Git catalog tools; scopes are required because
// plan-bound Git authority requires the promote scope.
const catalogToolSchema = z.strictObject({
  toolRef: z.string().min(1),
  serverRef: z.string().min(1),
  toolName: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.unknown(),
  effects: z.array(effectSchema).min(1),
  scopes: stringArray,
  filesystemRoots: stringArray.optional(),
  networkDestinations: stringArray.optional(),
  secretHandles: stringArray.optional(),
  sensitivityLabels: stringArray.optional(),
  artifactDigest: digestSchema.optional(),
});

const policySchema = z.strictObject({
  version: z.literal(1),
  defaults: z.strictObject({
    local_read: decisionSchema,
    local_write: decisionSchema,
    process_exec: decisionSchema,
    network_read: decisionSchema,
    network_write: decisionSchema,
    credential_use: decisionSchema,
    destructive: decisionSchema,
  }),
  rules: z.array(
    z.strictObject({
      id: z.string().min(1),
      priority: z.number().int(),
      match: z.strictObject({
        toolRef: z.string().min(1).optional(),
        effect: effectSchema.optional(),
      }),
      decision: decisionSchema,
      reason: z.string().min(1),
    }),
  ),
});

const configSchema = z.strictObject({
  configVersion: z.literal(1),
  repositoryPath: pathSchema,
  repositoryId: z.string().min(1).max(256).regex(IDENTIFIER_PATTERN),
  destinationRef: z.string().min(12).max(1024).regex(REF_PATTERN),
  planDatabasePath: pathSchema,
  approvalDatabasePath: pathSchema,
  catalogTool: catalogToolSchema,
  currentPolicy: policySchema,
  trust: z.unknown(),
});

function optionalFlag(name: "O_NOFOLLOW" | "O_NONBLOCK"): number {
  // Not every platform defines these flags (notably Windows).
  return (constants as Partial<Record<string, number>>)[name] ?? 0;
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown error";
}

/**
 * Read at most maxBytes from one regular-file descriptor. The limit is
 * enforced while reading, so a file that grows after fstat is still refused.
 * Opening is non-blocking so FIFOs are rejected instead of hanging. This is
 * an observation, not a filesystem reservation.
 */
export function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
  options: { noFollow?: boolean; verify?: (stats: BigIntStats) => void } = {},
): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        optionalFlag("O_NONBLOCK") |
        (options.noFollow === true ? optionalFlag("O_NOFOLLOW") : 0),
    );
  } catch (error) {
    throw new Error(`${label} could not be opened (${errorCode(error)})`, {
      cause: error,
    });
  }
  const chunk = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024));
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
    options.verify?.(stats);
    if (stats.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds the ${String(maxBytes)} byte limit`);
    }
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the ${String(maxBytes)} byte limit`);
      }
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    // Intermediate copies may hold key material; the caller owns the result.
    chunk.fill(0);
    for (const part of chunks) part.fill(0);
    closeSync(descriptor);
  }
}

function describeIssues(error: z.ZodError): string {
  // Report structural locations only; never echo supplied values or
  // arbitrary unknown field names.
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path
        .map((part) =>
          typeof part === "number"
            ? `[${String(part)}]`
            : typeof part === "string" &&
                /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(part)
              ? `.${part}`
              : ".<field>",
        )
        .join("");
      return `${path === "" ? "<root>" : path.slice(path.startsWith(".") ? 1 : 0)}: ${issue.code}`;
    })
    .join("; ");
}

/**
 * Strict structural and semantic validation without filesystem access:
 * unknown fields, canonical catalog input schema, Git promote scope and
 * local_write effect, unambiguous policy, and valid public host trust.
 */
export function parseGitReviewConfig(value: unknown): GitReviewConfigV1 {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Git review config failed strict validation: ${describeIssues(parsed.error)}`,
    );
  }
  const config = parsed.data;
  const trust = parseGitOperatorReviewTrust(config.trust);
  const tool = config.catalogTool;
  try {
    digestCanonical(tool.inputSchema);
  } catch {
    throw new Error("Git review config catalogTool.inputSchema must be JSON");
  }
  if (!tool.effects.includes("local_write")) {
    throw new Error("Git review config catalogTool must declare local_write");
  }
  if (!tool.scopes.includes(GIT_CHANGE_PROMOTE_SCOPE)) {
    throw new Error(
      `Git review config catalogTool must declare ${GIT_CHANGE_PROMOTE_SCOPE}`,
    );
  }
  const currentPolicy = config.currentPolicy as PolicyV1;
  try {
    evaluatePolicy(currentPolicy, tool.toolRef, tool.effects);
  } catch {
    throw new Error(
      "Git review config currentPolicy is ambiguous for the catalog tool",
    );
  }
  return {
    ...config,
    catalogTool: tool as CatalogTool,
    currentPolicy,
    trust,
  };
}

function assertAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
}

const caseInsensitive =
  process.platform === "win32" || process.platform === "darwin";

function fold(path: string): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

function isWithin(child: string, parent: string): boolean {
  const path = relative(fold(parent), fold(child));
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function readGitPointer(path: string, pattern: RegExp, label: string): string {
  const text = readBoundedRegularFile(path, MAX_GIT_FILE_BYTES, label).toString(
    "utf8",
  );
  const match = pattern.exec(text);
  if (match?.[1] === undefined) throw new Error(`${label} is not recognized`);
  return match[1];
}

/**
 * Canonical locations state must stay out of: the worktree root, its .git
 * entry and, for linked worktrees, the gitdir and common Git directory.
 * Uses only filesystem reads, never Git subprocesses or worktree cleanliness.
 */
export function gitReviewProtectedRoots(repositoryPath: string): string[] {
  assertAbsolute(repositoryPath, "repositoryPath");
  let root: string;
  try {
    root = realpathSync.native(repositoryPath);
  } catch {
    throw new Error("repositoryPath must be an existing directory");
  }
  if (!statSync(root).isDirectory()) {
    throw new Error("repositoryPath must be an existing directory");
  }
  const dotGit = join(root, ".git");
  let entry;
  try {
    entry = statSync(dotGit);
  } catch {
    throw new Error("repositoryPath must be a Git worktree root with .git");
  }
  const physicalDotGit = realpathOrSelf(dotGit);
  const roots = [root, physicalDotGit];
  let gitDirectory = physicalDotGit;
  if (entry.isFile()) {
    gitDirectory = realpathOrSelf(
      resolve(
        root,
        readGitPointer(
          dotGit,
          /^gitdir: ([^\r\n]+)\r?\n?$(?![\s\S])/u,
          "Repository .git file",
        ),
      ),
    );
  } else if (!entry.isDirectory()) {
    throw new Error("repositoryPath must be a Git worktree root with .git");
  }
  roots.push(gitDirectory);
  // Both .git forms can identify a linked gitdir with a separate common
  // directory, including a directory symlink accepted by Git.
  const commonPath = join(gitDirectory, "commondir");
  let hasCommonDirectory = false;
  try {
    lstatSync(commonPath);
    hasCommonDirectory = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new Error("Repository commondir file could not be inspected", {
        cause: error,
      });
    }
  }
  if (hasCommonDirectory) {
    roots.push(
      realpathOrSelf(
        resolve(
          gitDirectory,
          readGitPointer(
            commonPath,
            /^([^\r\n]+)\r?\n?$(?![\s\S])/u,
            "Repository commondir file",
          ),
        ),
      ),
    );
  }
  return [...new Set(roots)];
}

/** Reject a path whose canonical parent location is inside protected roots. */
export function assertOutsideProtectedRepository(
  path: string,
  protectedRoots: string[],
  label: string,
): string {
  const name = basename(path);
  if (name === "" || name === "." || name === "..") {
    throw new Error(`${label} must name a file`);
  }
  let parent: string;
  try {
    parent = realpathSync.native(dirname(path));
  } catch {
    throw new Error(`${label} parent directory must exist`);
  }
  if (!statSync(parent).isDirectory()) {
    throw new Error(`${label} parent directory must exist`);
  }
  const canonical = join(parent, name);
  if (protectedRoots.some((root) => isWithin(canonical, root))) {
    throw new Error(`${label} must be outside the protected repository`);
  }
  return canonical;
}

function checkStatePath(
  path: string,
  label: string,
  protectedRoots: string[],
  required: boolean,
): string {
  assertAbsolute(path, label);
  const canonical = assertOutsideProtectedRepository(
    path,
    protectedRoots,
    label,
  );
  let exists = false;
  for (const suffix of ["", ...SQLITE_SIDECARS]) {
    let stats;
    try {
      stats = lstatSync(canonical + suffix);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw new Error(`${label} could not be inspected (${errorCode(error)})`, {
        cause: error,
      });
    }
    const what = suffix === "" ? label : `${label} sidecar`;
    // A symlink or hard link could alias a file inside the protected tree.
    if (!stats.isFile()) {
      throw new Error(`${what} must be a regular file, not a link or device`);
    }
    if (stats.nlink !== 1) throw new Error(`${what} must not be hard-linked`);
    if (suffix === "") exists = true;
  }
  if (required && !exists) throw new Error(`${label} must already exist`);
  return canonical;
}

/**
 * Filesystem checks: absolute paths, a Git worktree root, and SQLite state
 * (including -wal/-shm/-journal sidecars) physically outside the protected
 * repository with no symlink or hard-link aliases. Does not require a clean
 * worktree or checked-out ref. A hostile same-host process can still race
 * these checks; this is not a sandbox.
 */
export function resolveGitReviewStatePaths(
  config: GitReviewConfigV1,
  options: GitReviewConfigOptions = {},
): GitReviewStatePaths {
  const protectedRoots = gitReviewProtectedRoots(config.repositoryPath);
  const planDatabasePath = checkStatePath(
    config.planDatabasePath,
    "planDatabasePath",
    protectedRoots,
    options.requirePlanDatabase ?? true,
  );
  const approvalDatabasePath = checkStatePath(
    config.approvalDatabasePath,
    "approvalDatabasePath",
    protectedRoots,
    options.requireApprovalDatabase ?? false,
  );
  if (fold(planDatabasePath) === fold(approvalDatabasePath)) {
    throw new Error(
      "planDatabasePath and approvalDatabasePath must be different files",
    );
  }
  return { protectedRoots, planDatabasePath, approvalDatabasePath };
}

/** Canonical digest of the parsed config, used for drift detection. */
export function gitReviewConfigDigest(config: GitReviewConfigV1): Digest {
  return digestCanonical(config);
}

/** Bounded strict load plus filesystem validation and canonical digest. */
export function loadGitReviewConfigSnapshot(
  path: string,
  options: GitReviewConfigOptions = {},
): GitReviewConfigSnapshot {
  assertAbsolute(path, "Git review config path");
  const bytes = readBoundedRegularFile(
    path,
    MAX_GIT_REVIEW_CONFIG_BYTES,
    "Git review config",
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Parser diagnostics can quote input; report only the failure class.
    throw new Error("Git review config is not valid UTF-8 JSON");
  }
  const config = parseGitReviewConfig(value);
  const paths = resolveGitReviewStatePaths(config, options);
  return { config, digest: gitReviewConfigDigest(config), paths };
}

export function loadGitReviewConfig(
  path: string,
  options: GitReviewConfigOptions = {},
): GitReviewConfigV1 {
  return loadGitReviewConfigSnapshot(path, options).config;
}
