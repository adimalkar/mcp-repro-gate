import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { HandoffRecordV1 } from "./handoff-contract.js";
import { HandoffError } from "./handoff-primitives.js";
import {
  HANDOFF_NOTE_KINDS,
  MAX_SEARCH_CANDIDATES,
  MAX_SEARCH_HIT_BYTES,
  type HandoffNoteKind,
  type HandoffRevisionField,
  type HandoffSearchHit,
  type HandoffSearchKind,
  type HandoffSearchResultV1,
  type HandoffSessionState,
  printableText,
  truncateBytes,
} from "./handoff-session-contract.js";

/**
 * A derived cache of the handoff context, brought up to date before every
 * search. Dropping it loses nothing. Bump the version when tokenizing
 * changes, so existing indexes are rebuilt.
 */
const INDEX_VERSION = "1";
export const HANDOFF_SEARCH_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS handoff_search USING fts5(
    body, parts, doc UNINDEXED, workspace_id UNINDEXED, kind UNINDEXED,
    session_id UNINDEXED, created_at UNINDEXED,
    tokenize = "unicode61 tokenchars '_'"
  );
  CREATE TABLE IF NOT EXISTS handoff_search_state (
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 16),
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) <= 512),
    PRIMARY KEY(workspace_id, source)
  ) STRICT;
