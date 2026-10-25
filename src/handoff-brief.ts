import type { HandoffRecordV1 } from "./handoff-contract.js";
import {
  MAX_BRIEF_NOTES,
  MAX_BRIEF_SESSIONS,
  truncateBytes,
  type HandoffBriefV1,
  type HandoffGitObservation,
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
  if (session.endedAt !== null) return "ended";
  if (session.failure !== null) return "failed";
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

export function sessionView(
  session: HandoffSessionRow,
  state: HandoffSessionState,
  lastNote: HandoffNoteRow | undefined,
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
  };
}

export interface BriefInput {
  now: number;
  liveness: HandoffLiveness;
  latest: HandoffRecordV1 | undefined;
  sessions: readonly HandoffSessionRow[];
  lastNotes: ReadonlyMap<string, HandoffNoteRow>;
  /** Recent blocker and decision notes, newest first. */
  notes: readonly HandoffNoteRow[];
  git: HandoffGitObservation;
}

/** Sessions ordered for a resuming agent: problems first, then newest. */
export function orderedSessions(
  input: Pick<BriefInput, "now" | "liveness" | "sessions" | "lastNotes">,
): HandoffSessionView[] {
  return input.sessions
    .map((session) => {
      const state = sessionState(session, input.now, input.liveness);
      return {
        view: sessionView(
          session,
          state,
          input.lastNotes.get(session.sessionId),
        ),
        rank: PRIORITY[state],
        seen: session.lastSeenAt,
      };
    })
    .sort((a, b) => a.rank - b.rank || b.seen - a.seen)
    .map(({ view }) => view);
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
      activeAgent: context?.activeAgent ?? null,
      updatedAt: input.latest?.createdAt ?? null,
      goal: context?.goal ?? null,
      nextSteps: [...(context?.nextSteps ?? [])],
      blockers: [...(context?.blockers ?? [])],
    },
    sessions: shown,
    omittedSessions: sessions.length - shown.length,
    notes: notes.map((note) => ({
      sessionId: note.sessionId,
      kind: note.kind,
      text: note.text,
      createdAt: iso(note.createdAt),
    })),
    omittedNotes: input.notes.length - notes.length,
    git: input.git,
    provenance: {
      handoff: "caller_asserted",
      notes: "caller_asserted",
      sessions: "observed",
      git: "observed",
    },
  };
}

/**
 * Shrink a brief until `measure` fits the budget. The least useful entries
 * go first, and every removal is counted, so a reader always knows that
 * something was left out. Ends with long texts cut short.
 */
export function fitBrief(
  brief: HandoffBriefV1,
  budget: number,
  measure: (brief: HandoffBriefV1) => number,
): HandoffBriefV1 {
  const fitted = structuredClone(brief);
  const fits = () => measure(fitted) <= budget;
  const steps: (() => boolean)[] = [
    () => {
      if (
        fitted.git.commitsSince === null ||
        fitted.git.commitsSince.subjects.length === 0
      )
        return false;
      fitted.git.commitsSince.subjects.pop();
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
      fitted.sessions.splice(index, 1);
      fitted.omittedSessions++;
      return true;
    },
    () => {
      const session = fitted.sessions.find(
        (candidate) => candidate.lastMessage !== null,
      );
      if (session === undefined) return false;
      session.lastMessage = null;
      return true;
    },
    () => {
      if (fitted.sessions.length <= 1) return false;
      fitted.sessions.pop();
      fitted.omittedSessions++;
      return true;
    },
    () => {
      if (fitted.handoff.nextSteps.length <= 1) return false;
      fitted.handoff.nextSteps.pop();
      return true;
    },
    () => {
      if (fitted.handoff.blockers.length <= 1) return false;
      fitted.handoff.blockers.pop();
      return true;
    },
    () => {
      const texts = [
        fitted.handoff.goal,
        ...fitted.handoff.nextSteps,
        ...fitted.handoff.blockers,
      ];
      if (
        texts.every((text) => text === null || Buffer.byteLength(text) <= 256)
      )
        return false;
      const cut = (text: string) => truncateBytes(text, 256);
      if (fitted.handoff.goal !== null)
        fitted.handoff.goal = cut(fitted.handoff.goal);
      fitted.handoff.nextSteps = fitted.handoff.nextSteps.map(cut);
      fitted.handoff.blockers = fitted.handoff.blockers.map(cut);
      for (const session of fitted.sessions)
        if (session.lastNote !== null)
          session.lastNote.text = cut(session.lastNote.text);
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
      state = `stopped on ${session.failure ?? "an error"} ${ago(session.lastSeenAt, now)}`;
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
  if (session.task !== null) parts.push(`  task: ${line(session.task)}`);
  if (session.lastNote !== null)
    parts.push(
      `  last note (${session.lastNote.kind}): ${line(session.lastNote.text)}`,
    );
  if (session.lastMessage !== null)
    parts.push(`  last reply: ${line(session.lastMessage)}`);
  return parts.join("\n");
}

/** Plain text for hook context and terminals; it renders the same facts. */
export function renderBriefText(brief: HandoffBriefV1): string {
  const now = brief.generatedAt;
  const out: string[] = ["ReproGate handoff brief"];
  const { handoff, git } = brief;
  out.push(
    "",
    `Handoff (asserted by agents, revision ${String(handoff.revision)}${handoff.updatedAt === null ? "" : `, ${ago(handoff.updatedAt, now)} by ${handoff.activeAgent ?? "unknown"}`}):`,
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
  out.push("", "Git (observed now):");
  if (git.state !== "observed")
    out.push(
      `- ${git.state === "disabled" ? "Observation is turned off." : "Unavailable: not a repository, or Git could not be read safely."}`,
    );
  else {
    out.push(
      `- ${git.detached ? "Detached HEAD" : `Branch ${git.branch ?? "unknown"}`} at ${git.head?.slice(0, 12) ?? "no commit"}${git.upstream === null ? "" : `, ${String(git.ahead ?? 0)} ahead and ${String(git.behind ?? 0)} behind ${git.upstream}`}`,
    );
    if (git.operation !== null)
      out.push(
        `- A ${git.operation.replace("_", "-")} is in progress. Finish or abort it before other work.`,
      );
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
