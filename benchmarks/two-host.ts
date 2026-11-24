import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import {
  checkCorpus,
  exportCorpus,
  TASKS,
  toolPayload,
} from "./code-discovery.js";
import {
  ENV_PREFIX,
  GRAPH_ENV,
  GRAPH_TOOLS,
  object,
  type WireSample,
} from "./two-host-wire.js";

const project = "reprogate-two-host";
const tasks = [TASKS[0], TASKS[1], TASKS[3]] as const;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const relay = fileURLToPath(new URL("./two-host-wire.js", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const budget = {
  timeout: 180_000,
  maxBuffer: 8 * 1024 * 1024,
  encoding: "utf8",
} as const;
type Host = "codex" | "claude";
type Surface = "direct" | "facade";
type Task = (typeof tasks)[number];
const forwardedEnv = [...GRAPH_ENV, "CAPABILITY", "RECEIPT"].map(
  (name) => ENV_PREFIX + name,
);

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)));
}

function parseHost(host: Host, output: string) {
  const events = jsonLines(output).reverse();
  if (host === "codex") {
    const complete = events.find((e) => e.type === "turn.completed");
    const items = events
      .filter((e) => e.type === "item.completed")
      .map((e) => object(e.item));
    return {
      answer: items.find((item) => item.type === "agent_message")?.text,
      usage: object(complete?.usage),
      completed: complete !== undefined,
      shellUsed: items.some((item) => item.type === "command_execution"),
    };
  }
  const result = events.find((e) => e.type === "result");
  return {
    answer: result?.result,
    usage: object(result?.usage),
    completed: result?.is_error === false,
    shellUsed: false, // built-in tools are disabled for this host
  };
}