`;
/** Revisions searched: older ones are mostly repeated by newer ones. */
export const SEARCH_REVISIONS = 32;
/** Matches ranked by BM25 before context and filters re-rank them. */
const POOL = 200;
const MAX_QUERY_WORDS = 16;
const ID_CHUNK = 500;

// unicode61 keeps letters, digits and "_" together; everything else splits.
const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * The parts of an identifier that unicode61 keeps whole: snake_case and
 * camelCase words. Empty when the word has no parts.
 */
export function identifierParts(word: string): string[] {
  const parts = word
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[\s_]+/u)
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase());
  return parts.length > 1 ? parts : [];
}

/** The second indexed column: identifier parts, in order. */
export function indexedParts(text: string): string {
  const groups: string[] = [];
  for (const [word] of text.matchAll(WORD)) {
    const parts = identifierParts(word);
    if (parts.length > 0) groups.push(parts.join(" "));
  }
  return groups.join(" ");
}

// Wrapping punctuation that is never part of a word an agent searches for.
const EDGE = /^[\s"'`([{<,;:!?]+|[\s"'`)\]}>,;:!?.]+$/gu;
function queryWords(query: string): string[] {
  const words: string[] = [];
  for (const raw of query.split(/\s+/u)) {
    const word = raw.replace(EDGE, "");
    if (word === "" || !/[\p{L}\p{N}]/u.test(word)) continue;
    if (!words.includes(word)) words.push(word);
    if (words.length === MAX_QUERY_WORDS) break;
  }
  return words;
}
const phrase = (text: string) => `"${text.replaceAll('"', '""')}"`;

/**
 * Free text to an FTS5 expression. Every word is a quoted phrase, so no
 * query can use FTS5 syntax; FTS5 splits it with the table's tokenizer, so
 * `src/cli.ts` matches those three tokens in order. Identifier parts are
 * tried as well, and words are joined with OR for BM25 to rank. Undefined
 * when nothing searchable remains.
 */
export function searchExpression(
  query: string,
  path?: string,
): string | undefined {
  const terms = queryWords(query).map((word) => {
    const alternatives = [phrase(word)];
    for (const [token] of word.matchAll(WORD)) {
      const parts = identifierParts(token);
      if (parts.length > 0)
        alternatives.push(`parts : ${phrase(parts.join(" "))}`);
    }
    return alternatives.length === 1
      ? alternatives[0]
      : `(${alternatives.join(" OR ")})`;
  });
  if (terms.length === 0) return undefined;
  const expression = terms.join(" OR ");
  // The path narrows the matches; hits are checked against it exactly later.
  return path !== undefined && /[\p{L}\p{N}]/u.test(path)
    ? `(${expression}) AND ${phrase(path)}`
    : expression;
}

// A word that names a file: it has a directory, or a short extension after a
// stem of two or more characters with a letter (not "e.g", not "1.2").
const EXTENSION = /^(?<stem>.*[\p{L}].*)\.[\p{L}][\p{L}\p{N}]{0,7}$/u;
function pathLike(word: string): boolean {
  if (word.includes("://") || word.startsWith("-")) return false;
  if (/[\p{L}\p{N}_]\/[\p{L}\p{N}_.]/u.test(word)) return true;
  const match = EXTENSION.exec(word);
  return (match?.groups?.stem?.length ?? 0) >= 2;
}
/** Path-like words in a text, in order, without duplicates. */
export function pathWords(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\s+/u)) {
    const word = raw.replace(EDGE, "").replace(/^\.\//u, "");
    if (word.length > 512 || !pathLike(word)) continue;
    if (!paths.includes(word)) paths.push(word);
  }
  return paths;
}
/** Does `path` name the file `term` names, or a sibling ending with it? */
function namesFile(path: string, term: string): boolean {
  if (path === term || path.endsWith(`/${term}`)) return true;
  if (term.includes("/")) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    name.length > term.length &&
    name.endsWith(term) &&
    !/[\p{L}\p{N}]/u.test(name.charAt(name.length - term.length - 1))
  );
}
/** Does `path` match a path filter: equal, or ending at a separator? */
function matchesPath(path: string, filter: string): boolean {
  return path === filter || path.endsWith(`/${filter}`);
}

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export interface SearchRow {
  doc: string;
  kind: string;
  sessionId: string | null;
  createdAt: number;
  body: string;
  /** BM25: lower is better. */
  score: number;
  snippet: string;
}
interface Document {
  body: string;
  kind: string;
  sessionId: string | null;
  createdAt: number;
}

const REVISION_KIND = "r.";
function kindCondition(kinds: readonly HandoffSearchKind[]): {
  sql: string;
  values: string[];
} {
  const exact = kinds.filter((kind) => kind !== "revision");
  const clauses: string[] = [];
  if (exact.length > 0)
    clauses.push(`kind IN (${exact.map(() => "?").join(", ")})`);
  if (kinds.includes("revision")) clauses.push("substr(kind, 1, 2) = 'r.'");
  return { sql: `(${clauses.join(" OR ")})`, values: exact };
}

export class HandoffSearchIndex {
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

  /** Bring the index up to date with the notes, tasks and revisions. */
  sync(
    workspaceId: string,
    revisions: { latest: () => number; records: () => HandoffRecordV1[] },
  ): void {
    this.#transaction(() => {
      this.database.exec(HANDOFF_SEARCH_SCHEMA);
      this.#syncNotes(workspaceId);
      this.#syncTasks(workspaceId);
      const latest = revisions.latest();
      this.#syncSource(workspaceId, "revisions", String(latest), () => {
        const documents = new Map<string, Document>();
        const seen = new Set<string>();
        for (const record of revisions.records()) {
          const createdAt = Date.parse(record.createdAt);
          const { context } = record;
          const items: [HandoffRevisionField, readonly string[]][] = [
            ["goal", [context.goal]],
            ["completed", context.completed],
            ["touchedFile", context.touchedFiles],
            ["blocker", context.blockers],
            ["nextStep", context.nextSteps],
          ];
          for (const [field, texts] of items)
            for (const text of texts) {
              const identity = `${field}\n${text}`;
              if (seen.has(identity)) continue;
              seen.add(identity);
              documents.set(
                `r:${String(record.revision)}:${field}:${digest(identity)}`,
                {
                  body: text,
                  kind: REVISION_KIND + field,
                  sessionId: null,
                  createdAt,
                },
              );
            }
        }
        return {
          keys: [...documents.keys()],
          load: (keys) => keys.map((key) => documents.get(key)),
        };
      });
    });
  }

  #syncNotes(workspaceId: string): void {
    const totals = this.database
      .prepare(
        `SELECT count(*) AS count, coalesce(max(n.note_id), 0) AS last,
          coalesce(total(n.note_id), 0) AS ids, coalesce(total(n.created_at), 0) AS times
          FROM handoff_notes n JOIN handoff_sessions s ON s.session_id = n.session_id
          WHERE s.workspace_id = ?`,
      )
      .get(workspaceId);
    const fingerprint = [
      totals?.count,
      totals?.last,
      totals?.ids,
      totals?.times,
    ]
      .map(String)
      .join(":");
    this.#syncSource(workspaceId, "notes", fingerprint, () => {
      const rows = this.database
        .prepare(
          `SELECT n.note_id, n.created_at, n.session_id FROM handoff_notes n
            JOIN handoff_sessions s ON s.session_id = n.session_id WHERE s.workspace_id = ?`,
        )
        .all(workspaceId);
      const ids = new Map<string, number>();
      for (const row of rows) {
        if (
          typeof row.note_id !== "number" ||
          typeof row.created_at !== "number" ||
          typeof row.session_id !== "string"
        )
          throw new HandoffError("unavailable");
        ids.set(
          `n:${String(row.note_id)}:${String(row.created_at)}:${row.session_id}`,
          row.note_id,
        );
      }
      return {
        keys: [...ids.keys()],
        load: (keys) => {
          const loaded = new Map<number, Document>();
          const wanted = keys.map((key) => ids.get(key) ?? -1);
          for (let start = 0; start < wanted.length; start += ID_CHUNK) {
            const chunk = wanted.slice(start, start + ID_CHUNK);
            for (const row of this.database
              .prepare(
                `SELECT note_id, kind, text, created_at, session_id FROM handoff_notes
                  WHERE note_id IN (${chunk.map(() => "?").join(", ")})`,
              )
              .all(...chunk)) {
              if (
                typeof row.note_id !== "number" ||
                typeof row.kind !== "string" ||
                typeof row.text !== "string" ||
                typeof row.created_at !== "number" ||
                typeof row.session_id !== "string"
              )
                throw new HandoffError("unavailable");
              loaded.set(row.note_id, {
                body: row.text,
                kind: row.kind,
                sessionId: row.session_id,
                createdAt: row.created_at,
              });
            }
          }
          return wanted.map((id) => loaded.get(id));
        },
      };
    });
  }

  // At most one task per session and a bounded number of sessions: always
  // compared in full, so an edited task is never missed.
  #syncTasks(workspaceId: string): void {
    const documents = new Map<string, Document>();
    for (const row of this.database
      .prepare(
        "SELECT session_id, task, started_at FROM handoff_sessions WHERE workspace_id = ? AND task IS NOT NULL",
      )
      .all(workspaceId)) {
      if (
        typeof row.session_id !== "string" ||
        typeof row.task !== "string" ||
        typeof row.started_at !== "number"
      )
        throw new HandoffError("unavailable");
      documents.set(`t:${row.session_id}:${digest(row.task)}`, {
        body: row.task,
        kind: "task",
        sessionId: row.session_id,
        createdAt: row.started_at,
      });
    }
    this.#apply(workspaceId, "t:", [...documents.keys()], (keys) =>
      keys.map((key) => documents.get(key)),
    );
  }

  #syncSource(
    workspaceId: string,
    source: "notes" | "revisions",
    fingerprint: string,
    documents: () => {
      keys: string[];
      load: (keys: string[]) => (Document | undefined)[];
    },
  ): void {
    const value = `${INDEX_VERSION}:${fingerprint}`;
    const stored = this.database
      .prepare(
        "SELECT fingerprint FROM handoff_search_state WHERE workspace_id = ? AND source = ?",
      )
      .get(workspaceId, source);
    if (stored?.fingerprint === value) return;
    const { keys, load } = documents();
    this.#apply(workspaceId, source === "notes" ? "n:" : "r:", keys, load);
    this.database
      .prepare(
        `INSERT INTO handoff_search_state(workspace_id, source, fingerprint) VALUES(?, ?, ?)
          ON CONFLICT(workspace_id, source) DO UPDATE SET fingerprint = excluded.fingerprint`,
      )
      .run(workspaceId, source, value);
  }

  #apply(
    workspaceId: string,
    prefix: string,
    keys: readonly string[],
    load: (keys: string[]) => (Document | undefined)[],
  ): void {
    const indexed = new Map<string, number>();
    for (const row of this.database
      .prepare(
        "SELECT rowid, doc FROM handoff_search WHERE workspace_id = ? AND substr(doc, 1, 2) = ?",
      )
      .all(workspaceId, prefix)) {
      if (typeof row.rowid !== "number" || typeof row.doc !== "string")
        throw new HandoffError("unavailable");
      // A duplicate from an interrupted write is removed with the stale.
      if (indexed.has(row.doc)) this.#remove(row.rowid);
      else indexed.set(row.doc, row.rowid);
    }
    const wanted = new Set(keys);
    for (const [doc, rowid] of indexed)
      if (!wanted.has(doc)) this.#remove(rowid);
    const missing = keys.filter((key) => !indexed.has(key));
    const insert = this.database.prepare(
      `INSERT INTO handoff_search(body, parts, doc, workspace_id, kind, session_id, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)`,
    );
    load(missing).forEach((document, index) => {
      // Removed since the keys were read: nothing to index.
      if (document === undefined) return;
      insert.run(
        document.body,
        indexedParts(document.body),
        missing[index] ?? "",
        workspaceId,
        document.kind,
        document.sessionId,
        document.createdAt,
      );
    });
  }

  #remove(rowid: number): void {
    this.database
      .prepare("DELETE FROM handoff_search WHERE rowid = ?")
      .run(rowid);
  }

  /** The best BM25 matches, joined back to their notes where they came from. */
  query(
    workspaceId: string,
    expression: string,
    kinds: readonly HandoffSearchKind[],
    /** Only these sessions' notes and tasks, when set. */
    sessionIds?: readonly string[],
  ): SearchRow[] {
    this.verify();
    const kind = kindCondition(kinds);
    const sessions =
      sessionIds === undefined
        ? ""
        : ` AND session_id IN (${sessionIds.map(() => "?").join(", ")})`;
    const rows = this.database
      .prepare(
        `SELECT doc, kind, session_id, created_at, body,
          bm25(handoff_search, 1.0, 0.5, 0, 0, 0, 0, 0) AS score,
          snippet(handoff_search, 0, '', '', '...', 48) AS snippet
          FROM handoff_search WHERE handoff_search MATCH ? AND workspace_id = ? AND ${kind.sql}${sessions}
          ORDER BY score LIMIT ?`,
      )
      .all(expression, workspaceId, ...kind.values, ...(sessionIds ?? []), POOL)
      .map((row): SearchRow => {
        if (
          typeof row.doc !== "string" ||
          typeof row.kind !== "string" ||
          (row.session_id !== null && typeof row.session_id !== "string") ||
          typeof row.created_at !== "number" ||
          typeof row.body !== "string" ||
          typeof row.score !== "number" ||
          typeof row.snippet !== "string"
        )
          throw new HandoffError("unavailable");
        return {
          doc: row.doc,
          kind: row.kind,
          sessionId: row.session_id,
          createdAt: row.created_at,
          body: row.body,
          score: row.score,
          snippet: row.snippet,
        };
      });
    // A note removed or replaced after the sync never surfaces.
    const notes = rows.filter((row) => row.doc.startsWith("n:"));
    const current = new Set<string>();
    for (let start = 0; start < notes.length; start += ID_CHUNK) {
      const chunk = notes.slice(start, start + ID_CHUNK);
      for (const row of this.database
        .prepare(
          `SELECT note_id, created_at, session_id, text FROM handoff_notes
            WHERE note_id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk.map((note) => Number(note.doc.split(":")[1])))) {
        if (
          typeof row.note_id === "number" &&
          typeof row.created_at === "number" &&
          typeof row.session_id === "string" &&
          typeof row.text === "string"
        )
          current.add(
            `n:${String(row.note_id)}:${String(row.created_at)}:${row.session_id}\n${row.text}`,
          );
      }
    }
    return rows.filter(
      (row) =>
        !row.doc.startsWith("n:") || current.has(`${row.doc}\n${row.body}`),
    );
  }
}

export interface SearchSession {
  agent: string;
  kind: "agent" | "subagent";
  state: HandoffSessionState;
  /** Full path, for comparisons; null outside repository scope. */
  worktreePath: string | null;
  /** Name, as briefs show it. */
  worktree: string | null;
}
export interface SearchContext {
  now: number;
  sessions: ReadonlyMap<string, SearchSession>;
  /** The caller's session, its parent and its subagents. */
  lane: ReadonlySet<string>;
  /** The caller's worktree path; null when unknown or not in a repository. */
  worktreePath: string | null;
}
export interface SearchOptions {
  query: string;
  worktree?: string;
  path?: string;
  limit: number;
  resultBytes: number;
}

const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();
const NOTE_KINDS: ReadonlySet<string> = new Set(HANDOFF_NOTE_KINDS);

/**
 * Re-rank BM25 matches in context and fit them to the byte budget. BM25 is
 * raised by half for the caller's lane and by a quarter for its worktree,
 * and lowered with age: a hit 30 days old counts half.
 */
export function composeSearch(
  rows: readonly SearchRow[],
  options: SearchOptions,
  context: SearchContext,
): HandoffSearchResultV1 {
  const ranked = rows
    .map((row) => {
      const session =
        row.sessionId === null
          ? undefined
          : context.sessions.get(row.sessionId);
      const paths = pathWords(row.body);
      let weight = 1;
      if (row.sessionId !== null && context.lane.has(row.sessionId))
        weight *= 1.5;
      if (
        context.worktreePath !== null &&
        session?.worktreePath === context.worktreePath
      )
        weight *= 1.25;
      weight /= 1 + Math.max(0, context.now - row.createdAt) / (30 * DAY);
      return { row, session, paths, value: -row.score * weight };
    })
    .filter(
      ({ row, session, paths }) =>
        // A session pruned since the sync is gone with its notes.
        (row.sessionId === null || session !== undefined) &&
        (options.worktree === undefined ||
          session?.worktree === options.worktree) &&
        (options.path === undefined ||
          paths.some((path) => matchesPath(path, options.path ?? ""))),
    )
    .sort((a, b) => b.value - a.value || b.row.createdAt - a.row.createdAt);

  // Identical text from several sessions or revisions is one hit.
  const seen = new Set<string>();
  const unique = ranked.filter(({ row }) => {
    const key = row.body.trim().replace(/\s+/gu, " ").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hits: HandoffSearchHit[] = unique.map(({ row, session, paths }) => {
    const whole = Buffer.byteLength(row.body) <= MAX_SEARCH_HIT_BYTES;
    const revision = row.doc.startsWith("r:")
      ? Number(row.doc.split(":")[1])
      : null;
    const kind = row.kind.startsWith(REVISION_KIND)
      ? (row.kind.slice(REVISION_KIND.length) as HandoffRevisionField)
      : NOTE_KINDS.has(row.kind)
        ? (row.kind as HandoffNoteKind)
        : null;
    return {
      source: row.doc.startsWith("n:")
        ? "note"
        : row.doc.startsWith("t:")
          ? "task"
          : "revision",
      kind,
      text: printableText(whole ? row.body : row.snippet, MAX_SEARCH_HIT_BYTES),
      cut: !whole,
      createdAt: iso(row.createdAt),
      sessionId: row.sessionId,
      agent: session?.agent ?? null,
      sessionKind: session?.kind ?? null,
      sessionState: session?.state ?? null,
      worktree: session?.worktree ?? null,
      revision,
      paths: paths.slice(0, 8).map((path) => printableText(path, 512)),
    };
  });

  const ambiguous =
    options.path === undefined ? ambiguity(options.query, unique) : null;
  const result: HandoffSearchResultV1 = {
    handoffVersion: 1,
    hits: hits.slice(0, options.limit),
    omittedHits: Math.max(0, hits.length - options.limit),
    ambiguous,
    truncated: false,
    provenance: "caller_asserted",
  };
  return fit(result, options.resultBytes);
}

function ambiguity(
  query: string,
  hits: readonly {
    row: SearchRow;
    session: SearchSession | undefined;
    paths: string[];
  }[],
): HandoffSearchResultV1["ambiguous"] {
  for (const term of pathWords(query)) {
    const candidates = new Map<
      string,
      {
        path: string;
        worktree: string | null;
        hits: number;
        lastSeenAt: number;
      }
    >();
    for (const { row, session, paths } of hits)
      for (const path of paths) {
        if (!namesFile(path, term)) continue;
        const worktree = session?.worktree ?? null;
        const key = `${worktree ?? ""}\n${path}`;
        const candidate = candidates.get(key) ?? {
          path,
          worktree,
          hits: 0,
          lastSeenAt: 0,
        };
        candidate.hits += 1;
        candidate.lastSeenAt = Math.max(candidate.lastSeenAt, row.createdAt);
        candidates.set(key, candidate);
      }
    if (candidates.size < 2) continue;
    const sorted = [...candidates.values()].sort(
      (a, b) =>
        b.hits - a.hits ||
        b.lastSeenAt - a.lastSeenAt ||
        a.path.localeCompare(b.path),
    );
    return {
      term: printableText(term, 512),
      candidates: sorted.slice(0, MAX_SEARCH_CANDIDATES).map((candidate) => ({
        path: printableText(candidate.path, 512),
        worktree: candidate.worktree,
        hits: candidate.hits,
        lastSeenAt: iso(candidate.lastSeenAt),
      })),
      omittedCandidates: Math.max(0, sorted.length - MAX_SEARCH_CANDIDATES),
    };
  }
  return null;
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Drop hits from the end, then candidates, then cut texts, to fit. */
function fit(
  result: HandoffSearchResultV1,
  budget: number,
): HandoffSearchResultV1 {
  const fitted = { ...result, hits: [...result.hits] };
  while (fitted.hits.length > 0 && size(fitted) > budget) {
    fitted.hits.pop();
    fitted.omittedHits += 1;
  }
  if (fitted.ambiguous !== null)
    while (fitted.ambiguous.candidates.length > 1 && size(fitted) > budget) {
      fitted.ambiguous = {
        ...fitted.ambiguous,
        candidates: fitted.ambiguous.candidates.slice(0, -1),
        omittedCandidates: fitted.ambiguous.omittedCandidates + 1,
      };
    }
  if (size(fitted) > budget && fitted.ambiguous !== null) {
    fitted.ambiguous = {
      ...fitted.ambiguous,
      term: truncateBytes(fitted.ambiguous.term, 64),
      candidates: fitted.ambiguous.candidates.map((candidate) => ({
        ...candidate,
        path: truncateBytes(candidate.path, 128),
      })),
    };
    fitted.truncated = true;
  }
  return fitted;
}
