import { digestCanonical } from "./digest.js";
import type {
  ActionEnvelopeV1,
  Digest,
  UnsignedActionEnvelopeV1,
} from "./types.js";

export function createActionEnvelope(
  value: UnsignedActionEnvelopeV1,
): ActionEnvelopeV1 {
  return {
    ...value,
    actionId: digestCanonical(value),
  };
}

export function verifyActionEnvelope(envelope: ActionEnvelopeV1): boolean {
  const { actionId, ...unsigned } = envelope;
  return actionId === digestCanonical(unsigned);
}

export function envelopeDigest(envelope: ActionEnvelopeV1): Digest {
  if (!verifyActionEnvelope(envelope)) {
    throw new Error("Action envelope has an invalid actionId");
  }
  return digestCanonical(envelope);
}
