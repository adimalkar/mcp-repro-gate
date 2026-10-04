import { z } from "zod/v4";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { digestCanonical, sha256 } from "./digest.js";
import type { GitApprovalAuthority } from "./git-approval-store.js";
import {
  digestSchema,
  identifierSchema,
  oidSchema,
  parseGitChangeProposalStructure,
  refSchema,
  timestampSchema,
} from "./git-change-contract.js";
import {
  verifyGitChangeProposal,
  type GitChangeProposalV2,
} from "./git-change-proposal.js";
import {
  parseGitPromotionFenceOwner,
  type GitPromotionFenceOwnerV1,
} from "./git-promotion-host-control.js";
import type { PreparedGitPromotionObjectsV1 } from "./git-promotion-objects.js";
import type { Digest } from "./types.js";

/** Pure canonical UTC projection for the owned SQL invariant, not authority.
 * SQLite's date functions reject ISO extended years and can round milliseconds.
 * Reuse the timestamp contract (including exact roundtrip, no normalization),
 * bounding scalar input before validation; invalid SQL values project to NULL.
 */
export function gitPromotionTimestampEpoch(value: unknown): number | null {
  if (typeof value !== "string" || value.length < 24 || value.length > 27)
    return null;
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success) return null;
  const epoch = Date.parse(parsed.data);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

export const promotionUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u,
  );
const stagedSchema = z.strictObject({
  stageVersion: z.literal(1),
  proposalId: digestSchema,
  baseCommit: oidSchema,
  candidateTreeOid: oidSchema,
  changedPaths: z.array(z.string().min(1).max(4096)).min(1).max(256),
  stagedPatchDigest: digestSchema,
});
const preparedSchema = z.strictObject({
  preparedVersion: z.literal(1),
  attemptId: promotionUuidSchema,
  proposalId: digestSchema,
  expectedOldOid: oidSchema,
  baseCommit: oidSchema,
  candidateCommitOid: oidSchema,
  candidateTreeOid: oidSchema,
  staged: stagedSchema,
  effectDigest: digestSchema,
  hostCommitMetadataDigest: digestSchema,
  createdAt: timestampSchema,
});
const authoritySchema = z.strictObject({
  repositoryId: identifierSchema,
  actionId: digestSchema,
  policyDigest: digestSchema,
  workspaceRootDigest: digestSchema,
  destinationRef: refSchema,
  maxExpiresAt: timestampSchema,
});
const pathSchema = z.string().min(1).max(4096);
const attemptSchema = z.strictObject({
  attemptVersion: z.literal(1),
  state: z.literal("prepared"),
  attemptId: promotionUuidSchema,
  approvalId: promotionUuidSchema,
  proposalId: digestSchema,
  reviewDigest: digestSchema,
  authorityDigest: digestSchema,
  effectDigest: digestSchema,
  proposal: z.unknown(),
  prepared: preparedSchema,
  authority: authoritySchema,
  repositoryPath: pathSchema,
  fenceOwner: z.unknown(),
  precheckedAt: timestampSchema,
  reservedAt: timestampSchema,
  admissionDeadline: timestampSchema,
});

export type ImmutablePromotion<T> = T extends readonly (infer V)[]
  ? readonly ImmutablePromotion<V>[]
  : T extends object
    ? { readonly [K in keyof T]: ImmutablePromotion<T[K]> }
    : T;
/**
 * Immutable T1 intent only. No dispatch, physical ref observation, quiescence or
 * final authorization is asserted. Task3C must add separately validated evidence
 * for prepared|confirmed|failed|indeterminate transitions; no terminal setter is
 * provided here. Expiry is an admission deadline, not a physical Git clock bound.
 */
/** Future transition vocabulary; not public construction/transition authority. */
export type GitPromotionState =
  "prepared" | "confirmed" | "failed" | "indeterminate";
export interface GitPromotionAttemptV1 {
  attemptVersion: 1;
  state: "prepared";
  attemptId: string;
  approvalId: string;
  proposalId: Digest;
  reviewDigest: Digest;
  authorityDigest: Digest;
  effectDigest: Digest;
  proposal: GitChangeProposalV2;
  prepared: PreparedGitPromotionObjectsV1;
  authority: GitApprovalAuthority;
  repositoryPath: string;
  fenceOwner: GitPromotionFenceOwnerV1;
  precheckedAt: string;
  reservedAt: string;
  admissionDeadline: string;
}

