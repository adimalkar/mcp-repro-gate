import { z } from "zod/v4";

import type {
  GitChangeProposal,
  GitChangeProposalV1,
  GitChangeProposalV2,
} from "./git-change-proposal.js";
import type { Digest } from "./types.js";

// The negative lookahead requires the actual end of input, not before a newline.
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/u;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/u;
const MAX_WORKTREES = 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$(?![\s\S])/u;
const REF_PATTERN =
  /^refs\/heads\/(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|\.(?:\/|$)))(?!.*\/$)[A-Za-z0-9_+@-][A-Za-z0-9_./+@-]*$(?![\s\S])/u;
const TIMESTAMP_PATTERN =
  /^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$(?![\s\S])/u;

export const digestSchema = z
  .string()
  .length(71)
  .regex(DIGEST_PATTERN)
  .transform((value) => value as Digest);
export const oidSchema = z.string().regex(OID_PATTERN);
export const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(IDENTIFIER_PATTERN);
export const refSchema = z.string().min(12).max(1024).regex(REF_PATTERN);
export const timestampSchema = z
  .string()
  .min(24)
  .max(27)
  .regex(TIMESTAMP_PATTERN)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, "Timestamp must be canonical UTC ISO-8601");

/**
 * `snapshot` is the ledger/CLI import shape; `review` additionally applies the
 * operator-review identity, ref and canonical-time checks.
 */
export type GitChangeProposalProfile = "snapshot" | "review";
/** Which proposal versions a parser accepts. */
export type GitChangeProposalVersions = 1 | 2 | "any";

// Zod v4 and JSON Schema measure these caps in Unicode code points.
// Keep the original numeric limits for both structural and review profiles.
function boundedString(max: number) {
  return z.string().min(1).max(max);
}

const allowedPathsSchema = z
  .array(boundedString(4096))
  .min(1)
  .max(256)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "Duplicate allowed paths",
  );

function fields(profile: GitChangeProposalProfile) {
  const review = profile === "review";
  return {
    proposalId: digestSchema,
    repositoryId: review ? identifierSchema : boundedString(256),
    actionId: digestSchema,
    policyDigest: digestSchema,
    ref: review ? refSchema : boundedString(1024),
    patchDigest: digestSchema,
    allowedPaths: allowedPathsSchema,
    time: review ? timestampSchema : boundedString(64),
  };
}

function schemasFor(profile: GitChangeProposalProfile) {
  const shared = fields(profile);
  const workspaceV1 = z.strictObject({
    source: z.literal("git_observed"),
    rootDigest: digestSchema,
    headCommit: oidSchema,
    headTree: oidSchema,
    destinationRef: shared.ref,
    destinationOid: oidSchema,
    status: z.literal("clean"),
  });
  const workspaceV2 = z
    .strictObject({
      workspaceVersion: z.literal(2),
      source: z.literal("git_observed"),
      destinationMode: z.literal("uncheckout_destination"),
      rootDigest: digestSchema,
      commonDirDigest: digestSchema,
      headRef: shared.ref,
      headCommit: oidSchema,
      headTree: oidSchema,
      destinationRef: shared.ref,
      destinationOid: oidSchema,
      status: z.literal("clean"),
    })
    .refine(
      (workspace) =>
        workspace.headRef.startsWith("refs/heads/") &&
        workspace.destinationRef.startsWith("refs/heads/") &&
        workspace.headRef !== workspace.destinationRef &&
        workspace.destinationOid === workspace.headCommit,
      "V2 destination must be a distinct local branch at the source base",
    );
  const body = {
    proposalId: shared.proposalId,
    repositoryId: shared.repositoryId,
    actionId: shared.actionId,
    policyDigest: shared.policyDigest,
    patchDigest: shared.patchDigest,
    allowedPaths: shared.allowedPaths,
    createdAt: shared.time,
    expiresAt: shared.time,
  };
  return {
    v1: z.strictObject({
      proposalVersion: z.literal(1),
      ...body,
      workspace: workspaceV1,
    }),
    v2: z.strictObject({
      proposalVersion: z.literal(2),
      ...body,
      workspace: workspaceV2,
    }),
  };
}

