import { isAbsolute, relative, sep } from "node:path";

import { digestCanonical } from "./digest.js";
import { SqliteExecutionStore } from "./execution-store.js";
import { extractDocument, type ExtractedDocument } from "./handoff-adopt.js";
import {
  buildBrief,
  buildLane,
  fitBrief,
  fitLane,
  renderBriefText,
  sessionState,
  sessionView,
  worktreeName,
} from "./handoff-brief.js";
import {
  HandoffError,
  handoffStatusInputSchema,
  ownHandoffValue,
  parseHandoffAdopt,
  parseHandoffConfig,
  parseHandoffUpdate,
  renderHandoffRecord,
  type HandoffConfigV1,
  type HandoffStatusV1,
} from "./handoff-contract.js";
import {
  canonicalHandoffPath,
  HandoffFiles,
  prepareHandoffDatabase,
} from "./handoff-filesystem.js";
import {
  emptyGitObservation,
  observeGit,
  observeHead,
  repositoryIdentity,
} from "./handoff-observe.js";
import { redactHandoffText } from "./handoff-redact.js";
import {
  DEFAULT_BRIEF_BYTES,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_PROJECTION_INTERVAL_SECONDS,
  HANDOFF_SESSIONS_FILE_STATES,
  MAX_LANE_NOTES,
  MAX_SESSIONS_FILE_CHARS,
  HOOK_CONTEXT_CHARS,
  MAX_BRIEF_NOTES,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_BYTES,
  parseHandoffEnd,
  parseHandoffJoin,
  parseHandoffNote,
  printableText,
  truncateBytes,
  type HandoffBriefV1,
  type HandoffClient,
  type HandoffDocumentState,
  type HandoffSessionView,
} from "./handoff-session-contract.js";
import type { HandoffSessionRow } from "./handoff-sessions.js";

// Hook events written to the sessions file at once; others are coalesced.
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "SessionEnd",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
]);

export interface HandoffJoinResult {
  handoffVersion: 1;
  sessionId: string;
  leaseSeconds: number;
  brief: HandoffBriefV1;
}
export interface HandoffSessionResult {
  handoffVersion: 1;
  session: HandoffSessionView;
  redactions: number;
}
/** What a client hook prints back, if anything. */
export interface HandoffHookResult {
  recorded: boolean;
  hookEventName?: string;
  additionalContext?: string;
}

/** What adopting the current document would record; nothing is written. */
export interface HandoffAdoptionPreview {
  state: HandoffStatusV1["state"];
  revision: number;
  documentDigest: string | null;
  extracted: ExtractedDocument | null;
}

export interface HandoffService {
  readonly config: HandoffConfigV1;
  readonly store: SqliteExecutionStore;
  status(input: unknown): HandoffStatusV1;
  update(input: unknown): HandoffStatusV1;
  adopt(input: unknown): HandoffStatusV1;
  previewAdoption(): HandoffAdoptionPreview;
  join(input: unknown): HandoffJoinResult;
  note(input: unknown): HandoffSessionResult;
  end(input: unknown): HandoffSessionResult;
  brief(budgetBytes?: number): HandoffBriefV1;
  briefText(maxChars?: number): string;
  hook(client: "claude-code" | "codex", payload: unknown): HandoffHookResult;
  close(): void;
}
export interface HandoffServiceOptions {
  /** Execution store to share; it must be open on the configured database. */
  store?: SqliteExecutionStore;
  /** Clock for snapshot timestamps; tests inject a deterministic one. */
  now?: () => Date;
  /**
   * Whether a coalesced sessions-file write is retried by a timer. Long
   * running servers keep it; one-shot hook commands turn it off.
   */
  deferProjection?: boolean;
  /**
   * The directory this process works in. In repository scope it selects the
   * worktree whose Git state a brief reads; the process's own by default.
   */
  cwd?: string;
}

