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
  })
  .strict();

export type MediationConfigV1 = z.infer<typeof mediationConfigSchema>;

export type MediationRefusal =
  | "unknown_action"
  | "not_allowed"
  | "effect_not_mediated"
  | "stale_plan"
  | "expired"
  | "run_limit";

export class MediationError extends Error {
  constructor(readonly code: MediationRefusal) {
    super(`Host mediation refused: ${code}`);
    this.name = "MediationError";
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
    // Run numbers make the limit atomic: the store accepts each capability
    // ID once, so concurrent runs cannot both take the same slot.
    const prefix = `host-mediated:${plan.envelope.actionId.slice(7)}:`;
    const used = this.executor.store.countCapabilityUses(prefix);
    if (used >= this.#maxRuns) throw new MediationError("run_limit");
    const capabilityToken = issueCapabilityToken(
      {
        jti: `${prefix}${String(used + 1)}`,
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        scopes: plan.envelope.authority.scopes,
        issuedAt: now.toISOString(),
        expiresAt: plan.envelope.expiresAt,
      },
      this.capabilitySecret,
    );
    let executed: Awaited<ReturnType<ReproGateExecutor["execute"]>>;
    try {
      executed = await this.executor.execute({
        actionId: input.actionId,
        arguments: input.arguments,
        capabilityToken,
        now,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Capability token has already been consumed"
      )
        throw new MediationError("run_limit");
      throw error;
    }
    const { receipt, downstreamResult } = executed;
    return {
      executionId: receipt.executionId,
      outcome: receipt.outcome,
      receiptDigest: receipt.receiptDigest,
      resultDigest: receipt.resultDigest,
      ...this.bound(downstreamResult),
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
      const bounded = truncateUtf8(redacted.text, remaining);
      content.push({ type: "text", text: bounded });
      remaining -= Buffer.byteLength(bounded);
      // Stop at the first cut so the model never sees a gapped view.
      if (window.length !== text.length || bounded !== redacted.text) {
        truncated = true;
        break;
      }
    }
    return { content, truncated, redactions, omittedItems };
  }
}
