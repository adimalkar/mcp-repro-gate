import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

// A stdio relay for the benchmark. Store sizes and tool names only, never
// arguments, source, credentials, or raw tool responses.
export interface WireSample {
  method: string;
  tool?: string;
  bytes: number;
  error: boolean;
  graphTool?: string;
}

export const GRAPH_TOOLS = ["search_graph", "get_code_snippet"];
export const GRAPH_ENV = [
  "CBM_CACHE_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
];
export const ENV_PREFIX = "REPROGATE_BENCH_";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function main() {
  const [log, surface, command, ...args] = process.argv.slice(2);
  if (!log || (surface !== "direct" && surface !== "facade") || !command)
    throw new Error("Missing relay arguments");
  const allowed = surface === "direct" ? new Set(GRAPH_TOOLS) : undefined;
  const pending = new Map<unknown, Omit<WireSample, "bytes" | "error">>();
  const plans = new Map<string, string>();
  const env = allowed
    ? {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(
          GRAPH_ENV.map((key) => [key, process.env[ENV_PREFIX + key]]),
        ),
      }
    : process.env;
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env,
  });
  const client = createInterface({ input: process.stdin });
  const server = createInterface({ input: child.stdout });
  const send = (message: object) => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };
  const record = (sample: WireSample) => {
    appendFileSync(log, JSON.stringify(sample) + "\n", { mode: 0o600 });
  };

  client.on("line", (line) => {
    const message = object(JSON.parse(line));
    const method = message.method;
    if (
      (method === "tools/list" || method === "tools/call") &&
      "id" in message
    ) {
      const params = object(message.params);
      const tool = params.name;
      if (
        method === "tools/call" &&
        allowed &&
        (typeof tool !== "string" || !allowed.has(tool))
      ) {
        const error = {
          code: -32602,
          message: "Tool is outside this benchmark",
        };
        record({
          method,
          tool: "unlisted",
          bytes: Buffer.byteLength(JSON.stringify(error)),
          error: true,
        });
        send({
          jsonrpc: "2.0",
          id: message.id,
          error,
        });
        return;
      }
      const actionId = object(params.arguments).actionId;
      const graphTool =
        tool === "action.run" && typeof actionId === "string"
          ? plans.get(actionId)
          : undefined;
      pending.set(message.id, {
        method,
        ...(typeof tool === "string" ? { tool } : {}),
        ...(graphTool ? { graphTool } : {}),
      });
    }
    child.stdin.write(line + "\n");
  });

  server.on("line", (line) => {
    const message = object(JSON.parse(line));
    // A server request can use the same id as a client request.
    const request = "method" in message ? undefined : pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      const result = object(message.result);
      const payload = object(result.structuredContent);
      if (
        request.tool === "action.plan" &&
        typeof payload.actionId === "string"
      ) {
        const graphTool = GRAPH_TOOLS.find(
          (tool) => "graph." + tool === payload.toolRef,
        );
        if (graphTool) plans.set(payload.actionId, graphTool);
      }
      if (
        request.method === "tools/list" &&
        allowed &&
        Array.isArray(result.tools)
      )
        result.tools = result.tools.filter((tool: unknown) => {
          const name = object(tool).name;
          return typeof name === "string" && allowed.has(name);
        });
      const sample: WireSample = {
        ...request,
        bytes: Buffer.byteLength(
          JSON.stringify(message.result ?? message.error ?? null),
        ),
        error:
          "error" in message ||
          result.isError === true ||
          (request.tool === "action.run" && payload.outcome !== "succeeded"),
      };
      record(sample);
    }
    send(message);
  });
  client.on("close", () => {
    child.stdin.end();
  });
  child.on("error", (error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
    client.close();
    process.stdin.destroy();
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
    client.close();
    process.stdin.destroy();
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main();
