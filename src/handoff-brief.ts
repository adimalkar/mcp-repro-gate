import { basename } from "node:path";

import type { HandoffRecordV1 } from "./handoff-contract.js";
import {
  MAX_BRIEF_NOTES,
  MAX_BRIEF_SESSIONS,
  printableText,
  truncateBytes,
  HANDOFF_SESSION_STATES,
  type HandoffBriefV1,
  type HandoffDocumentState,
  type HandoffGitObservation,
  type HandoffLaneV1,
  type HandoffSessionState,
  type HandoffSessionView,
} from "./handoff-session-contract.js";
import type { HandoffNoteRow, HandoffSessionRow } from "./handoff-sessions.js";

export interface HandoffLiveness {
  leaseMs: number;
  graceMs: number;
}

/**
 * Derive a session's state at `now`. Only an end, a client-reported
 * failure or a closed turn is a fact; quiet and interrupted are inferred
 * from silence, and a later call from the session revives it.
 */
export function sessionState(
  session: HandoffSessionRow,
  now: number,
  liveness: HandoffLiveness,
): HandoffSessionState {
  // A failure outranks an end the client reported afterwards: a user who
  // quits after a rate limit has still left the work unfinished.
  if (session.failure !== null && session.endReason !== "completed")
    return "failed";
  if (session.endedAt !== null) return "ended";
  if (session.turnOpen === false) return "idle";
  const silent = now - session.lastSeenAt;
  if (silent <= liveness.leaseMs) return "active";
  if (silent <= liveness.leaseMs + liveness.graceMs) return "quiet";
  return "interrupted";
}

// What a resuming agent must look at first.
const PRIORITY: Record<HandoffSessionState, number> = {
  failed: 0,
  interrupted: 1,
  quiet: 2,
  active: 3,
  idle: 4,
  ended: 5,
};

const iso = (time: number) => new Date(time).toISOString();

/** A worktree's name for briefs, which never carry host paths. */
export function worktreeName(path: string): string {
  return printableText(basename(path), 128);
}

export type HandoffSubagentCounts = Record<HandoffSessionState, number>;

export function sessionView(
  session: HandoffSessionRow,
  state: HandoffSessionState,
  lastNote: HandoffNoteRow | undefined,
  subagents: HandoffSubagentCounts | null = null,
): HandoffSessionView {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    kind: session.kind,
    client: session.client,
    parentSessionId: session.parentSessionId,
    task: session.task,
    state,
    startedAt: iso(session.startedAt),
    lastSeenAt: iso(session.lastSeenAt),
    endedAt: session.endedAt === null ? null : iso(session.endedAt),
    endReason: session.endReason,
    clientReason: session.clientReason,
    failure: session.failure,
    lastNote:
      lastNote === undefined
        ? null
        : {
            kind: lastNote.kind,
            text: lastNote.text,
            createdAt: iso(lastNote.createdAt),
          },
    notes: session.noteCount,
    lastMessage: session.lastMessage,
    worktree: session.worktree === null ? null : worktreeName(session.worktree),
    subagents,
  };
}

// Subagents a resuming agent must look at even when their parent is shown.
const ATTENTION: ReadonlySet<HandoffSessionState> = new Set([
  "failed",
  "interrupted",
  "quiet",
]);

function emptyCounts(): HandoffSubagentCounts {
  return Object.fromEntries(
    HANDOFF_SESSION_STATES.map((state) => [state, 0]),
  ) as HandoffSubagentCounts;
}

/** Each session's parent, when that parent is among `sessions`. */
function parentsWithin(
  sessions: readonly HandoffSessionRow[],
): Map<string, string> {
  const ids = new Set(sessions.map((session) => session.sessionId));
  const parents = new Map<string, string>();
  for (const session of sessions)
    if (session.parentSessionId !== null && ids.has(session.parentSessionId))
      parents.set(session.sessionId, session.parentSessionId);
  return parents;
}

/** Sessions a dropped view stands for: itself and those folded into it. */
export function representedSessions(view: HandoffSessionView): number {
  const counts = view.subagents;
  return (
    1 +
    (counts === null
      ? 0
      : HANDOFF_SESSION_STATES.reduce((sum, state) => sum + counts[state], 0))
  );
}