const SCHEMAS = {
  snapshot: schemasFor("snapshot"),
  review: schemasFor("review"),
} as const;

const ROOT_FIELDS = new Set([
  "proposalVersion",
  "proposalId",
  "repositoryId",
  "actionId",
  "policyDigest",
  "workspace",
  "patchDigest",
  "allowedPaths",
  "createdAt",
  "expiresAt",
]);
const WORKSPACE_FIELDS = new Set([
  "workspaceVersion",
  "source",
  "destinationMode",
  "rootDigest",
  "commonDirDigest",
  "headRef",
  "headCommit",
  "headTree",
  "destinationRef",
  "destinationOid",
  "status",
]);

function shapeDescriptors(
  value: unknown,
  allowed: Set<string>,
): Record<string, PropertyDescriptor> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Git proposal must contain plain objects");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Git proposal must contain plain objects");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new Error("Git proposal contains unknown fields");
  }
  return captureDescriptors(value, keys);
}

function captureDescriptors(
  value: object,
  keys: (string | symbol)[],
): Record<string, PropertyDescriptor> {
  const descriptors: Record<string, PropertyDescriptor> = {};
  // Do not ask ownKeys a second time (a Proxy can switch or enlarge its shape).
  // The caller has already bounded and whitelisted this exact key list.
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("Unexpected symbol field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      throw new Error("Git proposal contains missing or non-enumerable fields");
    }
    descriptors[key] = descriptor;
  }
  return descriptors;
}

function readDescriptor(
  value: object,
  descriptor: PropertyDescriptor,
): unknown {
  // Use the captured descriptor rather than rereading a potentially replaced
  // property. Accessors are permitted, but each is invoked exactly once.
  return "value" in descriptor
    ? descriptor.value
    : (descriptor.get as (() => unknown) | undefined)?.call(value);
}

function captureScalar(value: unknown): unknown {
  // The largest contract string is 4096 code points, at most 8192 UTF-16
  // units. Bound capture before Zod walks it; per-field limits stay stricter.
  if (typeof value === "string" && value.length <= 8192) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Git proposal scalar is malformed or over limit");
}

function capturePaths(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error("Allowed paths must be a plain array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== "number" || length < 1 || length > 256) {
    throw new Error("Allowed paths must contain 1 to 256 paths");
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new Error("Allowed paths contain holes or unknown fields");
  }
  const descriptors = captureDescriptors(
    value,
    keys.filter((key) => key !== "length"),
  );
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable) throw new Error("Allowed path is missing");
    return captureScalar(readDescriptor(value, descriptor));
  });
}

function captureProposal(value: unknown): Record<string, unknown> {
  const descriptors = shapeDescriptors(value, ROOT_FIELDS);
  const root = value as object;
  const owned: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const field = readDescriptor(root, descriptor);
    if (key === "workspace") {
      const workspaceDescriptors = shapeDescriptors(field, WORKSPACE_FIELDS);
      const workspace: Record<string, unknown> = {};
      for (const [name, nested] of Object.entries(workspaceDescriptors)) {
        workspace[name] = captureScalar(
          readDescriptor(field as object, nested),
        );
      }
      owned[key] = workspace;
    } else if (key === "allowedPaths") {
      owned[key] = capturePaths(field);
    } else {
      owned[key] = captureScalar(field);
    }
  }
  return owned;
}

/**
 * Read an untrusted value exactly once into an owned, strictly shaped copy.
 * Structure only: integrity and authority are separate checks. Versions never
 * mix; unknown, missing or extra fields in either the proposal or its
 * workspace are rejected.
 */