type CaptureShape =
  | "attempt"
  | "prepared"
  | "staged"
  | "authority"
  | "proposal"
  | "workspace"
  | "owner"
  | "config"
  | "strings"
  | "scalar";
const CAPTURE_FIELDS: Record<
  Exclude<CaptureShape, "strings" | "scalar">,
  readonly string[]
> = {
  attempt: Object.keys(attemptSchema.shape),
  prepared: Object.keys(preparedSchema.shape),
  staged: Object.keys(stagedSchema.shape),
  authority: Object.keys(authoritySchema.shape),
  proposal: [
    "proposalVersion",
    "proposalId",
    "repositoryId",
    "actionId",
    "policyDigest",
    "patchDigest",
    "allowedPaths",
    "createdAt",
    "expiresAt",
    "workspace",
  ],
  workspace: [
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
  ],
  owner: [
    "ownerVersion",
    "token",
    "attemptId",
    "commonDirectory",
    "approvalDatabasePath",
    "fencePath",
    "createdAt",
  ],
  config: ["repositoryPath", "approvalDatabasePath", "fencePath", "statePaths"],
};
function childShape(shape: CaptureShape, key: string): CaptureShape {
  if (shape === "attempt") {
    if (key === "proposal") return "proposal";
    if (key === "prepared") return "prepared";
    if (key === "authority") return "authority";
    if (key === "fenceOwner") return "owner";
  }
  if (shape === "proposal" && key === "workspace") return "workspace";
  if (shape === "prepared" && key === "staged") return "staged";
  if (
    (shape === "staged" && key === "changedPaths") ||
    (shape === "proposal" && key === "allowedPaths") ||
    (shape === "config" && key === "statePaths")
  )
    return "strings";
  return "scalar";
}
/** Strict shape-first descriptor capture; unknown subtrees are never traversed. */
export function capturePromotionData(
  value: unknown,
  shape: "prepared" | "attempt" | "config",
): unknown {
  return capture(value, shape, 0);
}
function capture(value: unknown, shape: CaptureShape, depth: number): unknown {
  if (depth > 6) throw new Error("Promotion input nesting exceeds its bound");
  if (typeof value === "string") {
    if (value.length > 8192)
      throw new Error("Promotion scalar exceeds its bound");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object")
    throw new Error("Promotion input is not plain data");
  const array = Array.isArray(value);
  if (shape === "scalar" || array !== (shape === "strings"))
    throw new Error("Promotion field has the wrong data shape");
  const proto: unknown = Object.getPrototypeOf(value);
  if (
    array
      ? proto !== Array.prototype
      : proto !== Object.prototype && proto !== null
  )
    throw new Error("Promotion input is not plain data");
  const keys = Reflect.ownKeys(value);
  const fields = shape === "strings" ? undefined : CAPTURE_FIELDS[shape];
  if (
    keys.length > (array ? 257 : (fields?.length ?? 0)) ||
    (!array &&
      keys.some((key) => typeof key !== "string" || !fields?.includes(key)))
  )
    throw new Error(
      "Promotion input shape exceeds its bound or contains unknown fields",
    );
  const result: Record<string, unknown> = {};
  const items: unknown[] = [];
  let length = 0;
  if (array) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const n: unknown = descriptor?.value;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 0 ||
      n > 256 ||
      keys.length !== n + 1
    )
      throw new Error("Promotion array must be dense and bounded");
    length = n;
  }
  for (const key of keys) {
    if (array && key === "length") continue;
    if (
      typeof key !== "string" ||
      (!array && ["__proto__", "constructor", "prototype"].includes(key)) ||
      (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))
    )
      throw new Error("Unexpected promotion field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new Error("Promotion accessors/nonenumerable fields are forbidden");
    const owned = capture(
      descriptor.value,
      array ? "scalar" : childShape(shape, key),
      depth + 1,
    );
    if (array) items[Number(key)] = owned;
    else result[key] = owned;
  }
  return array ? items : result;
}
function freeze<T>(value: T): ImmutablePromotion<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as ImmutablePromotion<T>;
}
export function parsePreparedGitPromotionObjects(
  value: unknown,
): PreparedGitPromotionObjectsV1 {
  const p = preparedSchema.parse(capturePromotionData(value, "prepared"));
  if (
    p.expectedOldOid !== p.baseCommit ||
    p.staged.baseCommit !== p.baseCommit ||
    p.staged.proposalId !== p.proposalId ||
    p.staged.candidateTreeOid !== p.candidateTreeOid ||
    p.effectDigest !== digestCanonical(p.staged) ||
    [p.candidateCommitOid, p.candidateTreeOid].some(
      (oid) => oid.length !== p.baseCommit.length,
    ) ||
    canonicalJson(p.staged.changedPaths) !==
      canonicalJson([...new Set(p.staged.changedPaths)].sort())
  )
    throw new Error("Prepared candidate bindings are inconsistent");
  return p;
}
export function parseGitPromotionAttempt(
  value: unknown,
): ImmutablePromotion<GitPromotionAttemptV1> {
  const r = attemptSchema.parse(capturePromotionData(value, "attempt"));
  const proposal = parseGitChangeProposalStructure(r.proposal, "review", 2);
  const prepared = parsePreparedGitPromotionObjects(r.prepared);
  const owner = parseGitPromotionFenceOwner(r.fenceOwner);
  const authority = r.authority;
  if (
    Buffer.byteLength(canonicalJson(r)) > 16 * 1024 * 1024 ||
    !isAbsolute(r.repositoryPath) ||
    resolve(r.repositoryPath) !== r.repositoryPath ||
    r.repositoryPath.includes("\0") ||
    Buffer.byteLength(r.repositoryPath) > 4096 ||
    Buffer.from(r.repositoryPath).toString("utf8") !== r.repositoryPath ||
    sha256(r.repositoryPath) !== proposal.workspace.rootDigest ||
    sha256(owner.commonDirectory) !== proposal.workspace.commonDirDigest
  )
    throw new Error(
      "Promotion physical path/record envelope bindings are inconsistent",
    );
  if (
    !verifyGitChangeProposal(proposal) ||
    r.attemptId !== prepared.attemptId ||
    r.attemptId !== owner.attemptId ||
    r.proposalId !== proposal.proposalId ||
    r.proposalId !== prepared.proposalId ||
    r.effectDigest !== prepared.effectDigest ||
    r.authorityDigest !== digestCanonical(authority) ||
    authority.repositoryId !== proposal.repositoryId ||
    authority.actionId !== proposal.actionId ||
    authority.policyDigest !== proposal.policyDigest ||
    authority.workspaceRootDigest !== proposal.workspace.rootDigest ||
    authority.destinationRef !== proposal.workspace.destinationRef ||
    prepared.baseCommit !== proposal.workspace.headCommit ||
    prepared.expectedOldOid !== proposal.workspace.destinationOid ||
    prepared.staged.changedPaths.some(
      (path) => !proposal.allowedPaths.includes(path),
    ) ||
    Date.parse(r.precheckedAt) > Date.parse(r.reservedAt) ||
    Date.parse(prepared.createdAt) > Date.parse(r.precheckedAt) ||
    Date.parse(prepared.createdAt) < Date.parse(proposal.createdAt) ||
    Date.parse(owner.createdAt) > Date.parse(r.reservedAt) ||
    Date.parse(r.reservedAt) >= Date.parse(r.admissionDeadline) ||
    Date.parse(r.admissionDeadline) >
      Math.min(
        Date.parse(proposal.expiresAt),
        Date.parse(authority.maxExpiresAt),
      )
  )
    throw new Error("Promotion intent bindings or timing are inconsistent");
  // JSON Schema caps are code-point based, as are Zod's string caps. Physical
  // filesystem paths additionally require lossless UTF-8 and <=4096 BYTES in
  // the concrete host-control module; schema acceptance is not path authority.
  return freeze({ ...r, proposal, prepared, fenceOwner: owner });
}
