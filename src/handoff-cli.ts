import { readSync } from "node:fs";

import {
  createHandoffService,
  workspaceContains,
  type HandoffService,
} from "./handoff.js";
import { HandoffError } from "./handoff-contract.js";
import { loadHandoffConfig } from "./handoff-filesystem.js";
import {
  HOOK_CONTEXT_CHARS,
  MAX_BRIEF_BYTES,
  MIN_BRIEF_BYTES,
} from "./handoff-session-contract.js";

/** Hook payloads larger than this are ignored rather than parsed. */
export const MAX_HOOK_PAYLOAD_BYTES = 1024 * 1024;

export interface HandoffCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Read standard input up to `cap` bytes; undefined when it is larger. */
  stdin?(cap: number): Buffer | undefined;
  /** Clock for session timestamps; tests inject a deterministic one. */
  now?: () => Date;
}

const USAGE =
  "Usage: reprogate handoff hook --config <absolute-path> [--client claude-code|codex] [<codex-notification-json>]\n" +
  "       reprogate handoff brief --config <absolute-path> [--json] [--bytes <n>]\n";

export function readStdin(cap: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    let count: number;
    try {
      count = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EAGAIN")
        continue;
      if (error instanceof Error && "code" in error && error.code === "EOF")
        break;
      throw error;
    }
    if (count === 0) break;
    total += count;
    if (total > cap) return undefined;
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function parseOptions(
  args: readonly string[],
  flags: ReadonlySet<string>,
  valued: ReadonlySet<string>,
): { options: Map<string, string>; positional: string[] } | undefined {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (flags.has(arg) && !options.has(arg)) options.set(arg, "");
    else if (valued.has(arg) && !options.has(arg)) {
      const value = args[++index];
      if (value === undefined) return undefined;
      options.set(arg, value);
    } else if (arg.startsWith("--")) return undefined;
    else positional.push(arg);
  }
  return { options, positional };
}

/**
 * Host-side handoff commands. `hook` records client lifecycle events
 * without a model call, so a session that hits a rate limit or is closed
 * still leaves a trace. It never blocks the client: Claude Code treats exit
 * code 2 as "block", so every `hook` failure, including a usage error,
 * exits 1 (shown, not blocking) or 0. Usage errors in `brief` exit 1 too,
 * since it may also run from a hook.
 */
export function runHandoffCli(
  args: readonly string[],
  io: HandoffCliIo,
): number {
  const [command, ...rest] = args;
  if (command === "hook") {
    const parsed = parseOptions(
      rest,
      new Set(),
      new Set(["--config", "--client"]),
    );
    const client = parsed?.options.get("--client") ?? "claude-code";
    const configPath = parsed?.options.get("--config");
    if (
      parsed === undefined ||
      configPath === undefined ||
      (client !== "claude-code" && client !== "codex") ||
      parsed.positional.length > (client === "codex" ? 1 : 0)
    ) {
      io.stderr(USAGE);
      return 1;
    }
    let service: HandoffService | undefined;
    try {
      // Codex's turn notification arrives as the last argument; hook
      // payloads from Claude Code and Codex arrive on standard input.
      const argument = parsed.positional[0];
      const raw =
        argument === undefined
          ? io.stdin?.(MAX_HOOK_PAYLOAD_BYTES)
          : Buffer.from(argument);
      if (raw === undefined || raw.length > MAX_HOOK_PAYLOAD_BYTES) {
        io.stderr("reprogate handoff hook: payload_too_large\n");
        return 0;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      } catch {
        io.stderr("reprogate handoff hook: invalid_payload\n");
        return 0;
      }
      const config = loadHandoffConfig(configPath);
      // Hooks set for every project return here, before the database is
      // opened or locked.
      if (
        payload === null ||
        typeof payload !== "object" ||
        !workspaceContains(
          config.workspaceRoot,
          (payload as { cwd?: unknown }).cwd,
        )
      )
        return 0;
      service = createHandoffService(
        config,
        io.now === undefined ? {} : { now: io.now },
      );
      const result = service.hook(client, payload);
      if (
        result.additionalContext !== undefined &&
        result.hookEventName !== undefined
      )
        io.stdout(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: result.hookEventName,
              additionalContext: result.additionalContext,
            },
          })}\n`,
        );
      return 0;
    } catch (error) {
      io.stderr(
        `reprogate handoff hook: ${error instanceof HandoffError ? error.code : "unavailable"}\n`,
      );
      return 1;
    } finally {
      service?.close();
    }
  }
  if (command === "brief") {
    const parsed = parseOptions(
      rest,
      new Set(["--json"]),
      new Set(["--config", "--bytes"]),
    );
    const configPath = parsed?.options.get("--config");
    const bytesText = parsed?.options.get("--bytes");
    const bytes = bytesText === undefined ? undefined : Number(bytesText);
    if (
      parsed === undefined ||
      configPath === undefined ||
      parsed.positional.length > 0 ||
      (bytes !== undefined &&
        (!Number.isSafeInteger(bytes) ||
          bytes < MIN_BRIEF_BYTES ||
          bytes > MAX_BRIEF_BYTES))
    ) {
      io.stderr(USAGE);
      return 1;
    }
    let service: HandoffService | undefined;
    try {
      service = createHandoffService(
        loadHandoffConfig(configPath),
        io.now === undefined ? {} : { now: io.now },
      );
      io.stdout(
        parsed.options.has("--json")
          ? `${JSON.stringify(service.brief(bytes))}\n`
          : service.briefText(bytes ?? HOOK_CONTEXT_CHARS),
      );
      return 0;
    } catch (error) {
      io.stderr(
        `reprogate handoff brief: ${error instanceof HandoffError ? error.code : "unavailable"}\n`,
      );
      return 1;
    } finally {
      service?.close();
    }
  }
  io.stderr(USAGE);
  return 1;
}
