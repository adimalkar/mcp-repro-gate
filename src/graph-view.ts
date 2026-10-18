import * as z from "zod/v4";

export const GRAPH_VIEWS = ["search", "snippet"] as const;
export type GraphView = (typeof GRAPH_VIEWS)[number];
/** Longest reply text, in UTF-16 code units, that is parsed and projected. */
export const MAX_GRAPH_VIEW_CHARS = 64 * 1024;

/** The lookup key for a server/tool identity, unambiguous for any names. */
export function graphViewKey(serverRef: string, toolName: string): string {
  return JSON.stringify([serverRef, toolName]);
}

/**
 * Whether two JSON values serialize identically: equal scalars, and arrays
 * and plain objects with the same keys in the same order. `expected` must already
 * be shape-checked, which bounds the recursion depth; `actual` is compared
 * node by node and never serialized.
 */
export function sameJson(expected: unknown, actual: unknown): boolean {
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  )
    return expected === actual;
  // Only plain containers: a toJSON method, Proxy or other prototype could
  // serialize differently from what is compared here.
  if (
    Object.getPrototypeOf(actual) !==
    (Array.isArray(actual) ? Array.prototype : Object.prototype)
  )
    return false;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    return (
      expected.length === actual.length &&
      expected.every((item, index) => sameJson(item, actual[index]))
    );
  }
  const keys = Object.keys(expected);
  const other = Object.keys(actual);
  return (
    keys.length === other.length &&
    keys.every(
      (key, index) =>
        key === other[index] &&
        sameJson(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
        ),
    )
  );
}

const count = z.number().int().nonnegative();
const identity = {
  name: z.string().min(1),
  qualified_name: z.string().min(1),
  label: z.string().min(1),
  file_path: z.string().min(1),
};

// Known codebase-memory-mcp diagnostics. Unknown fields fail validation so
// a new warning, answer or result channel cannot silently disappear.
const diagnostics = {
  complexity: count.optional(),
  cognitive: count.optional(),
  lines: count.optional(),
  loop_count: count.optional(),
  loop_depth: count.optional(),
  self_recursive: z.boolean().optional(),
  param_count: count.optional(),
  max_access_depth: count.optional(),
  linear_scan_in_loop: count.optional(),
  alloc_in_loop: count.optional(),
  recursion_in_loop: z.boolean().optional(),
  unguarded_recursion: z.boolean().optional(),
  transitive_loop_depth: count.optional(),
  recursive: z.boolean().optional(),
  is_exported: z.boolean().optional(),
  is_test: z.boolean().optional(),
  is_entry_point: z.boolean().optional(),
  signature: z.string().optional(),
  return_type: z.string().optional(),
  docstring: z.string().optional(),
  fp: z.string().optional(),
  sp: z.string().optional(),
  bt: z.string().optional(),
};

const searchSchema = z
  .strictObject({
    total: count,
    has_more: z.boolean(),
    results: z
      .array(
        z.strictObject({
          ...identity,
          ...diagnostics,
          in_degree: count.optional(),
          out_degree: count.optional(),
          extension: z.string().optional(),
        }),
      )
      .max(200),
  })
  .refine((value) => value.total >= value.results.length);

const snippetSchema = z
  .strictObject({
    ...identity,
    ...diagnostics,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    source: z.string().min(1),
    callers: count.optional(),
    callees: count.optional(),
  })
  .refine((value) => value.end_line >= value.start_line);

/**
 * Select only lookup/read fields from a recognized payload. The caller must
 * check the original envelope, processing bound, mirrors and redaction first.
 */
export function projectGraphPayload(
  payload: unknown,
  view: GraphView,
): unknown {
  if (view === "search") {
    const parsed = searchSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    return {
      view: "graph_search_v1",
      total: parsed.data.total,
      has_more: parsed.data.has_more,
      results: parsed.data.results.map((item) => ({
        name: item.name,
        qualified_name: item.qualified_name,
        label: item.label,
        file_path: item.file_path,
        ...(item.lines === undefined ? {} : { lines: item.lines }),
      })),
    };
  }
  const parsed = snippetSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  return {
    view: "graph_snippet_v1",
    name: item.name,
    qualified_name: item.qualified_name,
    label: item.label,
    file_path: item.file_path,
    start_line: item.start_line,
    end_line: item.end_line,
    source: item.source,
  };
}
