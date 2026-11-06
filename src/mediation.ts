import * as z from "zod/v4";

import { issueCapabilityToken } from "./capability-token.js";
import type { ReproGateExecutor } from "./executor.js";
import {
  GRAPH_VIEWS,
  graphViewKey,
  MAX_GRAPH_VIEW_CHARS,
  projectGraphPayload,
  sameJson,
  type GraphView,
} from "./graph-view.js";
import { heldApprovalMatches, type HeldApprovalV1 } from "./held-approval.js";
import type { PlannedAction, ReproGateKernel } from "./kernel.js";
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
      .refine((effects) => new Set(effects).size === effects.length)
      .optional(),
    heldApprovals: z.boolean().optional(),
    maxRunsPerPlan: z.number().int().min(1).max(MAX_RUNS_PER_PLAN).optional(),
    result: z
      .object({
        maxTextBytes: z.number().int().min(256).max(MAX_TEXT_BYTES).optional(),
        redactPatterns: z
          .array(z.string().min(1).max(256).refine(usablePattern))
          .max(16)
          .optional(),
        graphViews: z
          .array(
            z.strictObject({
              serverRef: z.string().min(1).max(256),
              toolName: z.string().min(1).max(256),
              view: z.enum(GRAPH_VIEWS),
            }),
          )
          .max(64)
          .superRefine((entries, context) => {
            const seen = new Set<string>();
            for (const entry of entries) {
              const key = graphViewKey(entry.serverRef, entry.toolName);
              if (seen.has(key))
                context.addIssue({
                  code: "custom",
                  message: `Duplicate graph view for ${entry.serverRef}/${entry.toolName}`,
                });
              seen.add(key);
            }
          })
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
  .strict()
  .refine(
    (config) => config.effects !== undefined || config.heldApprovals === true,
    "Mediation needs effects, heldApprovals: true, or both",
  );

export type MediationConfigV1 = z.infer<typeof mediationConfigSchema>;

export type MediationRefusal =
  | "unknown_action"
  | "not_allowed"
  | "effect_not_mediated"
  | "stale_plan"
  | "expired"
  | "run_limit"
  | "awaiting_approval"
  | "invalid_approval"
  | "approval_consumed"
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
  readonly #graphViews: ReadonlyMap<string, GraphView>;

  constructor(
    readonly executor: ReproGateExecutor,
    readonly kernel: ReproGateKernel,
    readonly config: MediationConfigV1,
    readonly capabilitySecret: string,
    receiptSecret: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    this.#effects = new Set(config.effects ?? []);
    this.#maxRuns = config.maxRunsPerPlan ?? 1;
    this.#maxTextBytes = config.result?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    this.#graphViews = new Map(
      (config.result?.graphViews ?? []).map((entry) => [
        graphViewKey(entry.serverRef, entry.toolName),
        entry.view,
      ]),
    );
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

  /** Whether operator-held approvals let action.run execute any effect. */
  get runsApprovedPlans(): boolean {
    return this.config.heldApprovals === true;
  }

  async run(input: {
    actionId: string;
    arguments: Record<string, unknown>;
    now?: Date;
  }): Promise<MediatedRunResult> {
    const plan = this.executor.store.get(input.actionId);
    if (plan === undefined) throw new MediationError("unknown_action");
    if (plan.policy.decision === "deny")
      throw new MediationError("not_allowed");
    if (this.runsApprovedPlans) {
      let held: HeldApprovalV1 | undefined;
      try {
        held = this.executor.store.getHeldApproval(input.actionId);
      } catch {
        throw new MediationError("invalid_approval");
      }
      if (held !== undefined) return this.#runHeld(plan, held, input);
    }
    if (plan.policy.decision !== "allow")
      throw new MediationError(
        this.runsApprovedPlans ? "awaiting_approval" : "not_allowed",
      );
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
      ...this.bound(downstreamResult, this.#configuredView(plan)),
      ...(strikes === undefined ? {} : { strikes }),
    };
  }

  // One run of an operator-approved plan. The host-mediation effect
  // allowlist does not apply: a person approved this exact envelope.
  async #runHeld(
    plan: PlannedAction,
    held: HeldApprovalV1,
    input: { actionId: string; arguments: Record<string, unknown>; now?: Date },
  ): Promise<MediatedRunResult> {
    if (this.kernel.currentDecision(plan.envelope) !== plan.policy.decision)
      throw new MediationError("stale_plan");
    const now = input.now ?? this.clock();
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime())
      throw new MediationError("expired");
    if (!heldApprovalMatches(held, plan, this.capabilitySecret, now))
      throw new MediationError("invalid_approval");
    const capabilityToken = issueCapabilityToken(
      {
        jti: `host-held:${held.approvalId}`,
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        scopes: plan.envelope.authority.scopes,
        issuedAt: now.toISOString(),
        expiresAt: held.expiresAt,
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
        throw new MediationError("approval_consumed");
      throw error;
    }
    const { receipt, downstreamResult } = executed;
    return {
      executionId: receipt.executionId,
      outcome: receipt.outcome,
      receiptDigest: receipt.receiptDigest,
      resultDigest: receipt.resultDigest,
      ...this.bound(downstreamResult, this.#configuredView(plan)),
    };
  }

  // The compact view the host configured for this exact server and tool.
  #configuredView(plan: PlannedAction): GraphView | undefined {
    return this.#graphViews.get(
      graphViewKey(plan.envelope.tool.serverRef, plan.envelope.tool.toolName),
    );
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

  /**
   * The JSON of structuredContent, without the copies the text items already
   * carry: undefined when a text item is a JSON-equivalent mirror (as the MCP
   * specification asks servers to send, possibly pretty-printed), otherwise
   * with top-level string fields equal to a text item replaced by a
   * "[text item N]" marker. Anything that could change what is shown or
   * redacted keeps the whole JSON, exactly as before.
   */
  #structuredMirror(
    structured: unknown,
    texts: readonly string[],
  ): string | undefined {
    const whole = JSON.stringify(structured);
    // Past this length it is always cut and only a prefix is shown: keep it
    // unchanged. The text items were all shown whole, so each is within the
    // same limit, which bounds the parsing and redaction work below.
    if (whole.length > this.#maxTextBytes + this.#slack) return whole;
    // Removing text could split a match a host pattern makes across fields,
    // and skipping a copy would hide the redaction count.
    if (this.#redact(whole).count > 0) return whole;
    for (const text of texts) {
      if (text === whole) return undefined;
      if (!/^\s*[[{]/u.test(text)) continue;
      try {
        if (JSON.stringify(JSON.parse(text)) === whole) return undefined;
      } catch {
        // Not JSON, so not a mirror.
      }
    }
    if (
      structured === null ||
      typeof structured !== "object" ||
      Array.isArray(structured)
    )
      return whole;
    const first = new Map<string, number>();
    texts.forEach((text, index) => {
      if (!first.has(text)) first.set(text, index + 1);
    });
    let replaced = 0;
    const fields: [string, unknown][] = [];
    for (const [key, value] of Object.entries(structured)) {
      const item = typeof value === "string" ? first.get(value) : undefined;
      const marker = `[text item ${String(item)}]`;
      // Short values cost less than the marker; keep them.
      if (item !== undefined && (value as string).length > marker.length) {
        fields.push([key, marker]);
        replaced++;
      } else fields.push([key, value]);
    }
    // fromEntries keeps a "__proto__" key as an own property.
    return replaced > 0 ? JSON.stringify(Object.fromEntries(fields)) : whole;
  }

  #graphView(
    result: unknown,
    view: GraphView,
  ): { content: { type: "text"; text: string }[] } | undefined {
    if (
      result === null ||
      typeof result !== "object" ||
      !("content" in result) ||
      !Array.isArray(result.content) ||
      result.content.length !== 1 ||
      Object.keys(result).some(
        (key) => !["content", "structuredContent", "isError"].includes(key),
      ) ||
      ("isError" in result &&
        result.isError !== false &&
        result.isError !== undefined)
    )
      return undefined;
    const item: unknown = result.content[0];
    if (
      item === null ||
      typeof item !== "object" ||
      !("type" in item) ||
      item.type !== "text" ||
      !("text" in item) ||
      typeof item.text !== "string" ||
      Object.keys(item).some((key) => !["type", "text"].includes(key))
    )
      return undefined;
    const text = item.text;
    // Bounds the parse, schema check, redaction and mirror comparison.
    if (text.length > MAX_GRAPH_VIEW_CHARS) return undefined;
    // Removing fields must not split a host pattern or hide its count.
    if (this.#redact(text).count > 0) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return undefined;
    }
    // Only compact JSON exactly as JSON.stringify writes it: no duplicate
    // keys, escaped spellings or whitespace that parsing would hide.
    if (JSON.stringify(payload) !== text) return undefined;
    const projected = projectGraphPayload(payload, view);
    if (projected === undefined) return undefined;
    // A structured copy must serialize to the same text, so the redaction
    // check above covered it too.
    if (
      "structuredContent" in result &&
      result.structuredContent !== undefined &&
      !sameJson(payload, result.structuredContent)
    )
      return undefined;
    return { content: [{ type: "text", text: JSON.stringify(projected) }] };
  }

  /** Redact, then bound, the optionally projected model-visible view. */
  bound(original: unknown, view?: GraphView): BoundedContent {
    const result =
      view === undefined
        ? original
        : (this.#graphView(original, view) ?? original);
    const texts: string[] = [];
    let structured: unknown;
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
      if ("structuredContent" in result) structured = result.structuredContent;
    } else if (result !== undefined) {
      texts.push(JSON.stringify(result));
    }

    let remaining = this.#maxTextBytes;
    let truncated = false;
    let redactions = 0;
    const content: { type: "text"; text: string }[] = [];
    // Shows one item; false once the view is cut.
    const show = (text: string): boolean => {
      if (remaining <= 0) {
        truncated = true;
        return false;
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
        return false;
      }
      return true;
    };
    const uncut = texts.every(show);
    // The structured JSON comes last, so it is only worth building once
    // every text item has been shown whole.
    if (uncut && structured !== undefined) {
      const mirror = this.#structuredMirror(structured, texts);
      if (mirror !== undefined) show(mirror);
    }
    return { content, truncated, redactions, omittedItems };
  }
}
