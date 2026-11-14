import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { HandoffError } from "./handoff-primitives.js";
import { redactHandoffText } from "./handoff-redact.js";
import {
  HANDOFF_RECORDED_KINDS,
  printableText,
  truncateBytes,
} from "./handoff-session-contract.js";

export const MAX_REQUEST_BYTES = 4096;
export const MAX_REPLY_BYTES = 512;
export const MAX_COMMAND_BYTES = 1024;
export const MAX_TAIL_BYTES = 1024;
export const MAX_ERROR_BYTES = 512;
/** Read per transcript per hook; the rest is read by later hooks. */
export const MAX_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
// Redaction runs on bounded input, like notes.
const MAX_REDACTED_INPUT_BYTES = 16 * 1024;
// Fixed per-event cost counted against the cap, beside the stored text.
const EVENT_OVERHEAD_BYTES = 64;

export const HANDOFF_EVENT_KINDS = HANDOFF_RECORDED_KINDS;
export type HandoffEventKind = (typeof HANDOFF_EVENT_KINDS)[number];
export type HandoffEventStatus = "pending" | "ok" | "failed" | "interrupted";

/**
 * Events read from client transcripts, and where each transcript was read
 * up to. Additive; created with the handoff schema whether or not capture
 * is enabled, and checked for shape only, like the session tables.
 */
export const HANDOFF_RECORDER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS handoff_events (
    event_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES handoff_sessions(session_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 32),
    source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
    tool_use_id TEXT CHECK(tool_use_id IS NULL OR length(tool_use_id) BETWEEN 1 AND 128),
    text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= ${String(MAX_REQUEST_BYTES)}),
    path TEXT CHECK(path IS NULL OR length(CAST(path AS BLOB)) <= 1024),
    blob TEXT CHECK(blob IS NULL OR length(blob) IN (40, 64)),
    status TEXT CHECK(status IS NULL OR length(status) BETWEEN 1 AND 16),
    exit_code INTEGER,
    tail TEXT CHECK(tail IS NULL OR length(CAST(tail AS BLOB)) <= ${String(MAX_TAIL_BYTES)}),
    redactions INTEGER NOT NULL CHECK(redactions >= 0),
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, source_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS handoff_events_session ON handoff_events(session_id, event_id);
  CREATE INDEX IF NOT EXISTS handoff_events_tool ON handoff_events(session_id, tool_use_id)
    WHERE tool_use_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS handoff_transcripts (
    session_id TEXT NOT NULL REFERENCES handoff_sessions(session_id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
    identity TEXT NOT NULL CHECK(length(identity) BETWEEN 1 AND 128),
    read_offset INTEGER NOT NULL CHECK(read_offset >= 0),
    read_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, path)
  ) STRICT;