function byAttention(
  rows: readonly {
    view: HandoffSessionView;
    state: HandoffSessionState;
    seen: number;
  }[],
): HandoffSessionView[] {
  return [...rows]
    .sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || b.seen - a.seen)
    .map(({ view }) => view);
}

export interface BriefInput {
  now: number;
  liveness: HandoffLiveness;
  latest: HandoffRecordV1 | undefined;
  document: HandoffDocumentState;
  sessions: readonly HandoffSessionRow[];
  lastNotes: ReadonlyMap<string, HandoffNoteRow>;
  /** Recent blocker and decision notes, newest first. */
  notes: readonly HandoffNoteRow[];
  git: HandoffGitObservation;
}

/**
 * Sessions ordered for a resuming agent: problems first, then newest. A
 * subagent that does not need attention is folded into the counts of its
 * nearest listed ancestor, so twenty healthy subagents cost one line and
 * every session is either listed or counted exactly once. A session whose
 * parent is not in `sessions` is listed on its own.
 */
export function orderedSessions(
  input: Pick<BriefInput, "now" | "liveness" | "sessions" | "lastNotes">,
): HandoffSessionView[] {
  const states = new Map(
    input.sessions.map((session) => [
      session.sessionId,
      sessionState(session, input.now, input.liveness),
    ]),
  );
  const parents = parentsWithin(input.sessions);
  const listed = (id: string) =>
    !parents.has(id) || ATTENTION.has(states.get(id) ?? "ended");
  const counts = new Map<string, HandoffSubagentCounts>();
  const folded = new Set<string>();
  for (const session of input.sessions) {
    const id = session.sessionId;
    if (listed(id)) continue;
    // Walk up to the nearest listed ancestor; a cycle lists the session.
    const seen = new Set([id]);
    let ancestor = parents.get(id);
    while (ancestor !== undefined && !listed(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    if (ancestor === undefined || seen.has(ancestor)) continue;
    let entry = counts.get(ancestor);
    if (entry === undefined) counts.set(ancestor, (entry = emptyCounts()));
    entry[states.get(id) ?? "ended"]++;
    folded.add(id);
  }
  return byAttention(
    input.sessions
      .filter((session) => !folded.has(session.sessionId))
      .map((session) => {
        const state = states.get(session.sessionId) ?? "ended";
        return {
          view: sessionView(
            session,
            state,
            input.lastNotes.get(session.sessionId),
            counts.get(session.sessionId) ?? null,
          ),
          state,
          seen: session.lastSeenAt,
        };
      }),
  );
}

export interface LaneInput {
  now: number;
  liveness: HandoffLiveness;
  session: HandoffSessionRow;
  /** The session's notes, newest first. */
  notes: readonly HandoffNoteRow[];
  subagents: readonly HandoffSessionRow[];
  /** Every session in the workspace, for the subagents' own counts. */
  workspace: readonly HandoffSessionRow[];
  lastNotes: ReadonlyMap<string, HandoffNoteRow>;
}

/** One session in full: its newest notes and all its subagents. */
export function buildLane(input: LaneInput): HandoffLaneV1 {
  const all = [input.session, ...input.subagents, ...input.workspace];
  const states = new Map(
    all.map((session) => [
      session.sessionId,
      sessionState(session, input.now, input.liveness),
    ]),
  );
  const children = new Map<string, string[]>();
  for (const session of input.workspace) {
    const parent = session.parentSessionId;
    if (parent === null) continue;
    const list = children.get(parent) ?? [];
    list.push(session.sessionId);
    children.set(parent, list);
  }
  // In a lane every count covers all descendants: none of them is listed
  // except the lane session's direct subagents.
  const descendants = (id: string): HandoffSubagentCounts | null => {
    const counts = emptyCounts();
    const seen = new Set([id]);
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() ?? "";
      if (seen.has(next)) continue;
      seen.add(next);
      counts[states.get(next) ?? "ended"]++;
      stack.push(...(children.get(next) ?? []));
    }
    return seen.size === 1 ? null : counts;
  };
  const view = (session: HandoffSessionRow) =>
    sessionView(
      session,
      states.get(session.sessionId) ?? "ended",
      input.lastNotes.get(session.sessionId),
      descendants(session.sessionId),
    );
  return {
    session: view(input.session),
    notes: input.notes.map((note) => ({
      sessionId: note.sessionId,
      kind: note.kind,
      text: note.text,
      createdAt: iso(note.createdAt),
    })),
    // Notes past the ledger's per-session cap are already gone.
    omittedNotes: Math.max(0, input.session.noteCount - input.notes.length),
    subagents: byAttention(
      input.subagents.map((session) => ({
        view: view(session),
        state: states.get(session.sessionId) ?? "ended",
        seen: session.lastSeenAt,
      })),
    ),
    omittedSubagents: 0,
    truncated: false,
  };
}

/**
 * Shrink a lane until `measure` fits the budget: oldest notes first, then
 * the subagents least in need of attention, then long texts, then the
 * session's free text. Dropped entries are counted; anything else sets
 * `truncated`.
 */
export function fitLane(
  lane: HandoffLaneV1,
  budget: number,
  measure: (lane: HandoffLaneV1) => number,
): HandoffLaneV1 {
  const fitted = structuredClone(lane);
  const fits = () => measure(fitted) <= budget;
  const views = () => [fitted.session, ...fitted.subagents];
  const steps: (() => boolean)[] = [
    () => {
      if (fitted.notes.length === 0) return false;
      fitted.notes.pop();
      fitted.omittedNotes++;
      return true;
    },
    () => {
      if (fitted.subagents.length === 0) return false;
      fitted.subagents.pop();
      fitted.omittedSubagents++;
      return true;
    },
    () => {
      let changed = false;
      for (const view of views()) {
        for (const key of ["task", "lastMessage"] as const) {
          const value = view[key];
          if (value !== null && Buffer.byteLength(value) > 256) {
            view[key] = truncateBytes(value, 256);
            changed = true;
          }
        }
        if (
          view.lastNote !== null &&
          Buffer.byteLength(view.lastNote.text) > 256
        ) {
          view.lastNote.text = truncateBytes(view.lastNote.text, 256);
          changed = true;
        }
      }
      if (changed) fitted.truncated = true;
      return changed;
    },
    () => {
      const view = fitted.session;
      if (
        view.task === null &&
        view.lastNote === null &&
        view.lastMessage === null &&
        view.clientReason === null
      )
        return false;
      view.task = null;
      view.lastNote = null;
      view.lastMessage = null;
      view.clientReason = null;
      fitted.truncated = true;
      return true;
    },
  ];
  for (const step of steps) {
    while (!fits()) if (!step()) break;
    if (fits()) break;
  }
  return fitted;
}

export function buildBrief(input: BriefInput): HandoffBriefV1 {
  const context = input.latest?.context;
  const sessions = orderedSessions(input);
  const shown = sessions.slice(0, MAX_BRIEF_SESSIONS);
  const notes = input.notes.slice(0, MAX_BRIEF_NOTES);
  return {
    briefVersion: 1,
    generatedAt: iso(input.now),
    handoff: {
      revision: input.latest?.revision ?? 0,
      document: input.document,
      activeAgent: context?.activeAgent ?? null,
      updatedAt: input.latest?.createdAt ?? null,
      goal: context?.goal ?? null,
      nextSteps: [...(context?.nextSteps ?? [])],
      blockers: [...(context?.blockers ?? [])],
    },
    sessions: shown,
    omittedSessions: sessions
      .slice(shown.length)
      .reduce((sum, view) => sum + representedSessions(view), 0),
    notes: notes.map((note) => ({
      sessionId: note.sessionId,
      kind: note.kind,
      text: note.text,
      createdAt: iso(note.createdAt),
    })),
    omittedNotes: input.notes.length - notes.length,
    git: input.git,
    truncated: false,
    provenance: {
      handoff: input.latest?.provenance ?? "caller_asserted",
      notes: "caller_asserted",
      sessions: "observed",
      git: "observed",
    },
  };
}

/**
 * Shrink a brief until `measure` fits the budget. The least useful entries
 * go first: dropped entries are counted, and anything else removed or cut
 * short sets `truncated`, so a reader always knows something is missing.
 * The last steps leave only the skeleton (counts, states and the Git
 * summary, with no free text), which fits every budget from MIN_BRIEF_BYTES
 * up.
 */
export function fitBrief(
  brief: HandoffBriefV1,
  budget: number,
  measure: (brief: HandoffBriefV1) => number,
): HandoffBriefV1 {
  const fitted = structuredClone(brief);
  const fits = () => measure(fitted) <= budget;
  // Cut every text in a group to `bytes`; false when nothing was longer.
  const cutAll = (
    texts: { get(): string | null; set(value: string): void }[],
    bytes: number,
  ) => {
    let changed = false;
    for (const text of texts) {
      const value = text.get();
      if (value !== null && Buffer.byteLength(value) > bytes) {
        text.set(truncateBytes(value, bytes));
        changed = true;
      }
    }
    if (changed) fitted.truncated = true;
    return changed;
  };
  const sessionTexts = () =>
    fitted.sessions.flatMap((session) => [
      {
        get: () => session.task,
        set: (value: string) => {
          session.task = value;
        },
      },
      {
        get: () => session.lastNote?.text ?? null,
        set: (value: string) => {
          if (session.lastNote !== null) session.lastNote.text = value;
        },
      },
      {
        get: () => session.lastMessage,
        set: (value: string) => {
          session.lastMessage = value;
        },
      },
    ]);
  const noteTexts = () =>
    fitted.notes.map((note) => ({
      get: () => note.text,
      set: (value: string) => {
        note.text = value;
      },
    }));
  const handoffTexts = () => [
    {
      get: () => fitted.handoff.goal,
      set: (value: string) => {
        fitted.handoff.goal = value;
      },
    },
    ...fitted.handoff.nextSteps.map((_, index) => ({
      get: () => fitted.handoff.nextSteps[index] ?? null,
      set: (value: string) => {
        fitted.handoff.nextSteps[index] = value;
      },
    })),
    ...fitted.handoff.blockers.map((_, index) => ({
      get: () => fitted.handoff.blockers[index] ?? null,
      set: (value: string) => {
        fitted.handoff.blockers[index] = value;
      },
    })),
  ];
  const steps: (() => boolean)[] = [
    () => {
      const subjects = fitted.git.commitsSince?.subjects;
      if (subjects === undefined || subjects.length === 0) return false;
      subjects.pop();
      fitted.truncated = true;
      return true;
    },
    () => {
      if (fitted.notes.length === 0) return false;
      fitted.notes.pop();
      fitted.omittedNotes++;
      return true;
    },
    () => {
      if (fitted.git.paths.length === 0) return false;
      fitted.git.paths.pop();
      fitted.git.omittedPaths++;
      return true;
    },
    () => {
      // Ended sessions first, from the end of the ordered list.
      let index = fitted.sessions.length - 1;
      while (index >= 0 && fitted.sessions[index]?.state !== "ended") index--;
      if (index < 0) return false;
      const [dropped] = fitted.sessions.splice(index, 1);
      if (dropped !== undefined)
        fitted.omittedSessions += representedSessions(dropped);
      return true;
    },
    () => {
      const session = fitted.sessions.find(
        (candidate) => candidate.lastMessage !== null,
      );
      if (session === undefined) return false;
      session.lastMessage = null;
      fitted.truncated = true;
      return true;
    },
    () => cutAll([...sessionTexts(), ...noteTexts()], 256),
    () => cutAll(handoffTexts(), 256),
    () => {
      if (fitted.sessions.length <= 1) return false;
      const dropped = fitted.sessions.pop();
      if (dropped !== undefined)
        fitted.omittedSessions += representedSessions(dropped);
      return true;
    },
    () => {
      const list =
        fitted.handoff.nextSteps.length > 1
          ? fitted.handoff.nextSteps
          : fitted.handoff.blockers.length > 1
            ? fitted.handoff.blockers
            : undefined;
      if (list === undefined) return false;
      list.pop();
      fitted.truncated = true;
      return true;
    },
    () => {
      // Skeleton: no entries, every remaining text cut short.
      const entries =
        fitted.sessions.length +
        fitted.notes.length +
        fitted.git.paths.length +
        fitted.handoff.nextSteps.length +
        fitted.handoff.blockers.length +
        (fitted.git.commitsSince === null ? 0 : 1);
      fitted.omittedSessions += fitted.sessions.reduce(
        (sum, view) => sum + representedSessions(view),
        0,
      );
      fitted.omittedNotes += fitted.notes.length;
      fitted.git.omittedPaths += fitted.git.paths.length;
      fitted.sessions = [];
      fitted.notes = [];
      fitted.git.paths = [];
      fitted.git.commitsSince = null;
      fitted.handoff.nextSteps = [];
      fitted.handoff.blockers = [];
      const cut = cutAll(
        [
          ...handoffTexts(),
          {
            get: () => fitted.handoff.activeAgent,
            set: (value: string) => {
              fitted.handoff.activeAgent = value;
            },
          },
          {
            get: () => fitted.git.branch,
            set: (value: string) => {
              fitted.git.branch = value;
            },
          },
          {
            get: () => fitted.git.upstream,
            set: (value: string) => {
              fitted.git.upstream = value;
            },
          },
        ],
        64,
      );
      if (entries > 0) fitted.truncated = true;
      return entries > 0 || cut;
    },
    () => {
      // JSON escaping can double cut text, so drop free text entirely.
      const h = fitted.handoff;
      const g = fitted.git;
      if (
        h.goal === null &&
        h.activeAgent === null &&
        g.branch === null &&
        g.upstream === null
      )
        return false;
      h.goal = null;
      h.activeAgent = null;
      g.branch = null;
      g.upstream = null;
      fitted.truncated = true;
      return true;
    },
  ];
  for (const step of steps) {
    while (!fits()) if (!step()) break;
    if (fits()) break;
  }
  return fitted;
}

function ago(from: string, now: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(now) - Date.parse(from)) / 1000),
  );
  if (seconds < 90) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

