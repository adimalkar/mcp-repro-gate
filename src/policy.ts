import { digestCanonical } from "./digest.js";
import type {
  Decision,
  EffectClass,
  PolicyDecision,
  PolicyRule,
  PolicyV1,
} from "./types.js";

const severity: Record<Decision, number> = {
  allow: 0,
  approval_required: 1,
  deny: 2,
};

function matchingRule(
  policy: PolicyV1,
  toolRef: string,
  effect: EffectClass,
): PolicyRule | undefined {
  const matches = policy.rules
    .filter(
      (rule) =>
        (rule.match.toolRef === undefined || rule.match.toolRef === toolRef) &&
        (rule.match.effect === undefined || rule.match.effect === effect),
    )
    .sort((left, right) => right.priority - left.priority);

  const selected = matches[0];
  const tied = matches.filter(
    (candidate) => candidate.priority === selected?.priority,
  );
  if (
    selected !== undefined &&
    tied.some((candidate) => candidate.decision !== selected.decision)
  ) {
    throw new Error(
      `Ambiguous policy: conflicting priority ${String(selected.priority)} rules for ${toolRef}/${effect}`,
    );
  }
  return selected;
}

export function evaluatePolicy(
  policy: PolicyV1,
  toolRef: string,
  effects: EffectClass[],
): PolicyDecision {
  if (effects.length === 0) {
    throw new Error(`Catalog tool ${toolRef} must declare at least one effect`);
  }

  const reasons = [...new Set(effects)].sort().map((effect) => {
    const rule = matchingRule(policy, toolRef, effect);
    if (rule !== undefined) {
      return {
        effect,
        decision: rule.decision,
        ruleId: rule.id,
        reason: rule.reason,
      };
    }
    return {
      effect,
      decision: policy.defaults[effect],
      ruleId: `default:${effect}`,
      reason: `Default decision for ${effect}`,
    };
  });

  const decision = reasons.reduce<Decision>(
    (current, reason) =>
      severity[reason.decision] > severity[current] ? reason.decision : current,
    "allow",
  );

  return {
    decision,
    policyDigest: digestCanonical(policy),
    reasons,
  };
}
