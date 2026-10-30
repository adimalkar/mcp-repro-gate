export const HANDOFF_REDACTED = "[REDACTED]";

// Well-known credential shapes. Each pattern is anchored on a fixed prefix
// and uses bounded, non-nested quantifiers, so matching stays linear.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,255}\b/gu,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,255}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{35}\b/gu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,255}\b/gu,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,2048}\b/gu,
  /\brg1\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/gu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,4096}/gu,
  /\b[a-z][a-z0-9+.-]{1,16}:\/\/[^\s/:@]{1,256}:[^\s/@]{1,256}@/gu,
];

/**
 * Replace well-known credential shapes before caller or client text is
 * stored. This is a backstop for accidental pastes, not a secret scanner:
 * unrecognised secrets pass through unchanged.
 */
export function redactHandoffText(text: string): {
  text: string;
  redactions: number;
} {
  let redactions = 0;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions++;
      return HANDOFF_REDACTED;
    });
  }
  return { text: result, redactions };
}