export function parseGitChangeProposalStructure(
  value: unknown,
  profile: GitChangeProposalProfile,
  versions: 1,
): GitChangeProposalV1;
export function parseGitChangeProposalStructure(
  value: unknown,
  profile: GitChangeProposalProfile,
  versions: 2,
): GitChangeProposalV2;
export function parseGitChangeProposalStructure(
  value: unknown,
  profile: GitChangeProposalProfile,
  versions: GitChangeProposalVersions,
): GitChangeProposal;
export function parseGitChangeProposalStructure(
  value: unknown,
  profile: GitChangeProposalProfile,
  versions: GitChangeProposalVersions,
): GitChangeProposal {
  const owned = captureProposal(value);
  const schemas = SCHEMAS[profile];
  if (versions === 1) return schemas.v1.parse(owned);
  if (versions === 2) return schemas.v2.parse(owned);
  switch (owned.proposalVersion) {
    case 1:
      return schemas.v1.parse(owned);
    case 2:
      return schemas.v2.parse(owned);
    default:
      throw new Error("Unsupported Git change proposal version");
  }
}

/** Strict owned snapshots for both versions; never dispatch on caller fields. */
export function ownGitChangeProposal<T extends GitChangeProposal>(
  proposal: T,
): T {
  return parseGitChangeProposalStructure(proposal, "snapshot", "any") as T;
}

export interface GitWorktreeRecord {
  path: Buffer;
  branch: string | undefined;
}

/**
 * Parse `git worktree list --porcelain -z`: NUL-terminated attributes with an
 * extra NUL ending each record. Anything unexpected fails closed.
 */
export function parseGitWorktreeList(raw: Buffer): GitWorktreeRecord[] {
  // Latin-1 is used ONLY for byte-preserving record splitting and paths.
  // Ref identities are strictly UTF-8 decoded below, matching Git observations.
  if (raw.length > 1024 * 1024)
    throw new Error("Git worktree list is too large");
  const text = raw.toString("latin1");
  if (!text.endsWith("\0\0")) {
    throw new Error("Git worktree list is truncated or malformed");
  }
  const blocks = text.slice(0, -2).split("\0\0");
  if (blocks.length > MAX_WORKTREES) {
    throw new Error("Git worktree list is too large");
  }
  return blocks.map((block) => {
    const attributes = block.split("\0");
    const first = attributes[0] ?? "";
    if (!first.startsWith("worktree ") || first.length === "worktree ".length) {
      throw new Error("Git worktree list record is malformed");
    }
    let head = false;
    let bare = false;
    let detached = false;
    let locked = false;
    let prunable = false;
    let branch: string | undefined;
    for (const attribute of attributes.slice(1)) {
      if (attribute.startsWith("HEAD ") && !head) {
        if (!OID_PATTERN.test(attribute.slice(5))) {
          throw new Error("Git worktree list record is malformed");
        }
        head = true;
      } else if (attribute.startsWith("branch refs/") && branch === undefined) {
        branch = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(Buffer.from(attribute.slice("branch ".length), "latin1"));
      } else if (attribute === "detached" && !detached) {
        detached = true;
      } else if (attribute === "bare" && !bare) {
        bare = true;
      } else if (
        (attribute === "locked" || attribute.startsWith("locked ")) &&
        !locked
      ) {
        locked = true;
      } else if (
        (attribute === "prunable" || attribute.startsWith("prunable ")) &&
        !prunable
      ) {
        prunable = true;
      } else {
        throw new Error("Git worktree list record is malformed");
      }
    }
    // Exactly one complete record shape: bare, attached, or detached.
    const complete = bare
      ? !head && !detached && branch === undefined
      : head && (detached ? branch === undefined : branch !== undefined);
    if (!complete) {
      throw new Error("Git worktree list record is inconsistent");
    }
    return {
      path: Buffer.from(first.slice("worktree ".length), "latin1"),
      branch,
    };
  });
}