const line = (text: string) => text.replace(/\r\n|\r|\n/gu, " ");

function describeSession(session: HandoffSessionView, now: string): string {
  const who = `${session.agent} (${session.kind === "subagent" ? "subagent, " : ""}${session.client}, ${session.sessionId.slice(0, 8)})`;
  let state: string;
  switch (session.state) {
    case "failed":
      state = `stopped on ${session.failure ?? "an error"} ${ago(session.lastSeenAt, now)}${session.endedAt === null ? "" : `, then ended (${session.endReason ?? "unknown"}${session.clientReason === null ? "" : `: ${session.clientReason}`})`}; its work may be unfinished`;
      break;
    case "interrupted":
      state = `no activity since ${ago(session.lastSeenAt, now)}, stopped without ending`;
      break;
    case "quiet":
      state = `quiet since ${ago(session.lastSeenAt, now)}`;
      break;
    case "active":
      state = `active, seen ${ago(session.lastSeenAt, now)}`;
      break;
    case "idle":
      state = `waiting for input since ${ago(session.lastSeenAt, now)}`;
      break;
    case "ended":
      state = `ended (${session.endReason ?? "unknown"}${session.clientReason === null ? "" : `: ${session.clientReason}`}) ${ago(session.endedAt ?? session.lastSeenAt, now)}`;
      break;
  }
  const parts = [`- ${who}: ${state}`];
  if (session.worktree !== null)
    parts.push(`  worktree: ${line(session.worktree)}`);
  if (session.task !== null) parts.push(`  task: ${line(session.task)}`);
  if (session.lastNote !== null)
    parts.push(
      `  last note (${session.lastNote.kind}): ${line(session.lastNote.text)}`,
    );
  if (session.lastMessage !== null)
    parts.push(`  last reply: ${line(session.lastMessage)}`);
  const counts = session.subagents;
  if (counts !== null) {
    const summary = HANDOFF_SESSION_STATES.filter((state) => counts[state] > 0)
      .map((state) => `${String(counts[state])} ${state}`)
      .join(", ");
    if (summary !== "") parts.push(`  subagents: ${summary}`);
  }
  return parts.join("\n");
}