// Client identifiers are opaque; accept a conservative shape only.
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/u;
function clientId(value: unknown): string | undefined {
  return typeof value === "string" && CLIENT_ID.test(value) ? value : undefined;
}
// Hook-supplied labels and tokens are stored and shown; one that looks
// like a credential is replaced rather than redacted in place.
function agentLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const label = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 64);
  return label === "" || redactHandoffText(label).redactions > 0
    ? fallback
    : label;
}
function shortToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$(?![\s\S])/u.test(value) &&
    redactHandoffText(value).redactions === 0
    ? value
    : undefined;
}
/** Captured model text is cut before redaction, so redaction stays fast. */
const MAX_REDACTED_INPUT_BYTES = 16 * 1024;

/**
 * Whether `cwd` lies inside the workspace. User-level hooks fire in every
 * project, so the hook command checks this before opening the database.
 */
export function workspaceContains(
  workspaceRoot: string,
  cwd: unknown,
): boolean {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
  try {
    const path = relative(
      canonicalHandoffPath(workspaceRoot),
      canonicalHandoffPath(cwd),
    );
    return (
      path === "" ||
      (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    );
  } catch {
    return false;
  }
}

/**
 * Whether a hook event from `cwd` belongs to this configuration: inside the
 * workspace, or in repository scope any worktree of the same repository.
 * Checked before the database is opened. Only repository scope runs Git.
 */
export function workspaceAccepts(
  config: HandoffConfigV1,
  cwd: unknown,
): boolean {
  if (workspaceContains(config.workspaceRoot, cwd)) return true;
  if (
    config.scope !== "repository" ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd)
  )
    return false;
  const event = repositoryIdentity(cwd);
  return (
    event !== undefined &&
    event.commonDir === repositoryIdentity(config.workspaceRoot)?.commonDir
  );
}

export interface ProjectionSteps<Prepared> {
  /** A generation to write, or undefined when the write is coalesced. */
  claim(force: boolean): number | undefined;
  prepare(): Prepared;
  /** Rename and confirm together; false when a later claim overtook it. */
  commit(generation: number, prepared: Prepared): boolean;
  discard(prepared: Prepared): void;
}

/**
 * Write a generated file, retrying from fresh state when a later claim
 * overtakes the write, a few times at most. "deferred" means the write was
 * coalesced; "overtaken" means every attempt lost, and the file stays
 * pending for the next writer.
 */
export function writeProjection<Prepared>(
  steps: ProjectionSteps<Prepared>,
  force: boolean,
  attempts = 3,
): "written" | "deferred" | "overtaken" {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const generation = steps.claim(force || attempt > 0);
    if (generation === undefined) return "deferred";
    const prepared = steps.prepare();
    let committed = false;
    try {
      committed = steps.commit(generation, prepared);
    } finally {
      if (!committed) steps.discard(prepared);
    }
    if (committed) return "written";
  }
  return "overtaken";
}

