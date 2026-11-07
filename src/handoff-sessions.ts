import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { HandoffError } from "./handoff-primitives.js";
import {
  HANDOFF_CLIENTS,
  HANDOFF_END_REASONS,
  HANDOFF_NOTE_KINDS,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_BYTES,
  MAX_NOTES_PER_SESSION,
  MAX_SESSIONS_PER_WORKSPACE,
  type HandoffClient,
  type HandoffEndReason,
  type HandoffNoteKind,
} from "./handoff-session-contract.js";

/**
 * Additive tables, created with the handoff schema. Enumerated columns are
 * checked for shape only and validated on read, so a later version can add
 * a client, end reason or note kind without rebuilding a STRICT table.
 */
export const HANDOFF_SESSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS handoff_sessions (
    session_id TEXT PRIMARY KEY CHECK(length(session_id) = 36),
    workspace_id TEXT NOT NULL,
    client TEXT NOT NULL CHECK(length(client) BETWEEN 1 AND 32),
    client_session TEXT NOT NULL CHECK(length(client_session) <= 128),
    client_agent TEXT NOT NULL CHECK(length(client_agent) <= 128),
    agent TEXT NOT NULL CHECK(length(agent) BETWEEN 1 AND 64),
    kind TEXT NOT NULL CHECK(kind IN ('agent', 'subagent')),
    parent_session_id TEXT REFERENCES handoff_sessions(session_id) ON DELETE SET NULL,
    task TEXT CHECK(task IS NULL OR length(CAST(task AS BLOB)) <= 512),
    started_at INTEGER NOT NULL,
    start_head TEXT CHECK(start_head IS NULL OR length(start_head) IN (40, 64)),
    last_seen_at INTEGER NOT NULL,
    turn_open INTEGER CHECK(turn_open IS NULL OR turn_open IN (0, 1)),
    failure TEXT CHECK(failure IS NULL OR length(failure) <= 64),
    ended_at INTEGER,
    end_reason TEXT CHECK(end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    client_reason TEXT CHECK(client_reason IS NULL OR length(client_reason) <= 64),
    last_message TEXT CHECK(last_message IS NULL OR length(CAST(last_message AS BLOB)) <= ${String(MAX_MESSAGE_BYTES)}),
    note_count INTEGER NOT NULL DEFAULT 0,
    CHECK((ended_at IS NULL) = (end_reason IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS handoff_sessions_client
    ON handoff_sessions(workspace_id, client, client_session, client_agent)
    WHERE client_session != '';
  CREATE INDEX IF NOT EXISTS handoff_sessions_seen
    ON handoff_sessions(workspace_id, last_seen_at);
  CREATE TABLE IF NOT EXISTS handoff_notes (
    note_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES handoff_sessions(session_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 32),
    text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND ${String(MAX_NOTE_BYTES)}),
    redactions INTEGER NOT NULL CHECK(redactions >= 0),
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS handoff_notes_session ON handoff_notes(session_id, note_id);
`;

export interface HandoffSessionRow {
  sessionId: string;
  client: HandoffClient;
  clientSession: string;
  clientAgent: string;
  agent: string;
  kind: "agent" | "subagent";
  parentSessionId: string | null;
  task: string | null;
  startedAt: number;
  startHead: string | null;
  lastSeenAt: number;
  turnOpen: boolean | null;
  failure: string | null;
  endedAt: number | null;
  endReason: HandoffEndReason | null;
  clientReason: string | null;
  lastMessage: string | null;
  noteCount: number;
}
export interface HandoffNoteRow {
  sessionId: string;
  kind: HandoffNoteKind;
  text: string;
  createdAt: number;
}
export interface HandoffSessionStart {
  client: HandoffClient;
  /** Client-assigned identifiers; empty for sessions joined over MCP. */
  clientSession: string;
  clientAgent: string;
  agent: string;
  kind: "agent" | "subagent";
  parentSessionId: string | null;
  task: string | null;
  startHead: string | null;
  now: number;
}

/**
 * A value this version does not know, such as a client a later version
 * added. Listings skip such rows rather than fail the whole brief.
 */
class NewerValueError extends HandoffError {
  constructor() {
    super("unavailable");
  }
}

function noteKind(value: string): HandoffNoteKind {
  if (!(HANDOFF_NOTE_KINDS as readonly string[]).includes(value))
    throw new NewerValueError();
  return value as HandoffNoteKind;
}

/** Rows a later version wrote with values unknown here are skipped. */
function known<T>(parse: () => T): T[] {
  try {
    return [parse()];
  } catch (error) {
    if (error instanceof NewerValueError) return [];
    throw error;
  }
}

const SESSION_COLUMNS = `session_id, client, client_session, client_agent, agent, kind,
  parent_session_id, task, started_at, start_head, last_seen_at, turn_open, failure,
  ended_at, end_reason, client_reason, last_message, note_count`;

function sessionRow(row: Record<string, unknown>): HandoffSessionRow {
  const string = (key: string) => {
    const value = row[key];
    if (typeof value !== "string") throw new HandoffError("unavailable");
    return value;
  };
  const optional = (key: string) => {
    const value = row[key];
    if (value === null) return null;
    if (typeof value !== "string") throw new HandoffError("unavailable");
    return value;
  };
  const integer = (key: string) => {
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new HandoffError("unavailable");
    return value;
  };
  const member = <T extends string>(
    key: string,
    values: readonly T[],
  ): T | null => {
    const value = optional(key);
    if (value !== null && !(values as readonly string[]).includes(value))
      throw new NewerValueError();
    return value as T | null;
  };
  const turn = row.turn_open;
  const ended = row.ended_at;
  const kind = string("kind");
  if (kind !== "agent" && kind !== "subagent") throw new NewerValueError();
  const client = member("client", HANDOFF_CLIENTS);
  if (client === null) throw new HandoffError("unavailable");
  return {
    sessionId: string("session_id"),
    client,
    clientSession: string("client_session"),
    clientAgent: string("client_agent"),
    agent: string("agent"),
    kind,
    parentSessionId: optional("parent_session_id"),
    task: optional("task"),
    startedAt: integer("started_at"),
    startHead: optional("start_head"),
    lastSeenAt: integer("last_seen_at"),
    turnOpen: turn === null ? null : turn === 1,
    failure: optional("failure"),
    endedAt: ended === null ? null : integer("ended_at"),
    endReason: member("end_reason", HANDOFF_END_REASONS),
    clientReason: optional("client_reason"),
    lastMessage: optional("last_message"),
    noteCount: integer("note_count"),
  };
}

/**
 * Session lifecycle and per-session notes for one handoff database. Every
 * write is one short IMMEDIATE transaction that appends or updates rows for
 * a single session, so concurrent agents never conflict on a shared
 * revision the way whole-document updates do.
 */
export class HandoffSessionLedger {
  constructor(
    readonly database: DatabaseSync,
    readonly verify: () => void,
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

  #get(workspaceId: string, sessionId: string): HandoffSessionRow {
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM handoff_sessions WHERE session_id = ? AND workspace_id = ?`,
      )
      .get(sessionId, workspaceId);
    if (row === undefined) throw new HandoffError("unknown_session");
    return sessionRow(row);
  }

  get(workspaceId: string, sessionId: string): HandoffSessionRow {
    this.verify();
    return this.#get(workspaceId, sessionId);
  }

  /** Start a session, or revive the one a client already registered. */
  start(
    workspaceId: string,
    input: HandoffSessionStart,
  ): { session: HandoffSessionRow; created: boolean } {
    return this.#transaction(() => {
      if (input.parentSessionId !== null)
        this.#get(workspaceId, input.parentSessionId);
      if (input.clientSession !== "") {
        const existing = this.database
          .prepare(
            `SELECT session_id FROM handoff_sessions WHERE workspace_id = ? AND client = ? AND client_session = ? AND client_agent = ?`,
          )
          .get(
            workspaceId,
            input.client,
            input.clientSession,
            input.clientAgent,
          );
        if (typeof existing?.session_id === "string") {
          // A resumed client session continues; it is no longer ended,
          // failed or waiting.
          this.database
            .prepare(
              `UPDATE handoff_sessions SET last_seen_at = max(last_seen_at, ?), turn_open = NULL,
                failure = NULL, ended_at = NULL, end_reason = NULL, client_reason = NULL
                WHERE session_id = ?`,
            )
            .run(input.now, existing.session_id);
          return {
            session: this.#get(workspaceId, existing.session_id),
            created: false,
          };
        }
      }
      this.#prune(workspaceId, input.now, input.parentSessionId);
      const sessionId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO handoff_sessions(session_id, workspace_id, client, client_session, client_agent,
            agent, kind, parent_session_id, task, started_at, start_head, last_seen_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          workspaceId,
          input.client,
          input.clientSession,
          input.clientAgent,
          input.agent,
          input.kind,
          input.parentSessionId,
          input.task,
          input.now,
          input.startHead,
          input.now,
        );
      return { session: this.#get(workspaceId, sessionId), created: true };
    });
  }

  // Keep the newest sessions. Ended sessions without a reported failure go
  // first, then the longest silent ones. A session seen within the last
  // minute, and the parent of the session being started, are never pruned.
  #prune(workspaceId: string, now: number, keep: string | null): void {
    const count = this.database
      .prepare(
        "SELECT count(*) AS n FROM handoff_sessions WHERE workspace_id = ?",
      )
      .get(workspaceId);
    const excess =
      (typeof count?.n === "number" ? count.n : 0) -
      (MAX_SESSIONS_PER_WORKSPACE - 1);
    if (excess <= 0) return;
    this.database
      .prepare(
        `DELETE FROM handoff_sessions WHERE session_id IN (
          SELECT session_id FROM handoff_sessions
          WHERE workspace_id = ? AND last_seen_at < ? AND session_id != ?
          ORDER BY ended_at IS NULL OR failure IS NOT NULL, last_seen_at LIMIT ?)`,
      )
      .run(workspaceId, now - 60_000, keep ?? "", excess);
  }

  /** Record activity; `turnOpen` is known only from client hooks. */
  touch(
    workspaceId: string,
    sessionId: string,
    now: number,
    turnOpen?: boolean,
    lastMessage?: string,
  ): HandoffSessionRow {
    return this.#transaction(() => {
      const session = this.#get(workspaceId, sessionId);
      if (session.endedAt !== null) throw new HandoffError("session_ended");
      this.database
        .prepare(
          `UPDATE handoff_sessions SET last_seen_at = max(last_seen_at, ?),
            failure = CASE WHEN ? = 1 THEN NULL ELSE failure END,
            turn_open = CASE WHEN ? IS NULL THEN turn_open ELSE ? END,
            last_message = coalesce(?, last_message) WHERE session_id = ?`,
        )
        .run(
          now,
          // Only a new turn clears a reported failure; activity such as
          // compaction or a finished turn does not.
          turnOpen === true ? 1 : 0,
          turnOpen === undefined ? null : 1,
          turnOpen === undefined ? null : turnOpen ? 1 : 0,
          lastMessage ?? null,
          sessionId,
        );
      return this.#get(workspaceId, sessionId);
    });
  }

  /** A client reported that its turn stopped on an error, such as a rate limit. */
  fail(
    workspaceId: string,
    sessionId: string,
    failure: string,
    now: number,
  ): HandoffSessionRow {
    return this.#transaction(() => {
      this.#get(workspaceId, sessionId);
      this.database
        .prepare(
          `UPDATE handoff_sessions SET failure = ?, turn_open = 0,
            last_seen_at = max(last_seen_at, ?) WHERE session_id = ?`,
        )
        .run(failure, now, sessionId);
      return this.#get(workspaceId, sessionId);
    });
  }

  note(
    workspaceId: string,
    sessionId: string,
    kind: HandoffNoteKind,
    text: string,
    redactions: number,
    now: number,
  ): HandoffSessionRow {
    return this.#transaction(() => {
      const session = this.#get(workspaceId, sessionId);
      if (session.endedAt !== null) throw new HandoffError("session_ended");
      this.#insertNote(sessionId, kind, text, redactions, now);
      this.database
        .prepare(
          `UPDATE handoff_sessions SET last_seen_at = max(last_seen_at, ?), failure = NULL
            WHERE session_id = ?`,
        )
        .run(now, sessionId);
      return this.#get(workspaceId, sessionId);
    });
  }

  #insertNote(
    sessionId: string,
    kind: HandoffNoteKind,
    text: string,
    redactions: number,
    now: number,
  ): void {
    this.database
      .prepare(
        "INSERT INTO handoff_notes(session_id, kind, text, redactions, created_at) VALUES(?, ?, ?, ?, ?)",
      )
      .run(sessionId, kind, text, redactions, now);
    // Bound each lane: drop the oldest notes past the cap. The count keeps
    // the total so a reader knows notes were dropped.
    this.database
      .prepare(
        `DELETE FROM handoff_notes WHERE session_id = ? AND note_id NOT IN (
          SELECT note_id FROM handoff_notes WHERE session_id = ? ORDER BY note_id DESC LIMIT ?)`,
      )
      .run(sessionId, sessionId, MAX_NOTES_PER_SESSION);
    this.database
      .prepare(
        "UPDATE handoff_sessions SET note_count = note_count + 1 WHERE session_id = ?",
      )
      .run(sessionId);
  }

  end(
    workspaceId: string,
    sessionId: string,
    reason: HandoffEndReason,
    now: number,
    options: {
      clientReason?: string;
      result?: { text: string; redactions: number };
      lastMessage?: string;
    } = {},
  ): HandoffSessionRow {
    return this.#transaction(() => {
      const session = this.#get(workspaceId, sessionId);
      if (session.endedAt !== null) {
        // Client hooks may report an end twice; an explicit end may not.
        if (reason === "completed") throw new HandoffError("session_ended");
        return session;
      }
      if (options.result !== undefined)
        this.#insertNote(
          sessionId,
          "result",
          options.result.text,
          options.result.redactions,
          now,
        );
      this.database
        .prepare(
          `UPDATE handoff_sessions SET ended_at = ?, end_reason = ?, client_reason = ?, turn_open = 0,
            last_seen_at = max(last_seen_at, ?), last_message = coalesce(?, last_message)
            WHERE session_id = ?`,
        )
        .run(
          now,
          reason,
          options.clientReason ?? null,
          now,
          options.lastMessage ?? null,
          sessionId,
        );
      return this.#get(workspaceId, sessionId);
    });
  }

  /** End sessions a closing connection owned and did not end itself. */
  disconnect(workspaceId: string, sessionIds: readonly string[], now: number) {
    if (sessionIds.length === 0) return;
    this.#transaction(() => {
      const update = this.database.prepare(
        `UPDATE handoff_sessions SET ended_at = ?, end_reason = 'disconnected', turn_open = 0
          WHERE session_id = ? AND workspace_id = ? AND ended_at IS NULL`,
      );
      for (const sessionId of sessionIds)
        update.run(now, sessionId, workspaceId);
    });
  }

  find(
    workspaceId: string,
    client: HandoffClient,
    clientSession: string,
    clientAgent: string,
  ): HandoffSessionRow | undefined {
    this.verify();
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM handoff_sessions WHERE workspace_id = ? AND client = ? AND client_session = ? AND client_agent = ?`,
      )
      .get(workspaceId, client, clientSession, clientAgent);
    return row === undefined ? undefined : sessionRow(row);
  }

  sessions(workspaceId: string): HandoffSessionRow[] {
    this.verify();
    return this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM handoff_sessions WHERE workspace_id = ?
          ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(workspaceId, MAX_SESSIONS_PER_WORKSPACE)
      .flatMap((row) => known(() => sessionRow(row)));
  }

  /** Newest notes first, optionally only some kinds. */
  notes(
    workspaceId: string,
    limit: number,
    kinds: readonly HandoffNoteKind[] = HANDOFF_NOTE_KINDS,
  ): HandoffNoteRow[] {
    this.verify();
    return this.database
      .prepare(
        `SELECT n.session_id, n.kind, n.text, n.created_at FROM handoff_notes n
          JOIN handoff_sessions s ON s.session_id = n.session_id
          WHERE s.workspace_id = ? AND n.kind IN (${kinds.map(() => "?").join(", ")})
          ORDER BY n.note_id DESC LIMIT ?`,
      )
      .all(workspaceId, ...kinds, limit)
      .map((row) => {
        if (
          typeof row.session_id !== "string" ||
          typeof row.kind !== "string" ||
          typeof row.text !== "string" ||
          typeof row.created_at !== "number"
        )
          throw new HandoffError("unavailable");
        return {
          sessionId: row.session_id,
          kind: noteKind(row.kind),
          text: row.text,
          createdAt: row.created_at,
        };
      });
  }

  /** Each session's newest note. */
  lastNotes(workspaceId: string): Map<string, HandoffNoteRow> {
    this.verify();
    const result = new Map<string, HandoffNoteRow>();
    for (const row of this.database
      .prepare(
        `SELECT n.session_id, n.kind, n.text, n.created_at FROM handoff_notes n
          JOIN handoff_sessions s ON s.session_id = n.session_id
          WHERE s.workspace_id = ? AND n.note_id = (
            SELECT max(note_id) FROM handoff_notes m WHERE m.session_id = n.session_id)`,
      )
      .all(workspaceId)) {
      if (
        typeof row.session_id !== "string" ||
        typeof row.kind !== "string" ||
        typeof row.text !== "string" ||
        typeof row.created_at !== "number"
      )
        throw new HandoffError("unavailable");
      const { session_id: sessionId, kind, text, created_at: createdAt } = row;
      for (const parsed of known(() => noteKind(kind)))
        result.set(sessionId, { sessionId, kind: parsed, text, createdAt });
    }
    return result;
  }
}
