import { isAbsolute } from "node:path";
import { isProxy } from "node:util/types";
import { z } from "zod/v4";

export const MAX_HANDOFF_BYTES = 64 * 1024;
export const MAX_HANDOFF_DOCUMENT_BYTES = 96 * 1024;
export const HANDOFF_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/u;
export const HANDOFF_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u;
const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (value) =>
        Buffer.byteLength(value) <= bytes &&
        Buffer.from(value).toString("utf8") === value,
    );
// Terminal escapes and bidi overrides would render deceptively when an agent
// or operator prints the projection; only tab, LF and CR remain.
export const HANDOFF_UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex -- Matching control characters is the purpose.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const contextText = (bytes: number) =>
  text(bytes).refine((value) => !HANDOFF_UNSAFE_TEXT.test(value));
export const handoffDigestSchema = z.string().regex(HANDOFF_DIGEST_PATTERN);
export const handoffUuidSchema = z.string().regex(HANDOFF_UUID_PATTERN);
const revisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const pathSchema = text(4096)
  .min(1)
  .refine((value) => !/[\0\r\n]/u.test(value));
const declaredPathSchema = contextText(512)
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/[\\\0\r\n:]/u.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const handoffContextSchema = z.strictObject({
  activeAgent: contextText(64)
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/u),
  goal: contextText(4096).min(1),
  completed: z.array(contextText(4096).min(1)).max(16),
  touchedFiles: z.array(declaredPathSchema).max(32),
  blockers: z.array(contextText(4096).min(1)).max(16),
  nextSteps: z.array(contextText(4096).min(1)).max(16),
});
export const handoffConfigSchema = z.strictObject({
  configVersion: z.literal(1),
  workspaceRoot: pathSchema.refine(isAbsolute),
  databasePath: pathSchema.refine(isAbsolute),
  allowUpdates: z.boolean(),
});
export const handoffUpdateSchema = z.strictObject({
  handoffVersion: z.literal(1),
  updateId: handoffUuidSchema,
  expectedRevision: revisionSchema,
  expectedDocumentDigest: handoffDigestSchema.nullable(),
  context: handoffContextSchema,
  actionIds: z.array(handoffDigestSchema).max(16),
});
export const handoffStatusInputSchema = z.strictObject({
  handoffVersion: z.literal(1),
  includeContext: z.boolean().optional(),
});
const timestampSchema = z
  .string()
  .min(24)
  .max(27)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  });
export const handoffReferenceSchema = z.strictObject({
  actionId: handoffDigestSchema,
  envelopeDigest: handoffDigestSchema,
  executionCounts: z.strictObject({
    prepared: revisionSchema,
    succeeded: revisionSchema,
    failed: revisionSchema,
    indeterminate: revisionSchema,
  }),
});
export const handoffRecordSchema = z.strictObject({
  handoffVersion: z.literal(1),
  workspaceId: handoffDigestSchema,
  revision: revisionSchema.refine((value) => value > 0),
  updateId: handoffUuidSchema,
  createdAt: timestampSchema,
  provenance: z.literal("caller_asserted"),
  expectedDocumentDigest: handoffDigestSchema.nullable(),
  requestDigest: handoffDigestSchema,
  context: handoffContextSchema,
  references: z.array(handoffReferenceSchema).max(16),
});
export const handoffStatusSchema = z.strictObject({
  handoffVersion: z.literal(1),
  state: z.enum([
    "missing",
    "synchronized",
    "pending",
    "drifted",
    "unavailable",
  ]),
  revision: revisionSchema,
  updateId: handoffUuidSchema.nullable(),
  snapshotDigest: handoffDigestSchema.nullable(),
  documentDigest: handoffDigestSchema.nullable(),
  projectedDigest: handoffDigestSchema.nullable(),
  provenance: z.literal("caller_asserted"),
  counts: z.strictObject({
    completed: revisionSchema,
    touchedFiles: revisionSchema,
    blockers: revisionSchema,
    nextSteps: revisionSchema,
    references: revisionSchema,
  }),
  context: handoffContextSchema.optional(),
  references: z.array(handoffReferenceSchema).max(16).optional(),
});
export type HandoffConfigV1 = z.infer<typeof handoffConfigSchema>;
export type HandoffUpdateV1 = z.infer<typeof handoffUpdateSchema>;
export type HandoffRecordV1 = z.infer<typeof handoffRecordSchema>;
export type HandoffStatusV1 = z.infer<typeof handoffStatusSchema>;
export type HandoffErrorCode =
  | "invalid_input"
  | "revision_conflict"
  | "document_conflict"
  | "update_conflict"
  | "unknown_plan"
  | "read_only"
  | "drifted"
  | "unavailable";
export class HandoffError extends Error {
  constructor(readonly code: HandoffErrorCode) {
    super(`Handoff ${code}`);
    this.name = "HandoffError";
  }
}

