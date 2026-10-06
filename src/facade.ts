import * as z from "zod/v4";

import { digestCanonical } from "./digest.js";
import type { PlannedAction } from "./kernel.js";
import type { CatalogTool } from "./types.js";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const effectSchema = z.enum([
  "local_read",
  "local_write",
  "process_exec",
  "network_read",
  "network_write",
  "credential_use",
  "destructive",
]);
const decisionSchema = z.enum(["allow", "approval_required", "deny"]);
const reasonSchema = z.object({
  effect: effectSchema,
  decision: decisionSchema,
  ruleId: z.string(),
  reason: z.string(),
});
const policySchema = z.object({
  decision: decisionSchema,
  policyDigest: digestSchema,
  reasons: z.array(reasonSchema),
});

export const catalogSearchOutputSchema = z.object({
  tools: z.array(
    z.object({
      toolRef: z.string(),
      description: z.string(),
      effects: z.array(effectSchema),
    }),
  ),
});

export const catalogDescribeOutputSchema = z.object({
  toolRef: z.string(),
  description: z.string(),
  effects: z.array(effectSchema),
  scopes: z.array(z.string()),
  filesystemRoots: z.array(z.string()),
  networkDestinations: z.array(z.string()),
  sensitivityLabels: z.array(z.string()),
  inputSchema: z.unknown(),
  schemaDigest: digestSchema,
});

export const actionIdInputSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const toolRefInputSchema = z.string().min(1).max(256);
export const nextStepSchema = z.enum(["stop", "await_capability", "plan_only"]);
export type NextStep = z.infer<typeof nextStepSchema>;

const compactPlanSchema = z.object({
  detail: z.literal("compact"),
  actionId: digestSchema,
  envelopeDigest: digestSchema,
  toolRef: z.string(),
  decision: decisionSchema,
  reasonCodes: z.array(z.string()),
  expiresAt: z.string(),
  nextStep: nextStepSchema,
});
// The full envelope is operator evidence; its fields are validated by the
// envelope contract itself, so the output schema only pins its presence.
const fullPlanSchema = z.object({
  detail: z.literal("full"),
  envelope: z.object({ actionId: digestSchema }).loose(),
  envelopeDigest: digestSchema,
  policy: policySchema,
  nextStep: nextStepSchema,
});
export const actionPlanOutputSchema = z.discriminatedUnion("detail", [
  compactPlanSchema,
  fullPlanSchema,
]);
export const actionInspectOutputSchema = fullPlanSchema;
export const policyExplainOutputSchema = z.object({
  actionId: digestSchema,
  policy: policySchema,
});

/** One catalog entry, including the schema digest a plan would bind. */
export function describeCatalogTool(tool: CatalogTool) {
  return {
    toolRef: tool.toolRef,
    description: tool.description,
    effects: [...new Set(tool.effects)].sort(),
    scopes: [...new Set(tool.scopes ?? [])].sort(),
    filesystemRoots: [...new Set(tool.filesystemRoots ?? [])].sort(),
    networkDestinations: [...new Set(tool.networkDestinations ?? [])].sort(),
    sensitivityLabels: [...new Set(tool.sensitivityLabels ?? [])].sort(),
    inputSchema: tool.inputSchema,
    schemaDigest: digestCanonical(tool.inputSchema),
  };
}

/** Guidance derived from policy, expiry and configuration; never authority. */
export function nextStepFor(
  plan: PlannedAction,
  executorConfigured: boolean,
  now: Date = new Date(),
): NextStep {
  if (
    plan.policy.decision === "deny" ||
    Date.parse(plan.envelope.expiresAt) <= now.getTime()
  )
    return "stop";
  return executorConfigured ? "await_capability" : "plan_only";
}

export function compactPlan(
  plan: PlannedAction,
  toolRef: string,
  executorConfigured: boolean,
) {
  return {
    detail: "compact" as const,
    actionId: plan.envelope.actionId,
    envelopeDigest: plan.envelopeDigest,
    toolRef,
    decision: plan.policy.decision,
    reasonCodes: [...new Set(plan.policy.reasons.map(({ ruleId }) => ruleId))],
    expiresAt: plan.envelope.expiresAt,
    nextStep: nextStepFor(plan, executorConfigured),
  };
}

export function fullPlan(plan: PlannedAction, executorConfigured: boolean) {
  return {
    detail: "full" as const,
    envelope: plan.envelope,
    envelopeDigest: plan.envelopeDigest,
    policy: plan.policy,
    nextStep: nextStepFor(plan, executorConfigured),
  };
}
