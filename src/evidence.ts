import { digestCanonical } from "./digest.js";
import type { Decision, Digest } from "./types.js";

export interface DecisionEvidenceV1 {
  version: 1;
  sequence: number;
  occurredAt: string;
  actionId: Digest;
  envelopeDigest: Digest;
  policyDigest: Digest;
  decision: Decision;
  previousDigest: Digest | null;
  recordDigest: Digest;
}

export type UnsignedDecisionEvidenceV1 = Omit<
  DecisionEvidenceV1,
  "recordDigest"
>;

export function appendDecisionEvidence(
  chain: readonly DecisionEvidenceV1[],
  value: Omit<
    UnsignedDecisionEvidenceV1,
    "version" | "sequence" | "previousDigest"
  >,
): DecisionEvidenceV1 {
  const previous = chain.at(-1);
  const unsigned: UnsignedDecisionEvidenceV1 = {
    version: 1,
    sequence: chain.length,
    occurredAt: value.occurredAt,
    actionId: value.actionId,
    envelopeDigest: value.envelopeDigest,
    policyDigest: value.policyDigest,
    decision: value.decision,
    previousDigest: previous?.recordDigest ?? null,
  };
  return { ...unsigned, recordDigest: digestCanonical(unsigned) };
}

export function verifyDecisionEvidenceChain(
  chain: readonly DecisionEvidenceV1[],
): boolean {
  return chain.every((record, index) => {
    const { recordDigest, ...unsigned } = record;
    const expectedPrevious =
      index === 0 ? null : chain[index - 1]?.recordDigest;
    return (
      record.sequence === index &&
      record.previousDigest === expectedPrevious &&
      recordDigest === digestCanonical(unsigned)
    );
  });
}
