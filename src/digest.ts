import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { Digest } from "./types.js";

export function sha256(value: string | Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestCanonical(value: unknown): Digest {
  return sha256(canonicalJson(value));
}
