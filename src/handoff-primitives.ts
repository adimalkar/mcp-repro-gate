import { z } from "zod/v4";

// Shared by the handoff record and session contracts, which import each
// other's schemas; keeping these here avoids an import cycle.
export const HANDOFF_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u;
export const handoffUuidSchema = z.string().regex(HANDOFF_UUID_PATTERN);
// Terminal escapes and bidi overrides would render deceptively when an agent
// or operator prints the projection; only tab, LF and CR remain.
export const HANDOFF_UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex -- Matching control characters is the purpose.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
