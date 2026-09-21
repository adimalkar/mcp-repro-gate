import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import * as z from "zod/v4";

import { digestCanonical } from "./digest.js";
import { StdioMcpConnector, type StdioBackendConfig } from "./downstream.js";
import { SqliteExecutionStore } from "./execution-store.js";
import { ReproGateExecutor } from "./executor.js";
import { sha256File } from "./file-digest.js";
import { FilesystemManifestObserver } from "./filesystem-observer.js";
import { ReproGateKernel } from "./kernel.js";
import type { CatalogTool, PolicyV1 } from "./types.js";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const effectSchema = z.enum([
  "local_read",
  "local_write",
  "process_exec",
  "network_read",
  "network_write",
  "credential_use",
  "destructive",
]);
const decisionSchema = z.enum(["allow", "approval_required", "deny"]);
const stringArray = z.array(z.string().min(1));

const catalogToolSchema = z
  .object({
    toolRef: z.string().min(1),
    serverRef: z.string().min(1),
    toolName: z.string().min(1),
    description: z.string().min(1),
    inputSchema: z.unknown(),
    effects: z.array(effectSchema).min(1),
    scopes: stringArray.optional(),
    filesystemRoots: stringArray.optional(),
    networkDestinations: stringArray.optional(),
    secretHandles: stringArray.optional(),
    sensitivityLabels: stringArray.optional(),
    artifactDigest: digestSchema,
  })
  .strict();

const policySchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        local_read: decisionSchema,
        local_write: decisionSchema,
        process_exec: decisionSchema,
        network_read: decisionSchema,
        network_write: decisionSchema,
        credential_use: decisionSchema,
        destructive: decisionSchema,
      })
      .strict(),
    rules: z.array(
      z
        .object({
          id: z.string().min(1),
          priority: z.number().int(),
          match: z
            .object({
              toolRef: z.string().min(1).optional(),
              effect: effectSchema.optional(),
            })
            .strict(),
          decision: decisionSchema,
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const backendSchema = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    environment: z
      .object({
        inherit: z.enum(["safe", "none"]),
        from: z.record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
        ),
      })
      .strict(),
    artifact: z
      .object({ path: z.string().min(1), digest: digestSchema })
      .strict(),
  })
  .strict();

