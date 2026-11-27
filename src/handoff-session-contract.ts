import { z } from "zod/v4";

import {
  HANDOFF_PROVENANCES,
  HANDOFF_UNSAFE_TEXT,
  HandoffError,
  handoffUuidSchema,
  ownHandoffValue,
} from "./handoff-primitives.js";

export const DEFAULT_LEASE_SECONDS = 300;
export const DEFAULT_GRACE_SECONDS = 600;
export const DEFAULT_BRIEF_BYTES = 8 * 1024;
export const MIN_BRIEF_BYTES = 1024;
export const MAX_BRIEF_BYTES = 64 * 1024;
/** Claude Code caps hook context at 10,000 characters; stay below it. */
export const HOOK_CONTEXT_CHARS = 9000;
export const MAX_NOTE_BYTES = 2048;
export const MAX_MESSAGE_BYTES = 1024;
export const MAX_NOTES_PER_SESSION = 64;
export const MAX_SESSIONS_PER_WORKSPACE = 256;
export const MAX_BRIEF_SESSIONS = 24;
export const MAX_BRIEF_NOTES = 24;
export const MAX_OBSERVED_PATHS = 50;
export const MAX_OBSERVED_SUBJECTS = 10;

const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (value) =>
        Buffer.byteLength(value) <= bytes &&
        Buffer.from(value).toString("utf8") === value &&
        !HANDOFF_UNSAFE_TEXT.test(value),
    );
export const handoffAgentLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/u);

export const HANDOFF_NOTE_KINDS = [
  "progress",
  "blocker",
  "decision",
  "next",
  "result",
] as const;
export type HandoffNoteKind = (typeof HANDOFF_NOTE_KINDS)[number];
export const HANDOFF_SESSION_STATES = [
  "active",
  "idle",
  "quiet",
  "interrupted",
  "failed",
  "ended",
] as const;
export type HandoffSessionState = (typeof HANDOFF_SESSION_STATES)[number];
export const HANDOFF_CLIENTS = ["mcp", "claude-code", "codex"] as const;
export type HandoffClient = (typeof HANDOFF_CLIENTS)[number];
export const HANDOFF_END_REASONS = [
  "completed",
  "disconnected",
  "client_ended",
  "subagent_stopped",
] as const;
export type HandoffEndReason = (typeof HANDOFF_END_REASONS)[number];

const briefBytesSchema = z
  .number()
  .int()
  .min(MIN_BRIEF_BYTES)
  .max(MAX_BRIEF_BYTES);

export const handoffSessionsConfigSchema = z.strictObject({
  leaseSeconds: z.number().int().min(30).max(86_400).optional(),
  graceSeconds: z.number().int().min(0).max(86_400).optional(),
  observeGit: z.boolean().optional(),
  captureMessages: z.boolean().optional(),
  projectFile: z.boolean().optional(),
  projectionIntervalSeconds: z.number().int().min(0).max(3600).optional(),
});
export type HandoffSessionsConfig = z.infer<typeof handoffSessionsConfigSchema>;

export const handoffJoinSchema = z.strictObject({
  handoffVersion: z.literal(1),
  agent: handoffAgentLabelSchema,
  kind: z.enum(["agent", "subagent"]).optional(),
  parentSessionId: handoffUuidSchema.optional(),
  task: text(512).min(1).optional(),
  briefBytes: briefBytesSchema.optional(),
});
export const handoffNoteSchema = z.strictObject({
  handoffVersion: z.literal(1),
  sessionId: handoffUuidSchema,
  kind: z.enum(HANDOFF_NOTE_KINDS),
  text: text(MAX_NOTE_BYTES).min(1),
});
export const handoffEndSchema = z.strictObject({
  handoffVersion: z.literal(1),
  sessionId: handoffUuidSchema,
  summary: text(MAX_NOTE_BYTES).min(1).optional(),
});
export type HandoffJoinV1 = z.infer<typeof handoffJoinSchema>;
export type HandoffNoteV1 = z.infer<typeof handoffNoteSchema>;
export type HandoffEndV1 = z.infer<typeof handoffEndSchema>;

const isoSchema = z.string().min(20).max(30);
export const handoffNoteViewSchema = z.strictObject({
  sessionId: handoffUuidSchema,
  kind: z.enum(HANDOFF_NOTE_KINDS),
  text: z.string(),
  createdAt: isoSchema,
});
export const handoffSessionViewSchema = z.strictObject({
  sessionId: handoffUuidSchema,
  agent: z.string(),
  kind: z.enum(["agent", "subagent"]),
  client: z.enum(HANDOFF_CLIENTS),
  parentSessionId: handoffUuidSchema.nullable(),
  task: z.string().nullable(),
  state: z.enum(HANDOFF_SESSION_STATES),
  startedAt: isoSchema,
  lastSeenAt: isoSchema,
  endedAt: isoSchema.nullable(),
  endReason: z.enum(HANDOFF_END_REASONS).nullable(),
  clientReason: z.string().nullable(),
  failure: z.string().nullable(),
  lastNote: handoffNoteViewSchema.omit({ sessionId: true }).nullable(),
  notes: z.number().int().min(0),
  lastMessage: z.string().nullable(),
  /** The worktree it ran in, by name; null outside repository scope. */
  worktree: z.string().nullable(),
  /** Counts of this session's subagents by state; null without any. */
  subagents: z
    .strictObject(
      Object.fromEntries(
        HANDOFF_SESSION_STATES.map((state) => [state, z.number().int().min(0)]),
      ) as Record<HandoffSessionState, z.ZodNumber>,
    )
    .nullable(),
});
export type HandoffNoteView = z.infer<typeof handoffNoteViewSchema>;
export type HandoffSessionView = z.infer<typeof handoffSessionViewSchema>;

