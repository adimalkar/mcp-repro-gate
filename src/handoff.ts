import { isAbsolute, relative, sep } from "node:path";

import { digestCanonical } from "./digest.js";
import { SqliteExecutionStore } from "./execution-store.js";
import {
  buildBrief,
  fitBrief,
  renderBriefText,
  sessionState,
  sessionView,
} from "./handoff-brief.js";
import {
  HandoffError,
  handoffStatusInputSchema,
  ownHandoffValue,
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
} from "./handoff-observe.js";
import { redactHandoffText } from "./handoff-redact.js";
import {
  DEFAULT_BRIEF_BYTES,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_LEASE_SECONDS,
  HOOK_CONTEXT_CHARS,
  MAX_BRIEF_NOTES,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_BYTES,
  parseHandoffEnd,
  parseHandoffJoin,
  parseHandoffNote,
  printableText,
  type HandoffBriefV1,
  type HandoffClient,
  type HandoffSessionView,
} from "./handoff-session-contract.js";
import type { HandoffSessionRow } from "./handoff-sessions.js";

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

export interface HandoffService {
  readonly config: HandoffConfigV1;
  readonly store: SqliteExecutionStore;
  status(input: unknown): HandoffStatusV1;
  update(input: unknown): HandoffStatusV1;
  join(input: unknown): HandoffJoinResult;
  note(input: unknown): HandoffSessionResult;
  end(input: unknown): HandoffSessionResult;
  brief(budgetBytes?: number): HandoffBriefV1;
  briefText(maxChars?: number): string;
  hook(client: HandoffClient, payload: unknown): HandoffHookResult;
  close(): void;
}
export interface HandoffServiceOptions {
  /** Execution store to share; it must be open on the configured database. */
  store?: SqliteExecutionStore;
  /** Clock for snapshot timestamps; tests inject a deterministic one. */
  now?: () => Date;
}

