import { isAbsolute } from "node:path";

import {
  EFFECT_CLASSES,
  importCatalogEntries,
  type CatalogImportResult,
} from "./catalog-import.js";
import { StdioMcpConnector } from "./downstream.js";
import { sha256File } from "./file-digest.js";
import { loadImportBackend } from "./runtime-config.js";
import type { EffectClass } from "./types.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const IMPORT_USAGE =
  "Usage: reprogate catalog import --config <absolute-path> --backend <name> --effects <effect[,effect]> [--tools <name[,name]>] [--filesystem-root <absolute-path>]... [--scope <scope>]...";

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Host-side: print reviewed-ready catalog entries for one backend. */
export async function runCatalogImport(
  args: readonly string[],
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CatalogImportResult> {
  const single = new Map<string, string>();
  const repeated: Record<"--filesystem-root" | "--scope", string[]> = {
    "--filesystem-root": [],
    "--scope": [],
  };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || value === undefined || value.startsWith("--"))
      throw new Error(IMPORT_USAGE);
    if (option === "--filesystem-root" || option === "--scope") {
      repeated[option].push(value);
    } else if (
      ["--config", "--backend", "--effects", "--tools"].includes(option) &&
      !single.has(option)
    ) {
      single.set(option, value);
    } else {
      throw new Error(IMPORT_USAGE);
    }
  }
  const configPath = single.get("--config");
  const serverRef = single.get("--backend");
  const effectList = single.get("--effects");
  if (
    configPath === undefined ||
    serverRef === undefined ||
    effectList === undefined
  )
    throw new Error(IMPORT_USAGE);
  const effects = list(effectList);
  for (const effect of effects)
    if (!EFFECT_CLASSES.includes(effect as EffectClass))
      throw new Error(
        `Unknown effect ${effect}; use ${EFFECT_CLASSES.join(", ")}`,
      );
  for (const root of repeated["--filesystem-root"])
    if (!isAbsolute(root))
      throw new Error("--filesystem-root must be an absolute path");

  const backend = await loadImportBackend(configPath, serverRef, environment);
  const listed = await new StdioMcpConnector({
    [serverRef]: backend,
  }).describeTools(serverRef, backend.artifact.digest);
  const tools = single.get("--tools");
  const result = importCatalogEntries(listed, {
    serverRef,
    artifactDigest: backend.artifact.digest,
    effects: effects as EffectClass[],
    ...(tools === undefined ? {} : { tools: list(tools) }),
    filesystemRoots: repeated["--filesystem-root"],
    scopes: repeated["--scope"],
  });
  io.stdout(`${JSON.stringify(result.entries, null, 2)}\n`);
  for (const { toolRef, schemaDigest, warnings } of result.report) {
    io.stderr(`${toolRef} ${schemaDigest}\n`);
    for (const warning of warnings)
      io.stderr(`  warning: ${toolRef}: ${warning}\n`);
  }
  io.stderr(
    "Review every entry's effects before adding it to the catalog; import grants nothing.\n",
  );
  return result;
}

/** Print the artifact digest that backend and catalog pins require. */
export async function runArtifactDigest(
  args: readonly string[],
  io: CliIo,
): Promise<void> {
  const path = args[0];
  if (args.length !== 1 || path === undefined || !isAbsolute(path))
    throw new Error("Usage: reprogate artifact digest <absolute-path>");
  io.stdout(`${await sha256File(path)}\n`);
}