export const handoffGitObservationSchema = z.strictObject({
  state: z.enum(["observed", "disabled", "unavailable"]),
  /** The worktree read, by name; null outside repository scope. */
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int().min(0).nullable(),
  behind: z.number().int().min(0).nullable(),
  operation: z
    .enum(["merge", "rebase", "cherry_pick", "revert", "bisect"])
    .nullable(),
  changes: z.strictObject({
    staged: z.number().int().min(0),
    unstaged: z.number().int().min(0),
    untracked: z.number().int().min(0),
    conflicted: z.number().int().min(0),
  }),
  paths: z.array(z.strictObject({ status: z.string(), path: z.string() })),
  omittedPaths: z.number().int().min(0),
  commitsSince: z
    .strictObject({
      base: z.string(),
      count: z.number().int().min(0),
      subjects: z.array(z.string()),
    })
    .nullable(),
});
export type HandoffGitObservation = z.infer<typeof handoffGitObservationSchema>;

export const HANDOFF_DOCUMENT_STATES = [
  /** No document and no revision. */
  "none",
  /** A document exists, but no revision was ever recorded. */
  "untracked",
  "synchronized",
  "pending",
  /** The document differs from the latest revision. */
  "drifted",
  /** The latest revision was projected, and the file is gone. */
  "deleted",
  "unavailable",
] as const;
export type HandoffDocumentState = (typeof HANDOFF_DOCUMENT_STATES)[number];

export const handoffBriefSchema = z.strictObject({
  briefVersion: z.literal(1),
  generatedAt: isoSchema,
  handoff: z.strictObject({
    revision: z.number().int().min(0),
    document: z.enum(HANDOFF_DOCUMENT_STATES),
    /** The worktree holding the document; null outside repository scope. */
    documentWorktree: z.string().nullable(),
    activeAgent: z.string().nullable(),
    updatedAt: isoSchema.nullable(),
    goal: z.string().nullable(),
    nextSteps: z.array(z.string()),
    blockers: z.array(z.string()),
  }),
  sessions: z.array(handoffSessionViewSchema),
  omittedSessions: z.number().int().min(0),
  notes: z.array(handoffNoteViewSchema),
  omittedNotes: z.number().int().min(0),
  git: handoffGitObservationSchema,
  /** Set when anything beyond the counted omissions was removed or cut. */
  truncated: z.boolean(),
  provenance: z.strictObject({
    handoff: z.enum(HANDOFF_PROVENANCES),
    notes: z.literal("caller_asserted"),
    sessions: z.literal("observed"),
    git: z.literal("observed"),
  }),
});
export type HandoffBriefV1 = z.infer<typeof handoffBriefSchema>;

/** One session in full: its newest notes and its subagents. */
export const handoffLaneSchema = z.strictObject({
  session: handoffSessionViewSchema,
  notes: z.array(handoffNoteViewSchema),
  omittedNotes: z.number().int().min(0),
  subagents: z.array(handoffSessionViewSchema),
  omittedSubagents: z.number().int().min(0),
  truncated: z.boolean(),
});
export type HandoffLaneV1 = z.infer<typeof handoffLaneSchema>;
export const HANDOFF_SESSIONS_FILE_STATES = [
  "written",
  "pending",
  "unavailable",
  "disabled",
] as const;
export const MAX_LANE_NOTES = 64;
export const DEFAULT_PROJECTION_INTERVAL_SECONDS = 5;
export const MAX_SESSIONS_FILE_CHARS = 32 * 1024;

export const handoffJoinResultSchema = z.strictObject({
  handoffVersion: z.literal(1),
  sessionId: handoffUuidSchema,
  leaseSeconds: z.number().int().min(1),
  brief: handoffBriefSchema,
});
export const handoffSessionResultSchema = z.strictObject({
  handoffVersion: z.literal(1),
  session: handoffSessionViewSchema,
  redactions: z.number().int().min(0),
  /**
   * On handoff_end only: "expected" when this was the last top-level agent
   * still running, so it should record the shared summary; "skip" otherwise.
   */
  sharedUpdate: z.enum(["expected", "skip"]).optional(),
});

