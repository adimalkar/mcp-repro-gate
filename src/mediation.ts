import * as z from "zod/v4";

import { issueCapabilityToken } from "./capability-token.js";
import type { ReproGateExecutor } from "./executor.js";
import type { ReproGateKernel } from "./kernel.js";
import type { EffectClass } from "./types.js";

export const MEDIATED_EFFECTS = ["local_read", "network_read"] as const;
export const DEFAULT_MAX_TEXT_BYTES = 16 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_RUNS_PER_PLAN = 1000;
export const REDACTED = "[REDACTED]";
/** Secret fragments at least this long are redacted wherever they appear. */
export const SECRET_FRAGMENT_LENGTH = 12;
export const DEFAULT_STRIKE_LIMIT = 2;
export const MAX_STRIKE_LIMIT = 5;
const MAX_ERROR_BYTES = 1024;

// Capability tokens have this shape; a downstream echo must never reach
// the model, whichever secret signed it.
const CAPABILITY_TOKEN = /rg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu;

// A usable pattern compiles and cannot match the empty string, which would
// otherwise insert a marker between every character.
function usablePattern(pattern: string): boolean {
  try {
    return !new RegExp(pattern, "u").test("");
  } catch {
    return false;
  }
}

export const mediationConfigSchema = z
  .object({
    effects: z
      .array(z.enum(MEDIATED_EFFECTS))
      .min(1)
      .refine((effects) => new Set(effects).size === effects.length),
    maxRunsPerPlan: z.number().int().min(1).max(MAX_RUNS_PER_PLAN).optional(),
    result: z
      .object({
        maxTextBytes: z.number().int().min(256).max(MAX_TEXT_BYTES).optional(),
        redactPatterns: z
          .array(z.string().min(1).max(256).refine(usablePattern))
          .max(16)
          .optional(),
      })
      .strict()
      .optional(),
    strikes: z
      .object({
        resolverToolRef: z.string().min(1).max(256),
        limit: z
          .number()
          .int()
          .min(DEFAULT_STRIKE_LIMIT)
          .max(MAX_STRIKE_LIMIT)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type MediationConfigV1 = z.infer<typeof mediationConfigSchema>;

export type MediationRefusal =
  | "unknown_action"
  | "not_allowed"
  | "effect_not_mediated"
  | "stale_plan"
  | "expired"
  | "run_limit"
  | "resolve_required";

/** Consecutive failures of one tool, and how to unblock it. */
export interface StrikeState {
  failures: number;
  limit: number;
  resolverToolRef: string;
}

export class MediationError extends Error {
  constructor(
    readonly code: MediationRefusal,
    readonly strikes?: StrikeState,
  ) {
    super(`Host mediation refused: ${code}`);
    this.name = "MediationError";
  }
}

/**
 * An executor error during a gated run, with the strike count it caused.
 * The message is the executor's own, so callers redact it as before.
 */
export class StrikeCountedError extends Error {
  constructor(
    readonly error: unknown,
    readonly strikes: StrikeState,
  ) {
    super(error instanceof Error ? error.message : "Unknown execution error", {
      cause: error,
    });
    this.name = "StrikeCountedError";
  }
}

export interface BoundedContent {
  content: { type: "text"; text: string }[];
  truncated: boolean;
  redactions: number;
  omittedItems: number;
}

export interface MediatedRunResult extends BoundedContent {
  executionId: string;
  outcome: "succeeded" | "failed";
  receiptDigest: string;
  resultDigest: string;
  /** Present on failed runs when the strike gate is configured. */
  strikes?: StrikeState;
}

// One downstream tool, whichever plan or arguments ran it.
function toolKey(tool: { serverRef: string; toolName: string }): string {
  return `${tool.serverRef}\u0000${tool.toolName}`;
}

// Cut at a UTF-8 boundary so the bound never splits a character.
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

// Every window of SECRET_FRAGMENT_LENGTH characters of each secret, in its
// raw and JSON-escaped spelling, so partial, split or escaped copies are
// caught. Shorter fragments cannot be distinguished from ordinary text.
function secretFragments(secrets: readonly string[]): string[] {
  const fragments = new Set<string>();
  for (const secret of secrets) {
    for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) {
      if (form.length <= SECRET_FRAGMENT_LENGTH) {
        if (form.length > 0) fragments.add(form);
        continue;
      }
      for (
        let start = 0;
        start + SECRET_FRAGMENT_LENGTH <= form.length;
        start++
      )
        fragments.add(form.slice(start, start + SECRET_FRAGMENT_LENGTH));
    }
  }
  return [...fragments];
}

/**
 * Executes allow-decided, read-effect plans with a host-issued capability,
 * so the model never handles a token. Every executor check, the write-ahead
 * record and the signed receipt still apply.
 */
export class HostMediator {
  readonly #effects: ReadonlySet<EffectClass>;
  readonly #maxRuns: number;
  readonly #maxTextBytes: number;
  readonly #patterns: RegExp[];
  readonly #fragments: string[];
  readonly #slack: number;
  readonly #resolverKey: string | undefined;
  readonly #strikeLimit: number;
  // In memory, per server process: guidance for agents, not authority.
  readonly #failures = new Map<string, number>();
  // Bumped by each resolver success, so a failure that started before it
  // does not count against the fresh period.
  #generation = 0;

  constructor(
    readonly executor: ReproGateExecutor,
    readonly kernel: ReproGateKernel,
    readonly config: MediationConfigV1,
    readonly capabilitySecret: string,
    receiptSecret: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    this.#effects = new Set(config.effects);
    this.#maxRuns = config.maxRunsPerPlan ?? 1;
    this.#maxTextBytes = config.result?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    this.#patterns = (config.result?.redactPatterns ?? []).map(
      (pattern) => new RegExp(pattern, "gu"),
    );
    const secrets = [capabilitySecret, receiptSecret];
    this.#fragments = secretFragments(secrets);
    // Redact a little past the byte budget so a secret straddling the cut is
    // still recognised in full before the cut is applied.
    this.#slack =
      512 +
      2 * Math.max(...secrets.map((secret) => JSON.stringify(secret).length));
    this.#strikeLimit = config.strikes?.limit ?? DEFAULT_STRIKE_LIMIT;
    if (config.strikes === undefined) {
      this.#resolverKey = undefined;
    } else {
      // A resolver the agent cannot run would block a tool for good.
      const resolver = kernel.describe(config.strikes.resolverToolRef);
      if (
        resolver === undefined ||
        resolver.effects.length === 0 ||
        !resolver.effects.every((effect) => this.#effects.has(effect))
      )
        throw new Error(
          "The strike resolver must be a catalog tool with only mediated effects",
        );
      this.#resolverKey = toolKey(resolver);
    }
  }

  /** The configured strike gate, for tool descriptions. */
  get strikeGate(): { limit: number; resolverToolRef: string } | undefined {
    return this.config.strikes === undefined
      ? undefined
      : {
          limit: this.#strikeLimit,
          resolverToolRef: this.config.strikes.resolverToolRef,
        };
  }

  #strikes(key: string): StrikeState | undefined {
    const gate = this.strikeGate;
    if (gate === undefined || key === this.#resolverKey) return undefined;
    return { failures: this.#failures.get(key) ?? 0, ...gate };
  }

  // A tool's success clears its own count; the resolver's clears them all.
  #record(key: string, succeeded: boolean, generation: number): void {
    if (this.#resolverKey === undefined) return;
    if (key === this.#resolverKey) {
      if (succeeded) {
        this.#failures.clear();
        this.#generation++;
      }
    } else if (succeeded) {
      this.#failures.delete(key);
    } else {
      // Only failures from before the last resolver success are stale.
      if (generation === this.#generation)
        this.#failures.set(key, (this.#failures.get(key) ?? 0) + 1);
    }
  }

  get mediatesNetwork(): boolean {
    return this.#effects.has("network_read");
  }

  async run(input: {
    actionId: string;
    arguments: Record<string, unknown>;
    now?: Date;
  }): Promise<MediatedRunResult> {
    const plan = this.executor.store.get(input.actionId);
    if (plan === undefined) throw new MediationError("unknown_action");
    if (plan.policy.decision !== "allow")
      throw new MediationError("not_allowed");
    // An effect-less plan declares nothing to allowlist; never mediate it.
    const effects = plan.envelope.authority.effects;
    if (
      effects.length === 0 ||
      !effects.every((effect) => this.#effects.has(effect))
    )
      throw new MediationError("effect_not_mediated");
    // Policy or catalog changes since planning withdraw mediation at once.
    if (this.kernel.currentDecision(plan.envelope) !== "allow")
      throw new MediationError("stale_plan");
    const now = input.now ?? this.clock();
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime())
      throw new MediationError("expired");
    // A tool that failed `limit` times in a row waits for the resolver.
    const key = toolKey(plan.envelope.tool);
    const generation = this.#generation;
    const before = this.#strikes(key);
    if (before !== undefined && before.failures >= before.limit)
      throw new MediationError("resolve_required", before);
    // Run numbers make the limit atomic: the store accepts each capability
    // ID once, so concurrent runs cannot both take the same slot.
    const prefix = `host-mediated:${plan.envelope.actionId.slice(7)}:`;
    let executed: Awaited<ReturnType<ReproGateExecutor["execute"]>> | undefined;
    // A concurrent run that took this slot first moves us to the next one.
    for (
      let run = this.executor.store.countCapabilityUses(prefix) + 1;
      run <= this.#maxRuns && executed === undefined;
      run++
    ) {
      const capabilityToken = issueCapabilityToken(
        {
          jti: `${prefix}${String(run)}`,
          actionId: plan.envelope.actionId,
          envelopeDigest: plan.envelopeDigest,
          scopes: plan.envelope.authority.scopes,
          issuedAt: now.toISOString(),
          expiresAt: plan.envelope.expiresAt,
        },
        this.capabilitySecret,
      );
      try {
        executed = await this.executor.execute({
          actionId: input.actionId,
          arguments: input.arguments,
          capabilityToken,
          now,
        });
      } catch (error) {
        if (!(
          error instanceof Error &&
          error.message === "Capability token has already been consumed"
        )) {
          // Any executor error is a strike: an argument mismatch, but also
          // a downstream or store fault, since neither can be told apart
          // reliably from the agent's side.
          this.#record(key, false, generation);
          const strikes = this.#strikes(key);
          throw strikes === undefined
            ? error
            : new StrikeCountedError(error, strikes);
        }
      }
    }
    if (executed === undefined) throw new MediationError("run_limit");
    const { receipt, downstreamResult } = executed;
    this.#record(key, receipt.outcome === "succeeded", generation);
    const strikes =
      receipt.outcome === "failed" ? this.#strikes(key) : undefined;
    return {
      executionId: receipt.executionId,
      outcome: receipt.outcome,
      receiptDigest: receipt.receiptDigest,
      resultDigest: receipt.resultDigest,
      ...this.bound(downstreamResult),
      ...(strikes === undefined ? {} : { strikes }),
    };
  }

  /** A model-visible error message, redacted and bounded like results. */
  redactMessage(message: string): string {
    return truncateUtf8(
      this.#redact(message.slice(0, MAX_ERROR_BYTES * 2)).text,
      MAX_ERROR_BYTES,
    );
  }

  #redact(text: string): { text: string; count: number } {
    const ranges: [number, number][] = [];
    for (const fragment of this.#fragments) {
      for (
        let index = text.indexOf(fragment);
        index !== -1;
        index = text.indexOf(fragment, index + 1)
      )
        ranges.push([index, index + fragment.length]);
    }
    // Overlapping or adjacent fragment matches form one redacted span.
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const spans: [number, number][] = [];
    for (const [start, end] of ranges) {
      const last = spans.at(-1);
      if (last !== undefined && start <= last[1])
        last[1] = Math.max(last[1], end);
      else spans.push([start, end]);
    }
    let count = spans.length;
    let value = "";
    let cursor = 0;
    for (const [start, end] of spans) {
      value += `${text.slice(cursor, start)}${REDACTED}`;
      cursor = end;
    }
    value += text.slice(cursor);
    for (const pattern of [CAPABILITY_TOKEN, ...this.#patterns]) {
      value = value.replace(pattern, () => {
        count++;
        return REDACTED;
      });
    }
    return { text: value, count };
  }

  /** Redact, then bound, the model-visible view of a downstream result. */
  bound(result: unknown): BoundedContent {
    const texts: string[] = [];
    let omittedItems = 0;
    const shaped =
      result !== null && typeof result === "object" && "content" in result;
    if (shaped && Array.isArray(result.content)) {
      for (const item of result.content as unknown[]) {
        if (
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
        )
          texts.push(item.text);
        else omittedItems++;
      }
      if (
        "structuredContent" in result &&
        result.structuredContent !== undefined
      )
        texts.push(JSON.stringify(result.structuredContent));
    } else if (result !== undefined) {
      texts.push(JSON.stringify(result));
    }

    let remaining = this.#maxTextBytes;
    let truncated = false;
    let redactions = 0;
    const content: { type: "text"; text: string }[] = [];
    for (const text of texts) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      // Characters past remaining + slack can never be shown.
      const window = text.slice(0, remaining + this.#slack);
      const redacted = this.#redact(window);
      redactions += redacted.count;
      // A window cut mid-secret could end in a fragment too short to
      // recognise; never show the characters just before such a cut.
      const shown =
        window.length === text.length
          ? redacted.text
          : redacted.text.slice(0, -(SECRET_FRAGMENT_LENGTH - 1));
      const bounded = truncateUtf8(shown, remaining);
      content.push({ type: "text", text: bounded });
      remaining -= Buffer.byteLength(bounded);
      // Stop at the first cut so the model never sees a gapped view.
      if (window.length !== text.length || bounded !== shown) {
        truncated = true;
        break;
      }
    }
    return { content, truncated, redactions, omittedItems };
  }
}