/** Reject caller getters/proxies before reading values; own a bounded plain tree. */
export function ownHandoffValue(value: unknown): unknown {
  let bytes = 0;
  function copy(current: unknown, depth: number): unknown {
    if (depth > 8) throw new HandoffError("invalid_input");
    if (typeof current === "string") {
      const length = Buffer.byteLength(current);
      bytes += length;
      if (
        length > 8192 ||
        bytes > MAX_HANDOFF_BYTES ||
        Buffer.from(current).toString("utf8") !== current
      )
        throw new HandoffError("invalid_input");
      return current;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    )
      return current;
    if (typeof current !== "object" || isProxy(current))
      throw new HandoffError("invalid_input");
    const array = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    )
      throw new HandoffError("invalid_input");
    const keys = Reflect.ownKeys(current);
    if (keys.length > (array ? 65 : 24))
      throw new HandoffError("invalid_input");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (array) {
      const length: unknown = descriptors.length?.value;
      if (
        typeof length !== "number" ||
        length > 64 ||
        keys.length !== length + 1
      )
        throw new HandoffError("invalid_input");
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          throw new HandoffError("invalid_input");
        result.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 64 || key === "__proto__")
        throw new HandoffError("invalid_input");
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        throw new HandoffError("invalid_input");
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_HANDOFF_BYTES)
    throw new HandoffError("invalid_input");
  return result;
}
export function parseHandoffConfig(value: unknown): HandoffConfigV1 {
  const parsed = handoffConfigSchema.safeParse(ownHandoffValue(value));
  if (!parsed.success) throw new HandoffError("invalid_input");
  return Object.freeze(parsed.data);
}
export function parseHandoffUpdate(value: unknown): HandoffUpdateV1 {
  const parsed = handoffUpdateSchema.safeParse(ownHandoffValue(value));
  if (
    !parsed.success ||
    new Set(parsed.data.actionIds).size !== parsed.data.actionIds.length ||
    new Set(parsed.data.context.touchedFiles).size !==
      parsed.data.context.touchedFiles.length
  )
    throw new HandoffError("invalid_input");
  return ownHandoffValue(parsed.data) as HandoffUpdateV1;
}
export function parseHandoffRecord(value: unknown): HandoffRecordV1 {
  const parsed = handoffRecordSchema.safeParse(ownHandoffValue(value));
  if (!parsed.success) throw new HandoffError("unavailable");
  return ownHandoffValue(parsed.data) as HandoffRecordV1;
}

// Caller text is data: escape Markdown/HTML syntax so it cannot introduce
// headings, links, HTML or code fences, and keep every line inside its item.
function markdownText(value: string, indent: string): string {
  return value
    .split(/\r\n|\r|\n/u)
    .map((line) =>
      line
        .replace(/[\\`*_[\]<>#|~!]/gu, "\\$&")
        .replace(/^(\s*)([-+=])/u, "$1\\$2")
        .replace(/^(\s*\d+)([.)])/u, "$1\\$2"),
    )
    .join(`\n${indent}`);
}
function markdownList(items: readonly string[], empty: string): string {
  return items.length === 0
    ? `- ${empty}`
    : items.map((item) => `- ${markdownText(item, "  ")}`).join("\n");
}

/** Bounded shared-protocol projection of one immutable snapshot. */
export function renderHandoffRecord(record: HandoffRecordV1): Buffer {
  const { context, references } = record;
  const touched = context.touchedFiles.map(
    (path) => `- ${markdownText(path, "  ")}`,
  );
  const plans = references.map(
    ({ actionId, envelopeDigest, executionCounts: c }) =>
      `- ${actionId} (envelope ${envelopeDigest}; executions prepared ${String(c.prepared)}, succeeded ${String(c.succeeded)}, failed ${String(c.failed)}, indeterminate ${String(c.indeterminate)})`,
  );
  const document = [
    "# Agent Handoff & Session State",
    "",
    `- **Last Active Agent**: ${context.activeAgent}`,
    `- **Last Updated**: ${record.createdAt}`,
    `- **Revision**: ${String(record.revision)}`,
    `- **Update**: ${record.updateId}`,
    "",
    "> Written through ReproGate as caller-asserted advisory context. Agent identity and touched paths are declarations. It does not authorize execution or prove Git effects.",
    "",
    "## 1. Active Goal / Task",
    "",
    markdownText(context.goal, ""),
    "",
    "## 2. Where We Left Off",
    "",
    markdownList(context.completed, "Nothing recorded."),
    "",
    "Declared touched files:",
    "",
    touched.length === 0 ? "- None declared." : touched.join("\n"),
    ...(plans.length === 0
      ? []
      : ["", "Persisted plan references:", "", plans.join("\n")]),
    "",
    "## 3. Implementation Problems & Blockers",
    "",
    markdownList(context.blockers, "None recorded."),
    "",
    "## 4. Immediate Next Steps",
    "",
    markdownList(context.nextSteps, "None recorded."),
    "",
  ].join("\n");
  const bytes = Buffer.from(document);
  if (bytes.length > MAX_HANDOFF_DOCUMENT_BYTES)
    throw new HandoffError("invalid_input");
  return bytes;
}
