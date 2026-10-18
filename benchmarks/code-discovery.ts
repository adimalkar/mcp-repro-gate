import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod/v4";

export const SOURCE_REVISION = "6eabc20f04f1a0fe9edede5ab36a4338000bd155";
export const FIXTURE_VERSION = 1;
const PROJECT = "reprogate-discovery-v1";
const MAX_OUTPUT = 16 * 1024 * 1024;

// Fixed before measuring: locations and implementation fragments come from
// the pinned source, not from the graph. These are lookup/read tasks only.
export const TASKS = [
  {
    symbol: "canonicalJson",
    file: "src/canonical-json.ts",
    answer: "const keys = Object.keys(record).sort();",
  },
  {
    symbol: "evaluatePolicy",
    file: "src/policy.ts",
    answer: "severity[reason.decision] > severity[current]",
  },
  {
    symbol: "issueCapabilityToken",
    file: "src/capability-token.ts",
    answer: "scopes: [...new Set(input.scopes)].sort(),",
  },
  {
    symbol: "verifyExecutionReceipt",
    file: "src/receipt.ts",
    answer: "timingSafeEqual(received, expected)",
  },
  {
    symbol: "deriveGitApprovalAuthorityFromPlan",
    file: "src/git-plan-binding.ts",
    answer: "const plan = context.plans.get(proposal.actionId);",
  },
  {
    symbol: "loadGitReviewConfigSnapshot",
    file: "src/git-review-config.ts",
    answer: "const paths = resolveGitReviewStatePaths(config, options);",
  },
] as const;

type Task = (typeof TASKS)[number];
export interface Exchange {
  request: unknown;
  response: unknown;
}

const objectSchema = z.record(z.string(), z.unknown());
const resultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: objectSchema.optional(),
});

/** Check the envelope before decoding its payload; never score an error. */
export function toolPayload(result: unknown): Record<string, unknown> {
  const parsed = resultSchema.parse(result);
  if (parsed.isError === true) throw new Error("Graph tool returned isError");
  const value: unknown =
    parsed.structuredContent ??
    JSON.parse(parsed.content.find((item) => item.type === "text")?.text ?? "");
  const payload = objectSchema.parse(value);
  if (payload.error !== undefined || payload.truncated === true)
    throw new Error("Graph tool returned an error or truncated payload");
  return payload;
}

const hitSchema = z.object({
  name: z.string(),
  qualified_name: z.string().min(1),
  file_path: z.string(),
});

export function checkedHit(result: unknown, task: Task): string {
  const payload = z
    .object({
      total: z.literal(1),
      has_more: z.literal(false),
      results: z.array(hitSchema).length(1),
    })
    .parse(toolPayload(result));
  const hit = payload.results[0];
  if (hit?.name !== task.symbol || hit.file_path !== task.file)
    throw new Error("Wrong graph location for " + task.symbol);
  return hit.qualified_name;
}

/** Require exact pinned lines, not just an answer somewhere in the response. */
export function checkedSnippet(
  result: unknown,
  task: Task,
  corpus: string,
): void {
  const payload = z
    .object({
      name: z.literal(task.symbol),
      file_path: z.string(),
      start_line: z.number().int().positive(),
      end_line: z.number().int().positive(),
      source: z.string().min(1),
    })
    .parse(toolPayload(result));
  if (
    resolve(payload.file_path) !== resolve(corpus, task.file) ||
    payload.end_line < payload.start_line
  )
    throw new Error("Wrong snippet location for " + task.symbol);
  const file = readFileSync(join(corpus, task.file), "utf8");
  const lines = file.split("\n");
  if (payload.end_line > lines.length)
    throw new Error("Snippet extends past pinned source for " + task.symbol);
  const expected = lines
    .slice(payload.start_line - 1, payload.end_line)
    .join("\n");
  if (
    payload.source.replace(/\n$/u, "") !== expected ||
    !payload.source.includes("export function " + task.symbol + "(") ||
    !payload.source.includes(task.answer)
  )
    throw new Error(
      "Snippet does not contain pinned implementation for " + task.symbol,
    );
}

/** Parse every match; a partial/invalid baseline must not look like savings. */
export function matchedFiles(output: string, task: Task): string[] {
  const lines = output.trimEnd().split("\n");
  const files = new Set<string>();
  for (const line of lines) {
    const match = /^(src\/[A-Za-z0-9_./-]+\.ts):[1-9][0-9]*:(.*)$/u.exec(line);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[1].split("/").includes("..") ||
      !match[2].includes(task.symbol)
    )
      throw new Error("Invalid or empty rg output");
    files.add(match[1]);
  }
  if (!files.has(task.file))
    throw new Error("rg did not find expected file for " + task.symbol);
  return [...files].sort();
}

