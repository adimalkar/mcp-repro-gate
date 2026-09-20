/**
 * Deterministic JSON encoding used by ReproGate v1 digests.
 *
 * This is intentionally a small, documented profile rather than an RFC 8785
 * claim: object keys are lexicographically sorted, arrays retain order, and
 * unsupported/non-finite/cyclic values are rejected instead of coerced.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (current: unknown, path: string): string => {
    if (current === null) return "null";

    switch (typeof current) {
      case "string":
        return JSON.stringify(current);
      case "boolean":
        return current ? "true" : "false";
      case "number":
        if (!Number.isFinite(current)) {
          throw new TypeError(`Non-finite number at ${path}`);
        }
        return JSON.stringify(current);
      case "undefined":
      case "bigint":
      case "function":
      case "symbol":
        throw new TypeError(`Unsupported JSON value at ${path}`);
      case "object": {
        if (ancestors.has(current)) {
          throw new TypeError(`Cyclic value at ${path}`);
        }

        ancestors.add(current);
        try {
          if (Array.isArray(current)) {
            return `[${current
              .map((item, index) => encode(item, `${path}[${String(index)}]`))
              .join(",")}]`;
          }

          const prototype: unknown = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`Non-plain object at ${path}`);
          }

          const record = current as Record<string, unknown>;
          const keys = Object.keys(record).sort();
          return `{${keys
            .map(
              (key) =>
                `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`)}`,
            )
            .join(",")}}`;
        } finally {
          ancestors.delete(current);
        }
      }
    }

    throw new TypeError(`Unsupported JSON value at ${path}`);
  };

  return encode(value, "$");
}