// What an agent should do about the document; other states need nothing.
const DOCUMENT_ATTENTION: Partial<Record<HandoffDocumentState, string>> = {
  untracked:
    ".agent/handoff.md exists but was never recorded. Read it; if it is right, record it with handoff_adopt.",
  drifted:
    ".agent/handoff.md was changed outside ReproGate, so the handoff below may be out of date. Read the file; if it is right, record it with handoff_adopt.",
  deleted:
    ".agent/handoff.md was deleted. The next handoff_update writes it again.",
};

/** Plain text for hook context and terminals; it renders the same facts. */
export function renderBriefText(
  brief: HandoffBriefV1,
  options: { includeGit?: boolean } = {},
): string {
  const now = brief.generatedAt;
  const out: string[] = ["ReproGate handoff brief"];
  const { handoff, git } = brief;
  // An operation left in progress blocks other work, so it comes first.
  if (git.operation !== null)
    out.push(
      "",
      `Attention: a ${git.operation.replace("_", "-")} is in progress in the workspace. Finish or abort it before other work.`,
    );
  const document = DOCUMENT_ATTENTION[handoff.document];
  if (document !== undefined) out.push("", `Attention: ${document}`);
  if (brief.truncated || brief.omittedSessions > 0 || brief.omittedNotes > 0)
    out.push("", "This brief was shortened to fit its budget.");
  out.push(
    "",
    `Handoff (${brief.provenance.handoff === "adopted_document" ? "adopted from a document" : "asserted by agents"}, revision ${String(handoff.revision)}${handoff.updatedAt === null ? "" : `, ${ago(handoff.updatedAt, now)} by ${handoff.activeAgent ?? "unknown"}`}):`,
  );
  if (handoff.goal === null) out.push("- No handoff recorded.");
  else {
    out.push(`- Goal: ${line(handoff.goal)}`);
    for (const step of handoff.nextSteps) out.push(`- Next: ${line(step)}`);
    for (const blocker of handoff.blockers)
      out.push(`- Blocker: ${line(blocker)}`);
  }
  out.push("", "Sessions (observed by ReproGate):");
  if (brief.sessions.length === 0) out.push("- None recorded.");
  for (const session of brief.sessions) out.push(describeSession(session, now));
  if (brief.omittedSessions > 0)
    out.push(`- ${String(brief.omittedSessions)} more not shown.`);
  if (brief.notes.length > 0) {
    out.push("", "Recent blockers and decisions (asserted):");
    for (const note of brief.notes)
      out.push(
        `- ${note.kind} from ${note.sessionId.slice(0, 8)}, ${ago(note.createdAt, now)}: ${line(note.text)}`,
      );
    if (brief.omittedNotes > 0)
      out.push(`- ${String(brief.omittedNotes)} more not shown.`);
  }
  if (options.includeGit === false) return `${out.join("\n")}\n`;
  out.push(
    "",
    `Git (observed now${git.worktree === null ? "" : ` in ${line(git.worktree)}`}):`,
  );
  if (git.state !== "observed")
    out.push(
      `- ${git.state === "disabled" ? "Observation is turned off." : "Unavailable: not a repository, or Git could not be read safely."}`,
    );
  else {
    out.push(
      `- ${git.detached ? "Detached HEAD" : `Branch ${git.branch ?? "unknown"}`} at ${git.head?.slice(0, 12) ?? "no commit"}${git.upstream === null ? "" : `, ${String(git.ahead ?? 0)} ahead and ${String(git.behind ?? 0)} behind ${git.upstream}`}`,
    );
    if (git.operation !== null)
      out.push(`- A ${git.operation.replace("_", "-")} is in progress.`);
    const c = git.changes;
    out.push(
      `- ${String(c.staged)} staged, ${String(c.unstaged)} unstaged, ${String(c.untracked)} untracked, ${String(c.conflicted)} conflicted`,
    );
    for (const entry of git.paths)
      out.push(`  ${entry.status} ${line(entry.path)}`);
    if (git.omittedPaths > 0)
      out.push(`  ${String(git.omittedPaths)} more paths not shown`);
    if (git.commitsSince !== null) {
      out.push(
        `- ${String(git.commitsSince.count)} commit(s) since ${git.commitsSince.base.slice(0, 12)}:`,
      );
      for (const subject of git.commitsSince.subjects)
        out.push(`  ${line(subject)}`);
    }
  }
  return `${out.join("\n")}\n`;
}