function bytes(value: unknown): number {
  // CLI/file reads are raw UTF-8; MCP responses are complete JSON result
  // payloads, including both content channels and metadata when present.
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

export function measurement(exchanges: readonly Exchange[]) {
  return {
    calls: exchanges.length,
    requestBytes: exchanges.reduce((sum, item) => sum + bytes(item.request), 0),
    responseBytes: exchanges.reduce(
      (sum, item) => sum + bytes(item.response),
      0,
    ),
  };
}

function comparison(graph: readonly Exchange[], baseline: readonly Exchange[]) {
  const measured = measurement(graph);
  const reference = measurement(baseline);
  if (measured.responseBytes === 0 || reference.responseBytes === 0)
    throw new Error("Empty output is not a successful measurement");
  return {
    graph: measured,
    baseline: reference,
    responseByteReduction: 1 - measured.responseBytes / reference.responseBytes,
  };
}

function command(
  executable: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  return execFileSync(executable, args, {
    cwd,
    ...(env === undefined ? {} : { env }),
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
    timeout: 300_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function digest(data: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Ensure the measured corpus still equals its Git-derived manifest. */
export function checkCorpus(
  corpus: string,
  manifest: readonly { file: string; digest: string }[],
): void {
  const files = (directory: string): string[] =>
    readdirSync(join(corpus, directory), { withFileTypes: true }).flatMap(
      (entry) => {
        const path = directory + "/" + entry.name;
        if (entry.isDirectory()) return files(path);
        if (!entry.isFile())
          throw new Error("Corpus contains a non-regular file");
        return [path];
      },
    );
  if (
    JSON.stringify(files("src").sort()) !==
    JSON.stringify(manifest.map((item) => item.file).sort())
  )
    throw new Error("Corpus file list changed during measurement");
  for (const item of manifest)
    if (digest(readFileSync(join(corpus, item.file))) !== item.digest)
      throw new Error("Corpus source changed during measurement: " + item.file);
}

/** Export only regular src blobs from Git; never use worktree file content. */
export function exportCorpus(repository: string, corpus: string) {
  const tree = command(
    "git",
    ["ls-tree", "-r", "-z", SOURCE_REVISION, "src"],
    repository,
  );
  const manifest = tree
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match =
        /^100644 blob ([0-9a-f]{40})\t(src\/[A-Za-z0-9_./-]+\.ts)$/u.exec(
          entry,
        );
      if (
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[2].split("/").includes("..")
      )
        throw new Error("Corpus contains an unsupported path, mode or object");
      const file = match[2];
      const source = command("git", ["cat-file", "blob", match[1]], repository);
      mkdirSync(dirname(join(corpus, file)), { recursive: true });
      writeFileSync(join(corpus, file), source);
      return { file, bytes: Buffer.byteLength(source), digest: digest(source) };
    });
  if (manifest.length === 0) throw new Error("Pinned source tree is empty");
  for (const task of TASKS) {
    const source = readFileSync(join(corpus, task.file), "utf8");
    if (
      !source.includes("export function " + task.symbol + "(") ||
      !source.includes(task.answer)
    )
      throw new Error(
        "Fixture answer does not match pinned source for " + task.symbol,
      );
  }
  return {
    revision: SOURCE_REVISION,
    gitSourceTree: command(
      "git",
      ["rev-parse", SOURCE_REVISION + ":src"],
      repository,
    ).trim(),
    manifest,
    manifestDigest: digest(JSON.stringify(manifest)),
  };
}

export async function runCodeDiscoveryBenchmark(
  repository: string,
  graphBinary: string,
  rgBinary = "rg",
) {
  // Require an explicit local binary; never download a server. The graph
  // server is trusted local software, not sandboxed by this harness.
  const binary = realpathSync(graphBinary);
  const binaryDigest = digest(readFileSync(binary));
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-discovery-"));
  const env = {
    ...getDefaultEnvironment(),
    PATH: process.env.PATH ?? "",
    CBM_CACHE_DIR: join(scratch, "cache"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_CACHE_HOME: join(scratch, "cache"),
    XDG_DATA_HOME: join(scratch, "data"),
  };
  const client = new Client({
    name: "reprogate-discovery-bench",
    version: "1.0.0",
  });
  try {
    const corpus = join(scratch, "corpus");
    mkdirSync(corpus);
    const source = exportCorpus(repository, corpus);
    // All persisted config lives in this run's CBM_CACHE_DIR, verified with
    // codebase-memory-mcp 0.9.0. Do not touch the operator's default cache.
    for (const key of ["auto_watch", "auto_index"])
      command(binary, ["config", "set", key, "false"], scratch, env);
    const settings = command(binary, ["config", "list"], scratch, env);
    for (const key of ["auto_watch", "auto_index"])
      if (!new RegExp(key + "\\s*=\\s*false\\b", "u").test(settings))
        throw new Error("Graph configuration did not disable " + key);
    const graphVersion = command(binary, ["--version"], scratch, env).trim();
    const rgVersion = command(rgBinary, ["--version"], scratch).trim();
    await client.connect(
      new StdioClientTransport({
        command: binary,
        args: ["--ui=false"],
        cwd: scratch,
        env,
        stderr: "ignore",
      }),
    );
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Exchange> => {
      const request = { name, arguments: args };
      const response = await client.callTool(request, { timeout: 300_000 });
      toolPayload(response);
      return { request, response };
    };
    const indexed = await call("index_repository", {
      repo_path: corpus,
      name: PROJECT,
      mode: "fast",
      persistence: false,
    });
    const index = z
      .object({
        project: z.literal(PROJECT),
        status: z.literal("indexed"),
        skipped_count: z.literal(0),
        nodes: z.number().int().positive(),
        expected_nodes: z.number().int().positive(),
        edges: z.number().int().nonnegative(),
        expected_edges: z.number().int().nonnegative(),
      })
      .parse(toolPayload(indexed.response));
    if (
      index.nodes !== index.expected_nodes ||
      index.edges !== index.expected_edges
    )
      throw new Error("Graph index is incomplete");
    const tasks = [];
    for (const task of TASKS) {
      const search = await call("search_graph", {
        project: PROJECT,
        name_pattern: "^" + task.symbol + "$",
        label: "Function",
        limit: 10,
      });
      const qualified = checkedHit(search.response, task);
      const snippet = await call("get_code_snippet", {
        project: PROJECT,
        qualified_name: qualified,
      });
      checkedSnippet(snippet.response, task, corpus);
      const rgArgs = [
        "--no-config",
        "--no-ignore",
        "--color",
        "never",
        "--sort",
        "path",
        "--with-filename",
        "--line-number",
        "--word-regexp",
        "--fixed-strings",
        "--",
        task.symbol,
        "src",
      ];
      const grep: Exchange = {
        request: { command: rgBinary, args: rgArgs },
        response: command(rgBinary, rgArgs, corpus),
      };
      const files = matchedFiles(String(grep.response), task);
      const reads = files.map((file): Exchange => ({
        request: { operation: "readFile", path: file },
        response: readFileSync(join(corpus, file), "utf8"),
      }));
      const answerFile = reads[files.indexOf(task.file)]?.response;
      if (typeof answerFile !== "string" || !answerFile.includes(task.answer))
        throw new Error("Baseline is missing answer for " + task.symbol);
      tasks.push({
        ...task,
        answersChecked: true,
        location: comparison([search], [grep]),
        implementation: comparison([search, snippet], [grep, ...reads]),
        transcripts: { graph: [search, snippet], baseline: [grep, ...reads] },
      });
    }
    checkCorpus(corpus, source.manifest);
    if (digest(readFileSync(binary)) !== binaryDigest)
      throw new Error("Graph binary changed during measurement");
    const median = (values: number[]) => {
      const ordered = values.sort((a, b) => a - b);
      const middle = Math.floor(ordered.length / 2);
      return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
    };
    const medianLocationReduction = median(
      tasks.map((task) => task.location.responseByteReduction),
    );
    const medianImplementationReduction = median(
      tasks.map((task) => task.implementation.responseByteReduction),
    );
    return {
      fixtureVersion: FIXTURE_VERSION,
      unit: "utf8-bytes",
      measuredAt: new Date().toISOString(),
      tools: { graphVersion, binaryDigest, rgVersion, node: process.version },
      source,
      setup: { settings, indexed, excludedFromTaskMeasurements: true },
      tasks,
      medianLocationReduction,
      medianImplementationReduction,
      target: {
        threshold: 0.9,
        locationMet: medianLocationReduction > 0.9,
        implementationMet: medianImplementationReduction > 0.9,
        hostTokenClaim: false,
      },
    };
  } finally {
    try {
      await client.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--graph-bin" || args[1] === undefined)
    throw new Error(
      "Usage: npm run bench:code-discovery -- --graph-bin /absolute/path/to/codebase-memory-mcp",
    );
  // Compiled module lives in dist/benchmarks/.
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const report = await runCodeDiscoveryBenchmark(repository, args[1]);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : "Benchmark failed") + "\n",
    );
    process.exitCode = 1;
  });