// Client identifiers are opaque; accept a conservative shape only.
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/u;
function clientId(value: unknown): string | undefined {
  return typeof value === "string" && CLIENT_ID.test(value) ? value : undefined;
}
function agentLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const label = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 64);
  return label === "" ? fallback : label;
}
function shortToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$(?![\s\S])/u.test(value)
    ? value
    : undefined;
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
    const workspaceId = digestCanonical({
      domain: "ReproGate/HandoffWorkspace/v1",
      workspaceRoot: files.workspaceRoot,
    });
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
      const result = redactHandoffText(text);
      return {
        text: printableText(result.text, maxBytes),
        redactions: result.redactions,
      };
    };
    const head = () => (observe ? observeHead(files.workspaceRoot) : null);

    const composeBrief = (exclude?: string): HandoffBriefV1 => {
      const sessions = ledger.sessions(workspaceId);
      // Commits since the newest other session began show what happened
      // after the previous agent started, whatever it recorded.
      const previous = sessions
        .filter(
          (session) =>
            session.sessionId !== exclude && session.startHead !== null,
        )
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      return buildBrief({
        now: now().getTime(),
        liveness,
        latest: contextStore.latestHandoff(workspaceId)?.record,
        sessions,
        lastNotes: ledger.lastNotes(workspaceId),
        notes: ledger.notes(workspaceId, MAX_BRIEF_NOTES + 1, [
          "blocker",
          "decision",
        ]),
        git: observe
          ? observeGit(files.workspaceRoot, previous?.startHead ?? null)
          : emptyGitObservation("disabled"),
      });
    };
    const briefJson = (budget: number, exclude?: string) =>
      fitBrief(composeBrief(exclude), budget, (brief) =>
        Buffer.byteLength(JSON.stringify(brief)),
      );
    const briefText = (maxChars: number, exclude?: string) =>
      renderBriefText(
        fitBrief(
          composeBrief(exclude),
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
        if (latest === undefined) state = "missing";
        else if (documentDigest === latest.projectedDigest)
          state = latest.projected ? "synchronized" : "pending";
        else if (
          !latest.projected &&
          documentDigest === latest.record.expectedDocumentDigest
        )
          state = "pending";
        else state = "drifted";
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
      return {
        handoffVersion: 1,
        state,
        revision: record?.revision ?? 0,
        updateId: record?.updateId ?? null,
        snapshotDigest: latest?.snapshotDigest ?? null,
        projectedDigest: latest?.projectedDigest ?? null,
        documentDigest,
        provenance: "caller_asserted",
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
      };
    };

    // Find a client's session, starting one if its start was never seen:
    // a hook added mid-session, or a start hook that failed.
    const ensureClientSession = (
      client: HandoffClient,
      clientSession: string,
      clientAgent: string,
      agent: string,
      parentSessionId: string | null,
      startHead: () => string | null,
    ): HandoffSessionRow =>
      ledger.find(workspaceId, client, clientSession, clientAgent) ??
      ledger.start(workspaceId, {
        client,
        clientSession,
        clientAgent,
        agent,
        kind: clientAgent === "" ? "agent" : "subagent",
        parentSessionId,
        task: null,
        startHead: startHead(),
        now: now().getTime(),
      }).session;

    // User-level hooks fire in every project; record only this workspace.
    const insideWorkspace = (cwd: unknown): boolean => {
      if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
      try {
        const path = relative(files.workspaceRoot, canonicalHandoffPath(cwd));
        return (
          path === "" ||
          (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        );
      } catch {
        return false;
      }
    };

    const claudeHook = (
      payload: Record<string, unknown>,
    ): HandoffHookResult => {
      const event = payload.hook_event_name;
      const sessionKey = clientId(payload.session_id);
      if (typeof event !== "string" || sessionKey === undefined)
        return { recorded: false };
      const agentKey = clientId(payload.agent_id) ?? "";
      const time = () => now().getTime();
      // Model output is collected only when the host opted in.
      const message = (key: string) => {
        const value = payload[key];
        return capture && typeof value === "string"
          ? redacted(value, MAX_MESSAGE_BYTES)
          : undefined;
      };
      const parent = () =>
        ensureClientSession(
          "claude-code",
          sessionKey,
          "",
          "claude-code",
          null,
          head,
        );
      const current = () =>
        agentKey === ""
          ? parent()
          : ensureClientSession(
              "claude-code",
              sessionKey,
              agentKey,
              agentLabel(payload.agent_type, "subagent"),
              parent().sessionId,
              () => null,
            );
      switch (event) {
        case "SessionStart": {
          const { session } = ledger.start(workspaceId, {
            client: "claude-code",
            clientSession: sessionKey,
            clientAgent: "",
            agent: agentLabel(payload.agent_type, "claude-code"),
            kind: "agent",
            parentSessionId: null,
            task: null,
            startHead: head(),
            now: time(),
          });
          const footer = `\nYour ReproGate handoff session is ${session.sessionId}. Record progress, blockers and decisions with handoff_note, and finish with handoff_end.\n`;
          return {
            recorded: true,
            hookEventName: event,
            additionalContext:
              briefText(HOOK_CONTEXT_CHARS - footer.length, session.sessionId) +
              footer,
          };
        }
        case "SubagentStart": {
          if (agentKey === "") return { recorded: false };
          const owner = parent();
          const session = current();
          // A subagent gets its session and the goal, not the whole brief:
          // twenty subagents must not each pay for it.
          const goal =
            contextStore.latestHandoff(workspaceId)?.record.context.goal;
          return {
            recorded: true,
            hookEventName: event,
            additionalContext: `Your ReproGate handoff session is ${session.sessionId} (a subagent of ${owner.sessionId}). Record progress and blockers with handoff_note; your final reply is recorded when you stop.${goal === undefined ? "" : `\nOverall goal: ${printableText(goal, 1024)}`}\n`,
          };
        }
        case "UserPromptSubmit":
          ledger.touch(workspaceId, current().sessionId, time(), true);
          return { recorded: true };
        case "Stop":
          ledger.touch(
            workspaceId,
            current().sessionId,
            time(),
            false,
            message("last_assistant_message")?.text,
          );
          return { recorded: true };
        case "StopFailure":
          ledger.fail(
            workspaceId,
            current().sessionId,
            shortToken(payload.error) ?? "unknown",
            time(),
          );
          return { recorded: true };
        case "SubagentStop": {
          if (agentKey === "") return { recorded: false };
          const result = message("last_assistant_message");
          ledger.end(
            workspaceId,
            current().sessionId,
            "subagent_stopped",
            time(),
            result === undefined ? {} : { result },
          );
          return { recorded: true };
        }
        case "SessionEnd": {
          const session = ledger.find(
            workspaceId,
            "claude-code",
            sessionKey,
            "",
          );
          if (session === undefined) return { recorded: false };
          const reason = shortToken(payload.reason);
          ledger.end(workspaceId, session.sessionId, "client_ended", time(), {
            ...(reason === undefined ? {} : { clientReason: reason }),
          });
          return { recorded: true };
        }
        default: {
          // PreCompact and any other event: activity only.
          const session = current();
          if (session.endedAt === null)
            ledger.touch(workspaceId, session.sessionId, time());
          return { recorded: true };
        }
      }
    };

    const codexHook = (payload: Record<string, unknown>): HandoffHookResult => {
      const thread = clientId(payload["thread-id"]);
      if (payload.type !== "agent-turn-complete" || thread === undefined)
        return { recorded: false };
      const session = ensureClientSession(
        "codex",
        thread,
        "",
        "codex",
        null,
        head,
      );
      const reply = payload["last-assistant-message"];
      if (session.endedAt === null)
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
          return status({ handoffVersion: 1 });
        } catch (error) {
          throw error instanceof HandoffError
            ? error
            : new HandoffError("unavailable", { cause: error });
        }
      },
      join: (value: unknown) => {
        const input = parseHandoffJoin(value);
        writable();
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
            startHead: head(),
            now: now().getTime(),
          });
          joined.add(session.sessionId);
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
      hook: (client: HandoffClient, payload: unknown) => {
        writable();
        if (
          payload === null ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        )
          return { recorded: false };
        const fields = payload as Record<string, unknown>;
        if (!insideWorkspace(fields.cwd)) return { recorded: false };
        return guard(() =>
          client === "codex" ? codexHook(fields) : claudeHook(fields),
        );
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          if (config.allowUpdates)
            ledger.disconnect(workspaceId, [...joined], now().getTime());
        } catch {
          // Closing must not fail; the sessions will read as interrupted.
        } finally {
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