export const HANDOFF_REVISION_FIELDS = [
  "goal",
  "completed",
  "touchedFile",
  "blocker",
  "nextStep",
] as const;
export type HandoffRevisionField = (typeof HANDOFF_REVISION_FIELDS)[number];
export const HANDOFF_SEARCH_KINDS = [
  ...HANDOFF_NOTE_KINDS,
  "task",
  "revision",
] as const;
export type HandoffSearchKind = (typeof HANDOFF_SEARCH_KINDS)[number];
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;
export const DEFAULT_SEARCH_BYTES = 4 * 1024;
export const MIN_SEARCH_BYTES = 1024;
export const MAX_SEARCH_BYTES = 16 * 1024;
export const MAX_SEARCH_QUERY_BYTES = 512;
export const MAX_SEARCH_HIT_BYTES = 512;
export const MAX_SEARCH_CANDIDATES = 8;

export const handoffSearchInputSchema = z.strictObject({
  handoffVersion: z.literal(1),
  /** Free text: words, identifiers, paths or error text. Not FTS syntax. */
  query: text(MAX_SEARCH_QUERY_BYTES).min(1),
  /** The caller's session: its lane and worktree rank first. */
  sessionId: handoffUuidSchema.optional(),
  kinds: z
    .array(z.enum(HANDOFF_SEARCH_KINDS))
    .min(1)
    .max(HANDOFF_SEARCH_KINDS.length)
    .optional(),
  /** A worktree by name, as briefs show it. */
  worktree: text(128).min(1).optional(),
  /** Only hits that mention this path, or a path ending with it. */
  path: text(512).min(1).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  resultBytes: z
    .number()
    .int()
    .min(MIN_SEARCH_BYTES)
    .max(MAX_SEARCH_BYTES)
    .optional(),
});
export type HandoffSearchInputV1 = z.infer<typeof handoffSearchInputSchema>;

export const handoffSearchHitSchema = z.strictObject({
  source: z.enum(["note", "task", "revision"]),
  /** The note kind, or the revision field; null for a task. */
  kind: z.enum([...HANDOFF_NOTE_KINDS, ...HANDOFF_REVISION_FIELDS]).nullable(),
  text: z.string(),
  /** True when text is a window of a longer original. */
  cut: z.boolean(),
  createdAt: isoSchema,
  sessionId: handoffUuidSchema.nullable(),
  agent: z.string().nullable(),
  sessionKind: z.enum(["agent", "subagent"]).nullable(),
  sessionState: z.enum(HANDOFF_SESSION_STATES).nullable(),
  worktree: z.string().nullable(),
  revision: z.number().int().min(1).nullable(),
  /** Path-like words in the full text. */
  paths: z.array(z.string()),
});
export type HandoffSearchHit = z.infer<typeof handoffSearchHitSchema>;
export const handoffSearchCandidateSchema = z.strictObject({
  path: z.string(),
  worktree: z.string().nullable(),
  hits: z.number().int().min(1),
  lastSeenAt: isoSchema,
});
export const handoffSearchResultSchema = z.strictObject({
  handoffVersion: z.literal(1),
  hits: z.array(handoffSearchHitSchema),
  /** Hits left out by limit or resultBytes, among the 200 best matches. */
  omittedHits: z.number().int().min(0),
  /**
   * Set when a file named in the query matches more than one path or
   * worktree in the hits: ask again with path or worktree.
   */
  ambiguous: z
    .strictObject({
      term: z.string(),
      candidates: z.array(handoffSearchCandidateSchema),
      omittedCandidates: z.number().int().min(0),
    })
    .nullable(),
  /** Set when anything beyond the counted omissions was removed. */
  truncated: z.boolean(),
  provenance: z.literal("caller_asserted"),
});
export type HandoffSearchResultV1 = z.infer<typeof handoffSearchResultSchema>;

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(ownHandoffValue(value));
  if (!parsed.success) throw new HandoffError("invalid_input");
  return parsed.data;
}
export const parseHandoffJoin = (value: unknown): HandoffJoinV1 =>
  parseWith(handoffJoinSchema, value);
export const parseHandoffNote = (value: unknown): HandoffNoteV1 =>
  parseWith(handoffNoteSchema, value);
export const parseHandoffEnd = (value: unknown): HandoffEndV1 =>
  parseWith(handoffEndSchema, value);
export function parseHandoffSearch(value: unknown): HandoffSearchInputV1 {
  const input = parseWith(handoffSearchInputSchema, value);
  if (
    input.kinds !== undefined &&
    new Set(input.kinds).size !== input.kinds.length
  )
    throw new HandoffError("invalid_input");
  return input;
}

/** Make observed text printable: replace unsafe characters, bound bytes. */
export function printableText(value: string, maxBytes: number): string {
  const safe = value.replace(new RegExp(HANDOFF_UNSAFE_TEXT.source, "gu"), "�");
  return truncateBytes(safe, maxBytes);
}
export function truncateBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes - 3);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}...`;
}
