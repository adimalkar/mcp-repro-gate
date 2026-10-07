import { canonicalJson } from "./canonical-json.js";
import { digestCanonical } from "./digest.js";
import type { DownstreamToolDescription } from "./downstream.js";
import type { CatalogTool, Digest, EffectClass } from "./types.js";

export const MAX_IMPORTED_TOOLS = 128;
export const MAX_IMPORTED_SCHEMA_BYTES = 64 * 1024;
export const MAX_IMPORTED_DESCRIPTION = 2048;
const MAX_TOOL_REF = 256;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const READ_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "local_read",
  "network_read",
]);
// Verbs that usually mean a tool changes something. A hint for review only.
const WRITE_VERBS = new Set([
  "delete",
  "remove",
  "write",
  "index",
  "ingest",
  "manage",
  "set",
  "create",
  "update",
  "run",
  "exec",
  "put",
  "post",
  "drop",
  "reset",
]);
// Control and bidirectional-formatting characters, which could rewrite what
// an operator's terminal shows or reorder text a model reads.
const UNSAFE_CLASS =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]";
const UNSAFE_TEXT = new RegExp(UNSAFE_CLASS, "gu");
// Non-global, so .test() keeps no lastIndex state between calls.
const HAS_UNSAFE_TEXT = new RegExp(UNSAFE_CLASS, "u");

export const EFFECT_CLASSES: readonly EffectClass[] = [
  "local_read",
  "local_write",
  "process_exec",
  "network_read",
  "network_write",
  "credential_use",
  "destructive",
];

/** Show untrusted text with control and bidi characters as \u escapes. */
export function escapeUnsafeText(text: string): string {
  return text.replace(
    UNSAFE_TEXT,
    (character) =>
      `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

function writeShaped(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[_.-]/u)
    .some((word) => WRITE_VERBS.has(word));
}

// Copied descriptions become catalog text an agent reads: keep line breaks,
// drop other control and bidi characters, and cut on a grapheme boundary.
function catalogDescription(description: string | undefined, name: string) {
  const cleaned = (description ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(UNSAFE_TEXT, (character) => (character === "\n" ? "\n" : ""))
    .trim();
  const text = cleaned.length > 0 ? cleaned : name;
  let kept = "";
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    if (kept.length + segment.length > MAX_IMPORTED_DESCRIPTION) break;
    kept += segment;
  }
  return kept;
}

export interface CatalogImportOptions {
  serverRef: string;
  artifactDigest: Digest;
  effects: EffectClass[];
  tools?: string[];
  filesystemRoots?: string[];
  scopes?: string[];
}

export interface CatalogImportReport {
  toolRef: string;
  schemaDigest: Digest;
  warnings: string[];
}

export interface CatalogImportResult {
  entries: CatalogTool[];
  report: CatalogImportReport[];
}

/** Checks that need no downstream connection, so they run before spawning. */
export function validateImportOptions(
  options: Omit<CatalogImportOptions, "artifactDigest">,
): void {
  if (!TOOL_NAME.test(options.serverRef))
    throw new Error("Backend name must match [A-Za-z0-9_.-]{1,128}");
  if (options.effects.length === 0)
    throw new Error("Declare at least one effect with --effects");
  for (const effect of options.effects)
    if (!EFFECT_CLASSES.includes(effect))
      throw new Error(`Unknown effect: ${escapeUnsafeText(effect)}`);
  if (options.tools !== undefined) {
    if (options.tools.length === 0)
      throw new Error("--tools must name at least one tool");
    if (new Set(options.tools).size !== options.tools.length)
      throw new Error("--tools lists a tool more than once");
    for (const name of options.tools)
      if (!TOOL_NAME.test(name))
        throw new Error(
          `Tool name ${escapeUnsafeText(JSON.stringify(name))} must match [A-Za-z0-9_.-]{1,128}`,
        );
  }
  for (const value of [
    ...(options.scopes ?? []),
    ...(options.filesystemRoots ?? []),
  ])
    if (value.length === 0 || HAS_UNSAFE_TEXT.test(value))
      throw new Error(
        "Scopes and filesystem roots must be non-empty plain text",
      );
}

/**
 * Turn a downstream tool listing into catalog entries for operator review.
 * Effects are exactly what the operator declared; downstream annotations
 * and names only produce warnings and never grant or narrow authority.
 */
export function importCatalogEntries(
  listed: readonly DownstreamToolDescription[],
  options: CatalogImportOptions,
): CatalogImportResult {
  validateImportOptions(options);
  const effects = [...new Set(options.effects)].sort();
  const byName = new Map<string, DownstreamToolDescription>();
  for (const tool of listed) {
    if (byName.has(tool.name))
      throw new Error(
        `Downstream lists ${escapeUnsafeText(JSON.stringify(tool.name))} more than once`,
      );
    byName.set(tool.name, tool);
  }
  const names = options.tools ?? [...byName.keys()].sort();
  if (names.length > MAX_IMPORTED_TOOLS)
    throw new Error(
      `Import at most ${String(MAX_IMPORTED_TOOLS)} tools; select them with --tools`,
    );

  const readOnly = effects.every((effect) => READ_EFFECTS.has(effect));
  const entries: CatalogTool[] = [];
  const report: CatalogImportReport[] = [];
  for (const name of names) {
    const shown = escapeUnsafeText(JSON.stringify(name));
    const tool = byName.get(name);
    if (tool === undefined)
      throw new Error(`Downstream does not list a tool named ${shown}`);
    if (!TOOL_NAME.test(name))
      throw new Error(`Tool name ${shown} must match [A-Za-z0-9_.-]{1,128}`);
    const toolRef = `${options.serverRef}.${name}`;
    if (toolRef.length > MAX_TOOL_REF)
      throw new Error(`Tool reference for ${shown} exceeds 256 characters`);
    if (
      Buffer.byteLength(canonicalJson(tool.inputSchema)) >
      MAX_IMPORTED_SCHEMA_BYTES
    )
      throw new Error(`Input schema for ${shown} exceeds 64 KiB`);
    const warnings: string[] = [];
    if (readOnly && tool.annotations?.readOnlyHint !== true)
      warnings.push(
        "declared read-only, but the downstream does not annotate readOnlyHint: true",
      );
    if (tool.annotations?.destructiveHint === true)
      warnings.push("the downstream annotates this tool as destructive");
    if (readOnly && writeShaped(name))
      warnings.push(
        "declared read-only, but the name suggests it changes state",
      );
    entries.push({
      toolRef,
      serverRef: options.serverRef,
      toolName: name,
      description: catalogDescription(tool.description, name),
      inputSchema: tool.inputSchema,
      effects,
      ...(options.scopes === undefined || options.scopes.length === 0
        ? {}
        : { scopes: [...new Set(options.scopes)].sort() }),
      ...(options.filesystemRoots === undefined ||
      options.filesystemRoots.length === 0
        ? {}
        : { filesystemRoots: [...new Set(options.filesystemRoots)].sort() }),
      artifactDigest: options.artifactDigest,
    });
    report.push({
      toolRef,
      schemaDigest: digestCanonical(tool.inputSchema),
      warnings,
    });
  }
  return { entries, report };
}