const runtimeConfigSchema = z
  .object({
    configVersion: z.literal(1),
    databasePath: z.string().min(1),
    catalog: z.array(catalogToolSchema).min(1),
    policy: policySchema,
    backends: z.record(z.string().min(1), backendSchema),
    observer: z
      .object({
        kind: z.literal("filesystem_manifest"),
        roots: z.array(z.string().min(1)).min(1),
        maxEntries: z.number().int().positive().optional(),
        maxBytes: z.number().int().positive().optional(),
      })
      .strict(),
    secrets: z
      .object({
        capabilitySecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
        receiptSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
        receiptKeyId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type RuntimeConfigV1 = z.infer<typeof runtimeConfigSchema>;

export interface ConfiguredRuntime {
  config: RuntimeConfigV1;
  kernel: ReproGateKernel;
  executor: ReproGateExecutor;
  store: SqliteExecutionStore;
  recoveredExecutions: number;
  close(): void;
}

const safeEnvironmentNames = [
  "COMSPEC",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
] as const;

function assertAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
}

function assertRegularFile(path: string, label: string): void {
  if (!lstatSync(path).isFile())
    throw new Error(`${label} must be a regular file`);
}

function assertDirectory(path: string, label: string): void {
  if (!lstatSync(path).isDirectory())
    throw new Error(`${label} must be a directory`);
}

function safeEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of safeEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function resolveBackendEnvironment(
  config: RuntimeConfigV1["backends"][string]["environment"],
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const result = config.inherit === "safe" ? safeEnvironment(source) : {};
  for (const [targetName, sourceName] of Object.entries(config.from)) {
    const value = source[sourceName];
    if (value === undefined) {
      throw new Error(
        `Backend environment source ${sourceName} for ${targetName} is not set`,
      );
    }
    result[targetName] = value;
  }
  return result;
}

function requiredSecret(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (value === undefined || Buffer.byteLength(value) < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

export function loadRuntimeConfig(path: string): RuntimeConfigV1 {
  assertAbsolute(path, "Runtime config path");
  const descriptor = openSync(path, "r");
  let contents: string;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("Runtime config must be a regular file");
    }
    contents = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (Buffer.byteLength(contents) > 1024 * 1024) {
    throw new Error("Runtime config exceeds the 1 MiB limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("Runtime config is not valid JSON", { cause: error });
  }
  const config = runtimeConfigSchema.parse(parsed);
  validateRuntimeConfig(config);
  return config;
}

export function validateRuntimeConfig(config: RuntimeConfigV1): void {
  assertAbsolute(config.databasePath, "databasePath");
  assertDirectory(dirname(config.databasePath), "databasePath parent");

  const observerRoots = new Set(
    config.observer.roots.map((root) => {
      assertAbsolute(root, "observer root");
      assertDirectory(root, "observer root");
      return resolve(root);
    }),
  );
  if (observerRoots.size !== config.observer.roots.length) {
    throw new Error("Observer roots must be unique");
  }

  const backendNames = new Set(Object.keys(config.backends));
  const referencedBackends = new Set<string>();
  const toolRefs = new Set<string>();
  for (const tool of config.catalog) {
    if (toolRefs.has(tool.toolRef)) {
      throw new Error(`Duplicate catalog toolRef: ${tool.toolRef}`);
    }
    toolRefs.add(tool.toolRef);
    digestCanonical(tool.inputSchema);
    const backend = config.backends[tool.serverRef];
    if (backend === undefined) {
      throw new Error(
        `Catalog tool references missing backend: ${tool.serverRef}`,
      );
    }
    referencedBackends.add(tool.serverRef);
    if (tool.artifactDigest !== backend.artifact.digest) {
      throw new Error(`Catalog artifact digest differs for ${tool.toolRef}`);
    }
    for (const root of tool.filesystemRoots ?? []) {
      assertAbsolute(root, `filesystem root for ${tool.toolRef}`);
      if (!observerRoots.has(resolve(root))) {
        throw new Error(
          `Catalog tool ${tool.toolRef} uses an unobserved filesystem root`,
        );
      }
    }
  }
  if (
    referencedBackends.size !== backendNames.size ||
    [...backendNames].some((name) => !referencedBackends.has(name))
  ) {
    throw new Error(
      "Every configured backend must be referenced by the catalog",
    );
  }

  for (const [serverRef, backend] of Object.entries(config.backends)) {
    assertAbsolute(backend.command, `command for ${serverRef}`);
    assertRegularFile(backend.command, `command for ${serverRef}`);
    if (backend.cwd !== undefined) {
      assertAbsolute(backend.cwd, `cwd for ${serverRef}`);
      assertDirectory(backend.cwd, `cwd for ${serverRef}`);
    }
    assertAbsolute(backend.artifact.path, `artifact path for ${serverRef}`);
    assertRegularFile(backend.artifact.path, `artifact path for ${serverRef}`);
  }
}

export async function createConfiguredRuntime(
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredRuntime> {
  const config = loadRuntimeConfig(configPath);
  const capabilitySecret = requiredSecret(
    environment,
    config.secrets.capabilitySecretEnv,
  );
  const receiptSecret = requiredSecret(
    environment,
    config.secrets.receiptSecretEnv,
  );
  if (capabilitySecret === receiptSecret) {
    throw new Error("Capability and receipt signing secrets must be different");
  }

  const backends: Record<string, StdioBackendConfig> = {};
  for (const [serverRef, backend] of Object.entries(config.backends)) {
    const observedDigest = await sha256File(backend.artifact.path);
    if (observedDigest !== backend.artifact.digest) {
      throw new Error(
        `Configured artifact digest does not match the file for ${serverRef}`,
      );
    }
    backends[serverRef] = {
      command: backend.command,
      args: [...backend.args],
      ...(backend.cwd === undefined ? {} : { cwd: backend.cwd }),
      env: resolveBackendEnvironment(backend.environment, environment),
      artifact: {
        path: backend.artifact.path,
        digest: backend.artifact.digest,
      },
    };
  }

  const observer = new FilesystemManifestObserver({
    roots: [...config.observer.roots],
    ...(config.observer.maxEntries === undefined
      ? {}
      : { maxEntries: config.observer.maxEntries }),
    ...(config.observer.maxBytes === undefined
      ? {}
      : { maxBytes: config.observer.maxBytes }),
  });
  const store = new SqliteExecutionStore(config.databasePath);
  try {
    const recoveredExecutions = store.recoverIncomplete();
    const kernel = new ReproGateKernel(
      config.catalog as CatalogTool[],
      config.policy as PolicyV1,
      store,
    );
    const executor = new ReproGateExecutor(
      store,
      new StdioMcpConnector(backends),
      observer,
      capabilitySecret,
      receiptSecret,
      config.secrets.receiptKeyId,
    );
    let closed = false;
    return {
      config,
      kernel,
      executor,
      store,
      recoveredExecutions,
      close: () => {
        if (closed) return;
        closed = true;
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