`;

export interface ExtractedEvent {
  sourceId: string;
  kind: HandoffEventKind;
  toolUseId: string | null;
  text: string;
  /** For an edit: the path inside the session's root. */
  path: string | null;
  redactions: number;
  createdAt: number;
}
export interface ExtractedResult {
  toolUseId: string;
  status: Exclude<HandoffEventStatus, "pending">;
  exitCode: number | null;
  tail: string | null;
  redactions: number;
}

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);
// Client wrappers around text the user did not type: task notifications,
// local command output, reminders. A typed message rarely starts with a tag.
const WRAPPER = /^\s*<[a-z][a-z0-9-]*>/u;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

function redact(value: string, maxBytes: number) {
  const result = redactHandoffText(
    truncateBytes(value, MAX_REDACTED_INPUT_BYTES),
  );
  return {
    text: printableText(result.text, maxBytes),
    redactions: result.redactions,
  };
}
/** The last `maxBytes` of a text, after redacting the end of it. */
function redactTail(value: string, maxBytes: number) {
  const bytes = Buffer.from(value);
  let start = Math.max(0, bytes.length - MAX_REDACTED_INPUT_BYTES);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  const result = redactHandoffText(bytes.subarray(start).toString("utf8"));
  const safe = printableText(result.text, Number.MAX_SAFE_INTEGER);
  const out = Buffer.from(safe);
  // A cut tail starts with "...", within the same bound.
  let from = out.length <= maxBytes ? 0 : out.length - (maxBytes - 3);
  while (from < out.length && ((out[from] ?? 0) & 0xc0) === 0x80) from++;
  return {
    text: (from > 0 ? "..." : "") + out.subarray(from).toString("utf8"),
    redactions: result.redactions,
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const blocks = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content)
    ? content.flatMap((block) => {
        const value = record(block);
        return value === undefined ? [] : [value];
      })
    : [];
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** A path inside `root`, with forward slashes; undefined outside it. */
export function pathInside(root: string, path: string): string | undefined {
  if (!isAbsolute(path)) path = join(root, path);
  const inside = relative(root, path);
  if (
    inside === "" ||
    isAbsolute(inside) ||
    inside === ".." ||
    inside.startsWith(`..${sep}`)
  )
    return undefined;
  return inside.split(sep).join("/");
}

/**
 * Structured events from transcript lines. Pure: unknown or malformed
 * records are skipped, and nothing but the listed kinds is kept. With
 * `sidechain` false (a main transcript), subagent records are skipped,
 * since a subagent's own transcript records them.
 */
export function extractTranscript(
  lines: readonly string[],
  options: { root: string; now: number; sidechain: boolean },
): { events: ExtractedEvent[]; results: ExtractedResult[] } {
  const events: ExtractedEvent[] = [];
  const results: ExtractedResult[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = record(parsed);
    if (entry === undefined) continue;
    const { type, uuid } = entry;
    if ((type !== "user" && type !== "assistant") || typeof uuid !== "string")
      continue;
    if (!ID.test(uuid) || (entry.isSidechain === true) !== options.sidechain)
      continue;
    const time = Date.parse(
      typeof entry.timestamp === "string" ? entry.timestamp : "",
    );
    const createdAt = Number.isFinite(time) ? time : options.now;
    const content = record(entry.message)?.content;
    const add = (
      index: number,
      kind: HandoffEventKind,
      value: { text: string; redactions: number },
      extra: { toolUseId?: string; path?: string } = {},
    ) => {
      if (value.text.trim() === "") return;
      events.push({
        sourceId: `${uuid}:${String(index)}`,
        kind,
        toolUseId: extra.toolUseId ?? null,
        text: value.text,
        path: extra.path ?? null,
        redactions: value.redactions,
        createdAt,
      });
    };
    if (type === "user") {
      if (
        entry.isMeta === true ||
        entry.isCompactSummary === true ||
        entry.isVisibleInTranscriptOnly === true
      )
        continue;
      const results_ = blocks(content).filter(
        (block) => block.type === "tool_result",
      );
      if (results_.length === 0) {
        const text = blockText(content);
        if (!WRAPPER.test(text))
          add(0, "request", redact(text, MAX_REQUEST_BYTES));
        continue;
      }
      const toolResult = record(entry.toolUseResult);
      for (const block of results_) {
        const toolUseId = block.tool_use_id;
        if (typeof toolUseId !== "string" || !ID.test(toolUseId)) continue;
        const output = blockText(block.content);
        const status =
          toolResult?.interrupted === true
            ? "interrupted"
            : block.is_error === true
              ? "failed"
              : "ok";
        const code = /^Exit code (\d{1,3})\b/u.exec(output);
        const tail =
          status === "ok" ? undefined : redactTail(output, MAX_TAIL_BYTES);
        results.push({
          toolUseId,
          status,
          exitCode: code === null ? null : Number(code[1]),
          tail: tail === undefined || tail.text === "" ? null : tail.text,
          redactions: tail?.redactions ?? 0,
        });
      }
      continue;
    }
    if (entry.isApiErrorMessage === true) {
      const error = typeof entry.error === "string" ? `[${entry.error}] ` : "";
      add(0, "api_error", redact(error + blockText(content), MAX_ERROR_BYTES));
      continue;
    }
    blocks(content).forEach((block, index) => {
      if (block.type === "text" && typeof block.text === "string")
        add(index, "reply", redact(block.text, MAX_REPLY_BYTES));
      if (block.type !== "tool_use" || typeof block.name !== "string") return;
      const toolUseId =
        typeof block.id === "string" && ID.test(block.id)
          ? block.id
          : undefined;
      if (toolUseId === undefined) return;
      const input = record(block.input) ?? {};
      if (block.name === "Bash" && typeof input.command === "string")
        add(index, "command", redact(input.command, MAX_COMMAND_BYTES), {
          toolUseId,
        });
      if (EDIT_TOOLS.has(block.name)) {
        const target = input.file_path ?? input.notebook_path;
        if (typeof target !== "string" || target.length > 4096) return;
        const inside = pathInside(options.root, target);
        if (inside === undefined) return;
        const path = redact(inside, 1024);
        // A path that needed redaction is not a path to rely on.
        if (path.redactions > 0 || path.text !== inside) return;
        add(index, "edit", path, { toolUseId, path: path.text });
      }
    });
  }
  return { events, results };
}

export interface TranscriptRead {
  lines: string[];
  identity: string;
  offset: number;
  /** Bytes left unread after this read. */
  remaining: number;
}

/**
 * Read a transcript from where the last read stopped, complete lines only.
 * The path must be an absolute `.jsonl` regular file, not a symlink, owned
 * by this user. Another file at the path, or a shorter one, is read from
 * the start. Undefined when the path is refused or unreadable.
 */
export function readTranscript(
  path: string,
  cursor: { identity: string; offset: number } | undefined,
  maxBytes = MAX_TRANSCRIPT_READ_BYTES,
): TranscriptRead | undefined {
  if (!isAbsolute(path) || !path.endsWith(".jsonl") || path.includes("\0"))
    return undefined;
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) return undefined;
    // Windows has no O_NOFOLLOW; the lstat above is the check there.
    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return undefined;
    if (process.platform !== "win32" && stats.uid !== process.getuid?.())
      return undefined;
    const identity = `${String(stats.dev)}:${String(stats.ino)}`;
    let offset =
      cursor?.identity === identity && cursor.offset <= stats.size
        ? cursor.offset
        : 0;
    const available = stats.size - offset;
    const buffer = Buffer.alloc(Math.min(available, maxBytes));
    const read =
      buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, offset);
    const window = buffer.subarray(0, read);
    const end = window.lastIndexOf(0x0a);
    if (end >= 0) {
      offset += end + 1;
      return {
        lines: window.subarray(0, end).toString("utf8").split("\n"),
        identity,
        offset,
        remaining: stats.size - offset,
      };
    }
    // No complete line: one still being written, or one longer than a
    // whole read, which is skipped to its end.
    if (available <= maxBytes)
      return { lines: [], identity, offset, remaining: available };
    const chunk = Buffer.alloc(1024 * 1024);
    let position = offset + read;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0)
        return { lines: [], identity, offset, remaining: available };
      const newline = chunk.subarray(0, count).indexOf(0x0a);
      if (newline >= 0) {
        offset = position + newline + 1;
        return { lines: [], identity, offset, remaining: stats.size - offset };
      }
      position += count;
    }
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The Git blob ID of a file's bytes as they are on disk, with no Git
 * filters applied; null for a missing, special or large file.
 */
export function blobId(path: string, format: "sha1" | "sha256"): string | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > MAX_HASHED_FILE_BYTES) return null;
    const bytes = readFileSync(path);
    return createHash(format)
      .update(`blob ${String(bytes.length)}\0`)
      .update(bytes)
      .digest("hex");
  } catch {
    return null;
  }
}

export interface RecordedEventRow {
  sessionId: string;
  kind: HandoffEventKind;
  text: string;
  path: string | null;
  blob: string | null;
  status: HandoffEventStatus | null;
  exitCode: number | null;
  tail: string | null;
  createdAt: number;
}

const KINDS: ReadonlySet<string> = new Set(HANDOFF_EVENT_KINDS);
const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "ok",
  "failed",
  "interrupted",
]);
function eventRow(row: Record<string, unknown>): RecordedEventRow | undefined {
  if (
    typeof row.session_id !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.text !== "string" ||
    (row.path !== null && typeof row.path !== "string") ||
    (row.blob !== null && typeof row.blob !== "string") ||
    (row.status !== null && typeof row.status !== "string") ||
    (row.exit_code !== null && typeof row.exit_code !== "number") ||
    (row.tail !== null && typeof row.tail !== "string") ||
    typeof row.created_at !== "number"
  )
    throw new HandoffError("unavailable");
  // A kind or status a later version added is skipped, not fatal.
  if (
    !KINDS.has(row.kind) ||
    (row.status !== null && !STATUSES.has(row.status))
  )
    return undefined;
  return {
    sessionId: row.session_id,
    kind: row.kind as HandoffEventKind,
    text: row.text,
    path: row.path,
    blob: row.blob,
    status: row.status as HandoffEventStatus | null,
    exitCode: row.exit_code,
    tail: row.tail,
    createdAt: row.created_at,
  };
}
const EVENT_COLUMNS =
  "e.session_id, e.kind, e.text, e.path, e.blob, e.status, e.exit_code, e.tail, e.created_at";

/** Storage for recorded events, on the verified handoff connection. */
export class HandoffRecorder {
  constructor(
    private readonly database: DatabaseSync,
    private readonly verify: () => void,
  ) {}

  #transaction<T>(operation: () => T): T {
    this.verify();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.verify();
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back.
      }
      throw error;
    }
  }

  cursor(
    sessionId: string,
    path: string,
  ): { identity: string; offset: number } | undefined {
    this.verify();
    const row = this.database
      .prepare(
        "SELECT identity, read_offset FROM handoff_transcripts WHERE session_id = ? AND path = ?",
      )
      .get(sessionId, path);
    if (row === undefined) return undefined;
    if (typeof row.identity !== "string" || typeof row.read_offset !== "number")
      throw new HandoffError("unavailable");
    return { identity: row.identity, offset: row.read_offset };
  }

  /** Every transcript this workspace's sessions were read from. */
  transcripts(workspaceId: string): { sessionId: string; path: string }[] {
    this.verify();
    return this.database
      .prepare(
        `SELECT t.session_id, t.path FROM handoff_transcripts t
          JOIN handoff_sessions s ON s.session_id = t.session_id
          WHERE s.workspace_id = ? ORDER BY t.read_at DESC`,
      )
      .all(workspaceId)
      .map((row) => {
        if (typeof row.session_id !== "string" || typeof row.path !== "string")
          throw new HandoffError("unavailable");
        return { sessionId: row.session_id, path: row.path };
      });
  }

  /** Paths of edits still waiting for their tool result. */
  pendingEditPaths(sessionId: string): string[] {
    this.verify();
    return this.database
      .prepare(
        "SELECT DISTINCT path FROM handoff_events WHERE session_id = ? AND kind = 'edit' AND status = 'pending' AND path IS NOT NULL",
      )
      .all(sessionId)
      .flatMap((row) => (typeof row.path === "string" ? [row.path] : []));
  }

  /**
   * Store what one read extracted and where the read stopped, in one
   * transaction, then keep the workspace within `capBytes`.
   */
  record(
    workspaceId: string,
    sessionId: string,
    path: string,
    read: { identity: string; offset: number },
    extracted: {
      events: readonly ExtractedEvent[];
      results: readonly ExtractedResult[];
    },
    blobs: ReadonlyMap<string, string | null>,
    now: number,
    capBytes: number,
  ): { inserted: number; resolved: number } {
    return this.#transaction(() => {
      const owner = this.database
        .prepare(
          "SELECT 1 AS found FROM handoff_sessions WHERE session_id = ? AND workspace_id = ?",
        )
        .get(sessionId, workspaceId);
      if (owner === undefined) throw new HandoffError("unknown_session");
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO handoff_events(session_id, kind, source_id, tool_use_id, text, path,
          blob, status, exit_code, tail, redactions, bytes, created_at)
          VALUES(?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
      );
      let inserted = 0;
      for (const event of extracted.events) {
        const tracked = event.kind === "command" || event.kind === "edit";
        const changes = insert.run(
          sessionId,
          event.kind,
          event.sourceId,
          event.toolUseId,
          event.text,
          event.path,
          tracked ? "pending" : null,
          event.redactions,
          Buffer.byteLength(event.text) + EVENT_OVERHEAD_BYTES,
          event.createdAt,
        ).changes;
        inserted += Number(changes);
      }
      let resolved = 0;
      const find = this.database.prepare(
        "SELECT event_id, kind, path FROM handoff_events WHERE session_id = ? AND tool_use_id = ? AND status = 'pending'",
      );
      const update = this.database.prepare(
        `UPDATE handoff_events SET status = ?, exit_code = ?, tail = ?, blob = ?,
          redactions = redactions + ?, bytes = bytes + ? WHERE event_id = ?`,
      );
      for (const result of extracted.results)
        for (const row of find.all(sessionId, result.toolUseId)) {
          if (typeof row.event_id !== "number" || typeof row.kind !== "string")
            throw new HandoffError("unavailable");
          const command = row.kind === "command";
          const tail = command ? result.tail : null;
          update.run(
            result.status,
            command
              ? (result.exitCode ?? (result.status === "ok" ? 0 : null))
              : null,
            tail,
            row.kind === "edit" &&
              result.status === "ok" &&
              typeof row.path === "string"
              ? (blobs.get(row.path) ?? null)
              : null,
            command ? result.redactions : 0,
            tail === null ? 0 : Buffer.byteLength(tail),
            row.event_id,
          );
          resolved++;
        }
      this.database
        .prepare(
          `INSERT INTO handoff_transcripts(session_id, path, identity, read_offset, read_at)
            VALUES(?, ?, ?, ?, ?) ON CONFLICT(session_id, path) DO UPDATE SET
            -- Two readers of one file may commit out of order; never go back.
            read_offset = CASE WHEN identity = excluded.identity
              THEN max(read_offset, excluded.read_offset) ELSE excluded.read_offset END,
            identity = excluded.identity, read_at = excluded.read_at`,
        )
        .run(sessionId, path, read.identity, read.offset, now);
      this.#retain(workspaceId, capBytes);
      return { inserted, resolved };
    });
  }

  #total(workspaceId: string): number {
    const row = this.database
      .prepare(
        `SELECT coalesce(sum(e.bytes), 0) AS total FROM handoff_events e
          JOIN handoff_sessions s ON s.session_id = e.session_id WHERE s.workspace_id = ?`,
      )
      .get(workspaceId);
    if (typeof row?.total !== "number") throw new HandoffError("unavailable");
    return row.total;
  }

  // Oldest first within each class: failure tails, then replies, then
  // commands, edits and errors, and user requests last.
  #retain(workspaceId: string, capBytes: number): void {
    const scope = `e.session_id IN (SELECT session_id FROM handoff_sessions WHERE workspace_id = ?)`;
    const steps = [
      `UPDATE handoff_events SET bytes = bytes - length(CAST(tail AS BLOB)), tail = NULL
        WHERE event_id IN (SELECT e.event_id FROM handoff_events e WHERE ${scope}
        AND e.tail IS NOT NULL ORDER BY e.event_id LIMIT 64)`,
      `DELETE FROM handoff_events WHERE event_id IN (SELECT e.event_id FROM handoff_events e
        WHERE ${scope} AND e.kind = 'reply' ORDER BY e.event_id LIMIT 64)`,
      `DELETE FROM handoff_events WHERE event_id IN (SELECT e.event_id FROM handoff_events e
        WHERE ${scope} AND e.kind NOT IN ('reply', 'request') ORDER BY e.event_id LIMIT 64)`,
      `DELETE FROM handoff_events WHERE event_id IN (SELECT e.event_id FROM handoff_events e
        WHERE ${scope} ORDER BY e.event_id LIMIT 64)`,
    ];
    let step = 0;
    while (step < steps.length && this.#total(workspaceId) > capBytes) {
      const changes = Number(
        this.database.prepare(steps[step] ?? "").run(workspaceId).changes,
      );
      if (changes === 0) step++;
    }
  }

  /** Newest first, optionally only some kinds and statuses. */
  events(
    workspaceId: string,
    limit: number,
    kinds: readonly HandoffEventKind[] = HANDOFF_EVENT_KINDS,
    status?: HandoffEventStatus,
  ): RecordedEventRow[] {
    this.verify();
    return this.database
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM handoff_events e
          JOIN handoff_sessions s ON s.session_id = e.session_id
          WHERE s.workspace_id = ? AND e.kind IN (${kinds.map(() => "?").join(", ")})
          ${status === undefined ? "" : "AND e.status = ?"}
          ORDER BY e.created_at DESC, e.event_id DESC LIMIT ?`,
      )
      .all(
        workspaceId,
        ...kinds,
        ...(status === undefined ? [] : [status]),
        limit,
      )
      .flatMap((row) => {
        const parsed = eventRow(row);
        return parsed === undefined ? [] : [parsed];
      });
  }
}
