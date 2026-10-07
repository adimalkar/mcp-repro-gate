import { canonicalJson } from "./canonical-json.js";
import { digestCanonical } from "./digest.js";
import type { DownstreamToolDescription } from "./downstream.js";
import type { CatalogTool, Digest, EffectClass } from "./types.js";

export const MAX_IMPORTED_TOOLS = 128;
export const MAX_IMPORTED_SCHEMA_BYTES = 64 * 1024;
export const MAX_IMPORTED_DESCRIPTION = 2048;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const READ_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "local_read",
  "network_read",
]);
// Names that usually mean a tool changes something. A hint for review only.
const WRITE_SHAPED =
  /(^|[_.-])(delete|remove|write|index|ingest|manage|set|create|update|run|exec|put|post|drop|reset)([_.-]|$)/iu;

export const EFFECT_CLASSES: readonly EffectClass[] = [
  "local_read",
  "local_write",
  "process_exec",
  "network_read",
  "network_write",
  "credential_use",
  "destructive",
];

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

/**
 * Turn a downstream tool listing into catalog entries for operator review.
 * Effects are exactly what the operator declared; downstream annotations
 * and names only produce warnings and never grant or narrow authority.
 */
export function importCatalogEntries(
  listed: readonly DownstreamToolDescription[],
  options: CatalogImportOptions,
): CatalogImportResult {
  if (!TOOL_NAME.test(options.serverRef))
    throw new Error("Backend name must match [A-Za-z0-9_.-]{1,128}");
  const effects = [...new Set(options.effects)].sort();
  if (effects.length === 0)
    throw new Error("Declare at least one effect with --effects");
  for (const effect of effects)
    if (!EFFECT_CLASSES.includes(effect))
      throw new Error(`Unknown effect: ${effect}`);

  const byName = new Map<string, DownstreamToolDescription>();
  for (const tool of listed) {
    if (byName.has(tool.name))
      throw new Error(`Downstream lists ${tool.name} more than once`);
    byName.set(tool.name, tool);
  }
  const names = options.tools ?? [...byName.keys()].sort();
  if (new Set(names).size !== names.length)
    throw new Error("--tools lists a tool more than once");
  if (names.length > MAX_IMPORTED_TOOLS)
    throw new Error(
      `Import at most ${String(MAX_IMPORTED_TOOLS)} tools; select them with --tools`,
    );

  const readOnly = effects.every((effect) => READ_EFFECTS.has(effect));
  const entries: CatalogTool[] = [];
  const report: CatalogImportReport[] = [];
  for (const name of names) {
    const tool = byName.get(name);
    if (tool === undefined)
      throw new Error(`Downstream does not list a tool named ${name}`);
    if (!TOOL_NAME.test(name))
      throw new Error(`Tool name ${name} must match [A-Za-z0-9_.-]{1,128}`);
    if (
      Buffer.byteLength(canonicalJson(tool.inputSchema)) >
      MAX_IMPORTED_SCHEMA_BYTES
    )
      throw new Error(`Input schema for ${name} exceeds 64 KiB`);
    const toolRef = `${options.serverRef}.${name}`;
    const warnings: string[] = [];
    if (readOnly && tool.annotations?.readOnlyHint !== true)
      warnings.push(
        "declared read-only, but the downstream does not annotate readOnlyHint: true",
      );
    if (tool.annotations?.destructiveHint === true)
      warnings.push("the downstream annotates this tool as destructive");
    if (readOnly && WRITE_SHAPED.test(name))
      warnings.push(
        "declared read-only, but the name suggests it changes state",
      );
    const description = (tool.description ?? name).slice(
      0,
      MAX_IMPORTED_DESCRIPTION,
    );
    entries.push({
      toolRef,
      serverRef: options.serverRef,
      toolName: name,
      description,
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
