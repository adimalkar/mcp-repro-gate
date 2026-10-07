import { randomUUID } from "node:crypto";

import * as z from "zod/v4";

import { issueCapabilityToken } from "./capability-token.js";
import type { ReproGateExecutor } from "./executor.js";
import type { EffectClass } from "./types.js";

export const MEDIATED_EFFECTS = ["local_read", "network_read"] as const;
export const DEFAULT_MAX_TEXT_BYTES = 16 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const REDACTED = "[REDACTED]";

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
  "unknown_action" | "not_allowed" | "effect_not_mediated" | "expired";

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

/**
 * Executes allow-decided, read-effect plans with a host-issued one-use
 * capability, so the model never handles a token. Every executor check,
 * the write-ahead record and the signed receipt still apply.
 */
export class HostMediator {
  readonly #effects: ReadonlySet<EffectClass>;
  readonly #maxTextBytes: number;
  readonly #patterns: RegExp[];
  readonly #secrets: string[];

  constructor(
    readonly executor: ReproGateExecutor,
    readonly config: MediationConfigV1,
    readonly capabilitySecret: string,
    receiptSecret: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    this.#effects = new Set(config.effects);
    this.#maxTextBytes = config.result?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    this.#patterns = (config.result?.redactPatterns ?? []).map(
      (pattern) => new RegExp(pattern, "gu"),
    );
    this.#secrets = [capabilitySecret, receiptSecret].filter(
      (secret) => secret.length > 0,
    );
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
    if (
      !plan.envelope.authority.effects.every((effect) =>
        this.#effects.has(effect),
      )
    )
      throw new MediationError("effect_not_mediated");
    const now = input.now ?? this.clock();
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime())
      throw new MediationError("expired");
    const capabilityToken = issueCapabilityToken(
      {
        jti: `host-mediated:${randomUUID()}`,
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        scopes: plan.envelope.authority.scopes,
        issuedAt: now.toISOString(),
        expiresAt: plan.envelope.expiresAt,
      },
      this.capabilitySecret,
    );
    const { receipt, downstreamResult } = await this.executor.execute({
      actionId: input.actionId,
      arguments: input.arguments,
      capabilityToken,
      now,
    });
    return {
      executionId: receipt.executionId,
      outcome: receipt.outcome,
      receiptDigest: receipt.receiptDigest,
      resultDigest: receipt.resultDigest,
      ...this.bound(downstreamResult),
    };
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

    let redactions = 0;
    const redacted = texts.map((text) => {
      let value = text;
      for (const secret of this.#secrets) {
        const parts = value.split(secret);
        redactions += parts.length - 1;
        value = parts.join(REDACTED);
      }
      for (const pattern of [CAPABILITY_TOKEN, ...this.#patterns]) {
        value = value.replace(pattern, () => {
          redactions++;
          return REDACTED;
        });
      }
      return value;
    });

    let remaining = this.#maxTextBytes;
    let truncated = false;
    const content: { type: "text"; text: string }[] = [];
    for (const text of redacted) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const bounded = truncateUtf8(text, remaining);
      if (bounded.length !== text.length) truncated = true;
      remaining -= Buffer.byteLength(bounded);
      content.push({ type: "text", text: bounded });
    }
    return { content, truncated, redactions, omittedItems };
  }
}