function hostArgs(
  host: Host,
  model: string,
  cwd: string,
  serverArgs: string[],
) {
  if (host === "codex") {
    return [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "apps",
      "--disable",
      "shell_tool",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "-C",
      cwd,
      "-m",
      model,
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.bench.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.bench.args=${JSON.stringify(serverArgs)}`,
      "-c",
      `mcp_servers.bench.env_vars=${JSON.stringify(forwardedEnv)}`,
      "-c",
      "mcp_servers.bench.required=true",
      "-",
    ];
  }
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--tools",
    "",
    "--strict-mcp-config",
    "--model",
    model,
    "--allowedTools",
    "mcp__bench__*",
    "--mcp-config",
    JSON.stringify({
      mcpServers: { bench: { command: process.execPath, args: serverArgs } },
    }),
  ];
}

function measure(
  host: Host,
  model: string,
  surface: Surface,
  task: Task,
  cwd: string,
  target: string[],
  env: NodeJS.ProcessEnv,
) {
  const log = join(cwd, "wire.jsonl");
  writeFileSync(log, "", { flag: "wx", mode: 0o600 });
  const args = hostArgs(host, model, cwd, [relay, log, surface, ...target]);
  const input = [
    "You are completing a read-only lookup in a public software benchmark. Use only the supplied bench MCP server. Do not use shell or file tools.",
    `Find the definition of the TypeScript function ${task.symbol} in graph project ${project}. Use both search_graph and get_code_snippet.`,
    "With direct graph tools, call search_graph and get_code_snippet directly. With catalog and action tools, discover the graph tools, plan each call, and run it through the action API.",
    'Return only a JSON object with fields "path" (repository-relative file path) and "source" (the entire function definition as a string).',
    "If a tool returns an absolute path, use its src/ suffix.",
  ].join("\n");
  const start = Date.now();
  const run = spawnSync(host, args, { ...budget, cwd, input, env });
  const result = parseHost(
    host,
    typeof run.stdout === "string" ? run.stdout : "",
  );
  const records = jsonLines(
    readFileSync(log, "utf8"),
  ) as unknown as WireSample[];
  const calls = records.filter((sample) => sample.method === "tools/call");
  const lists = records.filter((sample) => sample.method === "tools/list");
  const executed = GRAPH_TOOLS.every((tool) =>
    calls.some(
      (sample) =>
        !sample.error &&
        (surface === "direct"
          ? sample.tool === tool
          : sample.tool === "action.run" && sample.graphTool === tool),
    ),
  );
  let answer: Record<string, unknown> = {};
  if (typeof result.answer === "string") {
    try {
      answer = object(JSON.parse(result.answer.trim()));
    } catch {
      // An answer outside the requested JSON format fails the fixture.
    }
  }
  const complete = run.status === 0 && result.completed;
  const answerCorrect =
    answer.path === task.file &&
    typeof answer.source === "string" &&
    answer.source.includes(`function ${task.symbol}(`) &&
    answer.source.includes(task.answer);
  const bytes = (samples: WireSample[]) =>
    samples.reduce((sum, sample) => sum + sample.bytes, 0);
  const usage = Object.fromEntries(
    [
      "input_tokens",
      "cached_input_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "output_tokens",
    ].flatMap((key) =>
      typeof result.usage[key] === "number" ? [[key, result.usage[key]]] : [],
    ),
  );
  return {
    host,
    model,
    surface,
    task: task.symbol,
    completed: complete,
    status: run.status,
    processError: run.error?.name ?? null,
    pass: complete && !result.shellUsed && executed && answerCorrect,
    answerCorrect,
    executed,
    shellUsed: result.shellUsed,
    durationMs: Date.now() - start,
    toolListResponses: lists.length,
    toolListBytes: bytes(lists),
    toolCallResponses: calls.length,
    toolResultBytes: bytes(calls),
    toolErrors: calls.filter((sample) => sample.error).length,
    toolResultTokens: null,
    usage,
    calls,
  };
}

async function main() {
  const [graph, output, codexModel, claudeModel, count = "3"] =
    process.argv.slice(2);
  if (
    !graph ||
    !output ||
    !codexModel ||
    !claudeModel ||
    !/^[123]$/u.test(count)
  ) {
    throw new Error(
      "Usage: two-host <graph-binary> <report.json> <codex-model> <claude-model> [task-count=3]",
    );
  }
  const outputPath = resolve(output);
  // Reserve the report name before starting paid host calls.
  closeSync(openSync(outputPath, "wx", 0o600));
  const graphPath = realpathSync(graph);
  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), "reprogate-two-host-")),
  );
  const corpus = join(scratch, "corpus");
  const graphEnvironment = {
    CBM_CACHE_DIR: join(scratch, "graph-cache"),
    XDG_CONFIG_HOME: join(scratch, "graph-config"),
    XDG_CACHE_HOME: join(scratch, "graph-cache"),
    XDG_DATA_HOME: join(scratch, "graph-data"),
  };
  // XDG isolation applies to graph processes, not host CLI login state.
  const graphEnv = { ...getDefaultEnvironment(), ...graphEnvironment };
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(graphEnvironment).map(([key, value]) => [
        "REPROGATE_BENCH_" + key,
        value,
      ]),
    ),
    REPROGATE_BENCH_CAPABILITY: randomBytes(32).toString("hex"),
    REPROGATE_BENCH_RECEIPT: randomBytes(32).toString("hex"),
  };
  const command = (bin: string, args: string[], childEnv?: NodeJS.ProcessEnv) =>
    execFileSync(bin, args, {
      ...budget,
      cwd: scratch,
      ...(childEnv ? { env: childEnv } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const saveJson = (path: string, value: unknown) => {
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  };
  try {
    mkdirSync(corpus);
    const { manifest, ...source } = exportCorpus(repo, corpus);
    for (const key of ["auto_watch", "auto_index"])
      command(graphPath, ["config", "set", key, "false"], graphEnv);
    const settings = command(graphPath, ["config", "list"], graphEnv);
    for (const key of ["auto_watch", "auto_index"])
      if (!new RegExp(key + "\\s*=\\s*false\\b", "u").test(settings))
        throw new Error("Graph configuration did not disable " + key);
    const client = new Client({ name: "reprogate-two-host", version: "1.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: graphPath,
          args: ["--ui=false"],
          cwd: scratch,
          env: graphEnv,
          stderr: "ignore",
        }),
      );
      const indexed = toolPayload(
        await client.callTool(
          {
            name: "index_repository",
            arguments: {
              repo_path: corpus,
              name: project,
              mode: "fast",
              persistence: false,
            },
          },
          { timeout: 120_000 },
        ),
      );
      if (
        indexed.project !== project ||
        indexed.status !== "indexed" ||
        indexed.skipped_count !== 0 ||
        typeof indexed.nodes !== "number" ||
        indexed.nodes <= 0 ||
        indexed.nodes !== indexed.expected_nodes ||
        indexed.edges !== indexed.expected_edges
      )
        throw new Error("Pinned corpus graph index is incomplete");
    } finally {
      await client.close();
    }
    const configPath = join(scratch, "reprogate.json");
    const observer = join(scratch, "observer");
    mkdirSync(observer);
    const backends = {
      graph: {
        transport: "stdio",
        command: graphPath,
        args: ["--ui=false"],
        cwd: observer,
        environment: {
          inherit: "safe",
          from: Object.fromEntries(
            Object.keys(graphEnvironment).map((key) => [
              key,
              "REPROGATE_BENCH_" + key,
            ]),
          ),
        },
        artifact: {
          path: graphPath,
          digest:
            "sha256:" +
            createHash("sha256").update(readFileSync(graphPath)).digest("hex"),
        },
      },
    };
    saveJson(configPath, { backends });
    const catalog: unknown = JSON.parse(
      command(
        process.execPath,
        [
          cli,
          "catalog",
          "import",
          "--config",
          configPath,
          "--backend",
          "graph",
          "--effects",
          "local_read",
          "--tools",
          GRAPH_TOOLS.join(","),
        ],
        env,
      ),
    );
    const versions = {
      graph: command(graphPath, ["--version"], graphEnv),
      graphDigest: backends.graph.artifact.digest,
      codex: command("codex", ["--version"]),
      claude: command("claude", ["--version"]),
      node: process.version,
      reprogate: command("git", ["-C", repo, "rev-parse", "HEAD"]),
    };
    const runs: ReturnType<typeof measure>[] = [];
    const report = { benchmarkVersion: 1, source, versions, runs };
    const publish = () => {
      const next = outputPath + ".tmp";
      writeFileSync(next, JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(next, outputPath);
    };
    publish();
    for (const [index, task] of tasks.slice(0, Number(count)).entries()) {
      for (const [host, model] of [
        ["codex", codexModel],
        ["claude", claudeModel],
      ] as const) {
        const order: Surface[] =
          (index + Number(host === "claude")) % 2 === 0
            ? ["direct", "facade"]
            : ["facade", "direct"];
        for (const surface of order) {
          const cwd = join(scratch, task.symbol + "-" + host + "-" + surface);
          mkdirSync(cwd);
          const config = join(cwd, "runtime.json");
          saveJson(config, {
            configVersion: 1,
            databasePath: join(cwd, "ledger.sqlite"),
            catalog,
            backends,
            policy: {
              version: 1,
              defaults: {
                local_read: "allow",
                local_write: "deny",
                process_exec: "deny",
                network_read: "deny",
                network_write: "deny",
                credential_use: "deny",
                destructive: "deny",
              },
              rules: [],
            },
            observer: {
              kind: "filesystem_manifest",
              roots: [observer],
              maxEntries: 16,
              maxBytes: 1024,
            },
            mediation: { effects: ["local_read"] },
            secrets: {
              capabilitySecretEnv: "REPROGATE_BENCH_CAPABILITY",
              receiptSecretEnv: "REPROGATE_BENCH_RECEIPT",
              receiptKeyId: "bench-v1",
            },
          });
          const target =
            surface === "direct"
              ? [graphPath, "--ui=false"]
              : [process.execPath, cli, "serve", "--config", config];
          const run = measure(host, model, surface, task, cwd, target, env);
          checkCorpus(corpus, manifest);
          runs.push(run);
          publish();
          process.stderr.write(
            `${host} ${task.symbol} ${surface}: ${run.pass ? "pass" : "failed"}; ${String(run.toolCallResponses)} calls, ${String(run.toolResultBytes)} bytes\n`,
          );
          if (!run.completed)
            throw new Error(
              `${host} did not complete the turn (status ${String(run.status)})`,
            );
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
