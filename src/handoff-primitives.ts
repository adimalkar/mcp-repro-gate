import { isProxy } from "node:util/types";
import { z } from "zod/v4";

// Shared by the handoff record and session contracts. The record contract
// embeds session schemas, so nothing here may import either contract.
export const HANDOFF_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u;
export const handoffUuidSchema = z.string().regex(HANDOFF_UUID_PATTERN);
// Terminal escapes and bidi overrides would render deceptively when an agent
// or operator prints the projection; only tab, LF and CR remain.
export const HANDOFF_UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex -- Matching control characters is the purpose.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export const MAX_HANDOFF_BYTES = 64 * 1024;
export type HandoffErrorCode =
  | "invalid_input"
  | "revision_conflict"
  | "document_conflict"
  | "update_conflict"
  | "unknown_plan"
  | "unknown_session"
  | "session_ended"
  | "read_only"
  | "drifted"
  | "unavailable";
export class HandoffError extends Error {
  // A cause stays host-side for diagnosis; MCP results carry only the code.
  constructor(
    readonly code: HandoffErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`Handoff ${code}`, options);
    this.name = "HandoffError";
  }
}

/** Reject caller getters/proxies before reading values; own a bounded plain tree. */
export function ownHandoffValue(value: unknown): unknown {
  let bytes = 0;
  function copy(current: unknown, depth: number): unknown {
    if (depth > 8) throw new HandoffError("invalid_input");
    if (typeof current === "string") {
      const length = Buffer.byteLength(current);
      bytes += length;
      if (
        length > 8192 ||
        bytes > MAX_HANDOFF_BYTES ||
        Buffer.from(current).toString("utf8") !== current
      )
        throw new HandoffError("invalid_input");
      return current;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    )
      return current;
    if (typeof current !== "object" || isProxy(current))
      throw new HandoffError("invalid_input");
    const array = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    )
      throw new HandoffError("invalid_input");
    const keys = Reflect.ownKeys(current);
    if (keys.length > (array ? 65 : 24))
      throw new HandoffError("invalid_input");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (array) {
      const length: unknown = descriptors.length?.value;
      if (
        typeof length !== "number" ||
        length > 64 ||
        keys.length !== length + 1
      )
        throw new HandoffError("invalid_input");
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          throw new HandoffError("invalid_input");
        result.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 64 || key === "__proto__")
        throw new HandoffError("invalid_input");
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        throw new HandoffError("invalid_input");
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_HANDOFF_BYTES)
    throw new HandoffError("invalid_input");
  return result;
}