export function createHandoffService(
  value: unknown,
  options: HandoffServiceOptions = {},
): HandoffService {
  const sharedStore = options.store;
  const now = options.now ?? (() => new Date());
  const config = parseHandoffConfig(value);
  const sessionsConfig = config.sessions ?? {};
  const liveness = {
    leaseMs: (sessionsConfig.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000,
    graceMs: (sessionsConfig.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000,
  };
  const observe = sessionsConfig.observeGit ?? true;
  const capture = sessionsConfig.captureMessages ?? false;
  const projectFile =
    config.allowUpdates && (sessionsConfig.projectFile ?? true);
  const projectionIntervalMs =
    (sessionsConfig.projectionIntervalSeconds ??
      DEFAULT_PROJECTION_INTERVAL_SECONDS) * 1000;
  const deferProjection = options.deferProjection ?? true;
  let store: SqliteExecutionStore | undefined;
  const ownsStore = sharedStore === undefined;
  try {
    const files = new HandoffFiles(config.workspaceRoot);
    files.assertDatabaseOutsideProjection(config.databasePath);
    const binding = prepareHandoffDatabase(config.databasePath);
    files.assertDatabaseOutsideProjection(binding.path);
    store = sharedStore ?? new SqliteExecutionStore(binding.path);
    store.initializeHandoff(binding);
    const contextStore = store;
    const instanceId = contextStore.handoffInstance();
    // Asking for repository scope and silently getting a per-workspace
    // ledger would split the history, so a failure here is fatal.
    const repository =
      config.scope === "repository"
        ? repositoryIdentity(files.workspaceRoot)
        : undefined;
    if (config.scope === "repository" && repository === undefined)
      throw new HandoffError("unavailable");
    const workspaceId = digestCanonical(
      repository === undefined
        ? {
            domain: "ReproGate/HandoffWorkspace/v1",
            workspaceRoot: files.workspaceRoot,
          }
        : {
            domain: "ReproGate/HandoffRepository/v1",
            commonDirectory: repository.commonDir,
          },
    );
    // The worktree of a path: any worktree of the repository in repository
    // scope, or the workspace for a path inside it.
    const worktreeFor = (cwd: unknown): string | undefined => {
      if (
        repository !== undefined &&
        typeof cwd === "string" &&
        isAbsolute(cwd)
      ) {
        const identity = repositoryIdentity(cwd);
        if (identity?.commonDir === repository.commonDir)
          return identity.worktree;
      }
      return workspaceContains(files.workspaceRoot, cwd)
        ? files.workspaceRoot
        : undefined;
    };
    const ownWorktree =
      worktreeFor(options.cwd ?? process.cwd()) ?? files.workspaceRoot;
    const recordedWorktree = (worktree: string) =>
      repository === undefined ? null : worktree;
    const ledger = contextStore.handoffSessions();
    // Sessions joined through this service; a closing connection ends them.
    const joined = new Set<string>();
    let closed = false;
    const live = () => {
      if (closed) throw new HandoffError("unavailable");
    };
    const writable = () => {
      live();
      if (!config.allowUpdates) throw new HandoffError("read_only");
    };
    const guard = <T>(operation: () => T): T => {
      try {
        binding.verify();
        return operation();
      } catch (error) {
        throw error instanceof HandoffError
          ? error
          : new HandoffError("unavailable", { cause: error });
      }
    };
    const redacted = (text: string, maxBytes: number) => {
      const result = redactHandoffText(
        truncateBytes(text, MAX_REDACTED_INPUT_BYTES),
      );
      return {
        text: printableText(result.text, maxBytes),
        redactions: result.redactions,
      };
    };
    const head = (worktree: string) => (observe ? observeHead(worktree) : null);

    type LatestHandoff = ReturnType<SqliteExecutionStore["latestHandoff"]>;
    // How a document on disk relates to a recorded revision.
    const documentRelation = (
      latest: NonNullable<LatestHandoff>,
      digest: string | null,
    ): "synchronized" | "pending" | "drifted" => {
      if (digest === latest.projectedDigest)
        return latest.projected ? "synchronized" : "pending";
      return !latest.projected &&
        digest === latest.record.expectedDocumentDigest
        ? "pending"
        : "drifted";
    };
    const documentState = (latest: LatestHandoff): HandoffDocumentState => {
      try {
        const { digest } = files.document();
        if (latest === undefined) return digest === null ? "none" : "untracked";
        const relation = documentRelation(latest, digest);
        return relation === "drifted" && digest === null ? "deleted" : relation;
      } catch {
        return "unavailable";
      }
    };

    const composeBrief = (
      exclude?: string,
      withGit = observe,
      worktree = ownWorktree,
    ): HandoffBriefV1 => {
      const sessions = ledger.sessions(workspaceId);
      const time = now().getTime();
      // Commits since the oldest unfinished agent session began cover the
      // work of every agent that may have stopped mid-task, whatever it
      // recorded. Idle sessions never age, so they do not count; with none
      // unfinished, the newest other session is used.
      // Subagents start from their parent's state, so they are skipped, and
      // a commit range only means something within one worktree's history.
      const candidates = sessions.filter(
        (session) =>
          session.sessionId !== exclude &&
          session.kind === "agent" &&
          session.startHead !== null &&
          (repository === undefined || session.worktree === worktree),
      );
      const unfinished = candidates
        .filter((session) =>
          ["failed", "interrupted", "quiet", "active"].includes(
            sessionState(session, time, liveness),
          ),
        )
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      const previous =
        unfinished ??
        [...candidates].sort((a, b) => b.startedAt - a.startedAt)[0];
      const latest = contextStore.latestHandoff(workspaceId);
      return buildBrief({
        now: time,
        liveness,
        latest: latest?.record,
        document: documentState(latest),
        sessions,
        lastNotes: ledger.lastNotes(workspaceId),
        notes: ledger.notes(workspaceId, MAX_BRIEF_NOTES + 1, [
          "blocker",
          "decision",
        ]),
        git: withGit
          ? {
              ...observeGit(worktree, previous?.startHead ?? null),
              worktree:
                repository === undefined ? null : worktreeName(worktree),
            }
          : emptyGitObservation("disabled"),
      });
    };

    // The generated sessions file: the brief without Git state, every line
    // indented as a code block so caller text cannot render as Markdown.
    const sessionsDocument = (): Buffer => {
      const generatedAt = now().toISOString();
      const header = [
        "# Agent Sessions",
        "",
        `Generated by ReproGate at ${generatedAt} from observed session events and caller-asserted notes. It is rewritten on session events; do not edit it. States are as of that time. For live states and the workspace Git state, run \`reprogate handoff brief\` or call \`handoff_status\` with \`brief: true\`.`,
        "",
        "",
      ].join("\n");
      const indent = (text: string) =>
        text
          .replace(/\n$/u, "")
          .split("\n")
          .map((line) => (line === "" ? "" : `    ${line}`))
          .join("\n");
      const render = (brief: HandoffBriefV1) =>
        indent(renderBriefText(brief, { includeGit: false }));
      const fitted = fitBrief(
        composeBrief(undefined, false),
        MAX_SESSIONS_FILE_CHARS - header.length,
        (brief) => render(brief).length,
      );
      return Buffer.from(`${header}${render(fitted)}\n`);
    };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const deferFlush = () => {
      if (!deferProjection || flushTimer !== undefined) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        projectSessions(true);
      }, projectionIntervalMs);
      flushTimer.unref();
    };
    // Rewrite the sessions file now, or mark it dirty when a write happened
    // within the interval. A failed write never fails the event that
    // caused it: the database is the record.
    const projectSessions = (force: boolean): void => {
      if (!projectFile || closed) return;
      try {
        const outcome = writeProjection(
          {
            claim: (forced) =>
              ledger.claimProjection(
                workspaceId,
                now().getTime(),
                projectionIntervalMs,
                forced,
              ),
            prepare: () => {
              binding.verify();
              return files.prepareGenerated("sessions.md", sessionsDocument());
            },
            commit: (generation, prepared) =>
              ledger.commitProjection(workspaceId, generation, () => {
                files.commitGenerated(prepared);
              }),
            discard: (prepared) => {
              files.discardGenerated(prepared);
            },
          },
          force,
        );
        if (outcome === "written") files.syncGenerated();
        else deferFlush();
      } catch {
        try {
          ledger.failProjection(workspaceId);
        } catch {
          // The status read will report the file as unavailable.
        }
      }
    };
    const briefJson = (budget: number, exclude?: string) =>
      fitBrief(composeBrief(exclude), budget, (brief) =>
        Buffer.byteLength(JSON.stringify(brief)),
      );
    const briefText = (maxChars: number, exclude?: string, worktree?: string) =>
      renderBriefText(
        fitBrief(
          composeBrief(exclude, observe, worktree),
          maxChars,
          (brief) => renderBriefText(brief).length,
        ),
      );
    const view = (session: HandoffSessionRow) =>
      sessionView(
        session,
        sessionState(session, now().getTime(), liveness),
        ledger.lastNotes(workspaceId).get(session.sessionId),
      );

    const status = (value: unknown): HandoffStatusV1 => {
      const input = handoffStatusInputSchema.safeParse(ownHandoffValue(value));
      if (!input.success) throw new HandoffError("invalid_input");
      if (closed) throw new HandoffError("unavailable");
      let latest: ReturnType<SqliteExecutionStore["latestHandoff"]>;
      let documentDigest: string | null = null;
      let state: HandoffStatusV1["state"];
      try {
        binding.verify();
        latest = contextStore.latestHandoff(workspaceId);
        documentDigest = files.document().digest;
        state =
          latest === undefined
            ? "missing"
            : documentRelation(latest, documentDigest);
      } catch {
        state = "unavailable";
        latest = undefined;
      }
      const record = latest?.record;
      // A drifted or missing document must not hide the sessions and the
      // observed Git state; only an unusable database does.
      const brief =
        input.data.brief === true && state !== "unavailable"
          ? guard(() => briefJson(input.data.briefBytes ?? DEFAULT_BRIEF_BYTES))
          : undefined;
      const sessionId = input.data.sessionId;
      const lane =
        sessionId === undefined
          ? undefined
          : guard(() => {
              const session = ledger.get(workspaceId, sessionId);
              return fitLane(
                buildLane({
                  now: now().getTime(),
                  liveness,
                  session,
                  notes: ledger.sessionNotes(
                    workspaceId,
                    sessionId,
                    MAX_LANE_NOTES,
                  ),
                  subagents: ledger.subagentsOf(workspaceId, sessionId),
                  workspace: ledger.sessions(workspaceId),
                  lastNotes: ledger.lastNotes(workspaceId),
                }),
                input.data.briefBytes ?? DEFAULT_BRIEF_BYTES,
                (value) => Buffer.byteLength(JSON.stringify(value)),
              );
            });
      let sessionsFile: (typeof HANDOFF_SESSIONS_FILE_STATES)[number];
      if (!projectFile) sessionsFile = "disabled";
      else {
        try {
          sessionsFile = ledger.projectionState(workspaceId) ?? "pending";
        } catch {
          sessionsFile = "unavailable";
        }
      }
      return {
        handoffVersion: 1,
        state,
        revision: record?.revision ?? 0,
        updateId: record?.updateId ?? null,
        snapshotDigest: latest?.snapshotDigest ?? null,
        projectedDigest: latest?.projectedDigest ?? null,
        documentDigest,
        provenance: record?.provenance ?? "caller_asserted",
        counts: {
          completed: record?.context.completed.length ?? 0,
          touchedFiles: record?.context.touchedFiles.length ?? 0,
          blockers: record?.context.blockers.length ?? 0,
          nextSteps: record?.context.nextSteps.length ?? 0,
          references: record?.references.length ?? 0,
        },
        ...(input.data.includeContext === true && record !== undefined
          ? { context: record.context, references: record.references }
          : {}),
        ...(brief === undefined ? {} : { brief }),
        ...(lane === undefined ? {} : { lane }),
        sessionsFile,
      };
    };

    // A client's main session, created if its start was never seen (a hook
    // added mid-session, or a start hook that failed). `revive` reopens an
    // ended session: a client that starts or prompts it is using it again.
    const mainSession = (
      client: HandoffClient,
      clientSession: string,
      agent: string,
      revive: boolean,
      worktree: string,
    ): HandoffSessionRow => {
      const found = ledger.find(workspaceId, client, clientSession, "");
      if (found !== undefined && (found.endedAt === null || !revive))
        return found;
      return ledger.start(workspaceId, {
        client,
        clientSession,
        clientAgent: "",
        agent,
        kind: "agent",
        parentSessionId: null,
        task: null,
        startHead: found === undefined ? head(worktree) : null,
        worktree: recordedWorktree(worktree),
        now: now().getTime(),
      }).session;
    };

    const lifecycleHook = (
      client: "claude-code" | "codex",
      payload: Record<string, unknown>,
      worktree: string,
    ): HandoffHookResult => {
      const event = payload.hook_event_name;
      const sessionKey = clientId(payload.session_id);
      if (typeof event !== "string" || sessionKey === undefined)
        return { recorded: false };
      const agentKey = clientId(payload.agent_id) ?? "";
      const agentType =
        typeof payload.agent_type === "string" ? payload.agent_type : "";
      const time = () => now().getTime();
      // Model output is collected only when the host opted in.
      const message = (key: string) => {
        const value = payload[key];
        return capture && typeof value === "string"
          ? redacted(value, MAX_MESSAGE_BYTES)
          : undefined;
      };
      const main = (revive: boolean) =>
        mainSession(client, sessionKey, client, revive, worktree);
      // A subagent's session. Only SubagentStart creates one: Claude Code
      // also reports internal agents (prompt suggestions, /btw) that never
      // started, and those must not become sessions.
      const subagent = (create: boolean): HandoffSessionRow | undefined => {
        const found = ledger.find(workspaceId, client, sessionKey, agentKey);
        if (!create || found?.endedAt === null) return found;
        return ledger.start(workspaceId, {
          client,
          clientSession: sessionKey,
          clientAgent: agentKey,
          agent: agentLabel(agentType, "subagent"),
          kind: "subagent",
          parentSessionId: main(true).sessionId,
          task: null,
          startHead: null,
          worktree: recordedWorktree(worktree),
          now: time(),
        }).session;
      };
      // The session an ordinary event belongs to, or none to record.
      const target = (revive: boolean) => {
        const session = agentKey === "" ? main(revive) : subagent(false);
        return session === undefined || (session.endedAt !== null && !revive)
          ? undefined
          : session;
      };
      switch (event) {
        case "SessionStart": {
          const session = main(true);
          const footer = `\nYour ReproGate handoff session is ${session.sessionId}. Record progress, blockers and decisions with handoff_note, and finish with handoff_end.\n`;
          return {
            recorded: true,
            hookEventName: event,
            additionalContext:
              briefText(
                HOOK_CONTEXT_CHARS - footer.length,
                session.sessionId,
                worktree,
              ) + footer,
          };
        }
        case "SubagentStart": {
          if (agentKey === "" || agentType === "") return { recorded: false };
          const session = subagent(true);
          if (session === undefined) return { recorded: false };
          // A subagent gets its session and the goal, not the whole brief:
          // twenty subagents must not each pay for it.
          const goal =
            contextStore.latestHandoff(workspaceId)?.record.context.goal;
          return {
            recorded: true,
            hookEventName: event,
            additionalContext: `Your ReproGate handoff session is ${session.sessionId} (a subagent of ${session.parentSessionId ?? "an unknown session"}). Record progress and blockers with handoff_note; your final reply is recorded when you stop.${goal === undefined ? "" : `\nOverall goal: ${printableText(goal, 1024)}`}\n`,
          };
        }
        case "UserPromptSubmit": {
          const session = target(true);
          if (session === undefined) return { recorded: false };
          ledger.touch(workspaceId, session.sessionId, time(), true);
          return { recorded: true };
        }
        case "Stop":
        case "Interrupt": {
          // Codex reports a user interrupt; either way the turn is over.
          const session = target(false);
          if (session === undefined) return { recorded: false };
          ledger.touch(
            workspaceId,
            session.sessionId,
            time(),
            false,
            event === "Stop"
              ? message("last_assistant_message")?.text
              : undefined,
          );
          return { recorded: true };
        }
        case "StopFailure": {
          const session = agentKey === "" ? main(false) : subagent(false);
          if (session === undefined) return { recorded: false };
          ledger.fail(
            workspaceId,
            session.sessionId,
            shortToken(payload.error) ?? "unknown",
            time(),
          );
          return { recorded: true };
        }
        case "SubagentStop": {
          const session = agentKey === "" ? undefined : subagent(false);
          if (session === undefined) return { recorded: false };
          const result = message("last_assistant_message");
          ledger.end(
            workspaceId,
            session.sessionId,
            "subagent_stopped",
            time(),
            result === undefined ? {} : { result },
          );
          return { recorded: true };
        }
        case "SessionEnd": {
          const session = ledger.find(workspaceId, client, sessionKey, "");
          if (session === undefined) return { recorded: false };
          const reason = shortToken(payload.reason);
          ledger.end(workspaceId, session.sessionId, "client_ended", time(), {
            ...(reason === undefined ? {} : { clientReason: reason }),
          });
          return { recorded: true };
        }
        default: {
          // PreCompact and any other event: activity only.
          const session = target(false);
          if (session === undefined) return { recorded: false };
          ledger.touch(workspaceId, session.sessionId, time());
          return { recorded: true };
        }
      }
    };

    // Codex's turn notification, passed as the last command argument.
    const codexNotify = (
      payload: Record<string, unknown>,
      worktree: string,
    ): HandoffHookResult => {
      const thread = clientId(payload["thread-id"]);
      if (thread === undefined) return { recorded: false };
      // A late notification must not reopen a session that already ended.
      const session = mainSession("codex", thread, "codex", false, worktree);
      if (session.endedAt !== null) return { recorded: false };
      const reply = payload["last-assistant-message"];
      ledger.touch(
        workspaceId,
        session.sessionId,
        now().getTime(),
        false,
        capture && typeof reply === "string"
          ? redacted(reply, MAX_MESSAGE_BYTES).text
          : undefined,
      );
      return { recorded: true };
    };

    return {
      config,
      store: contextStore,
      status,
      update: (value: unknown) => {
        const input = parseHandoffUpdate(value);
        if (closed) throw new HandoffError("unavailable");
        if (!config.allowUpdates) throw new HandoffError("read_only");
        try {
          binding.verify();
          const record = contextStore.reserveHandoff(
            workspaceId,
            input,
            () => files.document().digest,
            now(),
          );
          contextStore.projectHandoff(workspaceId, record.updateId, (owned) => {
            binding.verify();
            files.project(
              instanceId,
              owned.revision,
              owned.updateId,
              owned.expectedDocumentDigest,
              renderHandoffRecord(owned),
            );
          });
          projectSessions(true);
          return status({ handoffVersion: 1 });
        } catch (error) {
          throw error instanceof HandoffError
            ? error
            : new HandoffError("unavailable", { cause: error });
        }
      },
      adopt: (value: unknown) => {
        const input = parseHandoffAdopt(value);
        writable();
        if (
          input.agent !== undefined &&
          redactHandoffText(input.agent).redactions > 0
        )
          throw new HandoffError("invalid_input");
        return guard(() => {
          contextStore.adoptHandoff(
            workspaceId,
            input,
            () => {
              const document = files.document();
              return {
                digest: document.digest,
                context: () =>
                  extractDocument(
                    document.bytes ?? Buffer.alloc(0),
                    input.agent,
                  ).context,
              };
            },
            now(),
          );
          projectSessions(true);
          return status({ handoffVersion: 1 });
        });
      },
      previewAdoption: () => {
        live();
        return guard(() => {
          const { state, revision } = status({ handoffVersion: 1 });
          const document = files.document();
          return {
            state,
            revision,
            documentDigest: document.digest,
            extracted:
              document.bytes === null ? null : extractDocument(document.bytes),
          };
        });
      },
      join: (value: unknown) => {
        const input = parseHandoffJoin(value);
        writable();
        if (redactHandoffText(input.agent).redactions > 0)
          throw new HandoffError("invalid_input");
        return guard(() => {
          const { session } = ledger.start(workspaceId, {
            client: "mcp",
            clientSession: "",
            clientAgent: "",
            agent: input.agent,
            kind:
              input.kind ??
              (input.parentSessionId === undefined ? "agent" : "subagent"),
            parentSessionId: input.parentSessionId ?? null,
            task:
              input.task === undefined ? null : redacted(input.task, 512).text,
            startHead: head(ownWorktree),
            worktree: recordedWorktree(ownWorktree),
            now: now().getTime(),
          });
          joined.add(session.sessionId);
          projectSessions(true);
          return {
            handoffVersion: 1 as const,
            sessionId: session.sessionId,
            leaseSeconds: liveness.leaseMs / 1000,
            brief: briefJson(
              input.briefBytes ?? DEFAULT_BRIEF_BYTES,
              session.sessionId,
            ),
          };
        });
      },
      note: (value: unknown) => {
        const input = parseHandoffNote(value);
        writable();
        return guard(() => {
          const note = redacted(input.text, MAX_NOTE_BYTES);
          const session = ledger.note(
            workspaceId,
            input.sessionId,
            input.kind,
            note.text,
            note.redactions,
            now().getTime(),
          );
          projectSessions(false);
          return {
            handoffVersion: 1 as const,
            session: view(session),
            redactions: note.redactions,
          };
        });
      },
      end: (value: unknown) => {
        const input = parseHandoffEnd(value);
        writable();
        return guard(() => {
          const summary =
            input.summary === undefined
              ? undefined
              : redacted(input.summary, MAX_NOTE_BYTES);
          const session = ledger.end(
            workspaceId,
            input.sessionId,
            "completed",
            now().getTime(),
            summary === undefined ? {} : { result: summary },
          );
          joined.delete(input.sessionId);
          projectSessions(true);
          return {
            handoffVersion: 1 as const,
            session: view(session),
            redactions: summary?.redactions ?? 0,
          };
        });
      },
      brief: (budgetBytes = DEFAULT_BRIEF_BYTES) => {
        live();
        return guard(() => briefJson(budgetBytes));
      },
      briefText: (maxChars = HOOK_CONTEXT_CHARS) => {
        live();
        return guard(() => briefText(maxChars));
      },
      hook: (client: "claude-code" | "codex", payload: unknown) => {
        writable();
        if (
          payload === null ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        )
          return { recorded: false };
        const fields = payload as Record<string, unknown>;
        const worktree = worktreeFor(fields.cwd);
        if (worktree === undefined) return { recorded: false };
        return guard(() => {
          const result =
            client === "codex" && fields.type === "agent-turn-complete"
              ? codexNotify(fields, worktree)
              : lifecycleHook(client, fields, worktree);
          // Turn and activity events are frequent, so they are coalesced;
          // starts, ends and failures are written at once.
          if (result.recorded)
            projectSessions(
              typeof fields.hook_event_name === "string" &&
                LIFECYCLE_EVENTS.has(fields.hook_event_name),
            );
          return result;
        });
      },
      close: () => {
        if (closed) return;
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        try {
          if (config.allowUpdates) {
            const ended = joined.size > 0;
            ledger.disconnect(workspaceId, [...joined], now().getTime());
            // Write the ends, and in a long-running server a write still
            // pending from the interval. A one-shot hook leaves a pending
            // write to the next event, or coalescing would never apply.
            if (
              ended ||
              (deferProjection &&
                ledger.projectionState(workspaceId) === "pending")
            )
              projectSessions(true);
          }
        } catch {
          // Closing must not fail; the sessions will read as interrupted.
        } finally {
          closed = true;
          if (ownsStore) contextStore.close();
        }
      },
    };
  } catch (error) {
    if (ownsStore) store?.close();
    throw error instanceof HandoffError
      ? error
      : new HandoffError("unavailable", { cause: error });
  }
}
