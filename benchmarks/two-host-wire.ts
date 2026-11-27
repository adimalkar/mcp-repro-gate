import { z } from "zod/v4";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

// A stdio relay for the benchmark. Store sizes and tool names only, never
// arguments, source, credentials, or raw tool responses.
export const GRAPH_TOOLS = ["search_graph", "get_code_snippet"] as const;
const FACADE_TOOLS = [
  "catalog.search",
  "catalog.describe",
  "action.plan",
  "action.inspect",
  "policy.explain",
  "action.execute",
  "action.run",
] as const;
export const wireSampleSchema = z.strictObject({
  method: z.enum(["tools/list", "tools/call"]),
  tool: z.enum([...GRAPH_TOOLS, ...FACADE_TOOLS, "unlisted"]).optional(),
  bytes: z.number().int().nonnegative(),
  error: z.boolean(),
  graphTool: z.enum(GRAPH_TOOLS).optional(),
});
export type WireSample = z.infer<typeof wireSampleSchema>;
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

/** The pinned graph can return an application error in a successful MCP envelope. */
export function wireCallFailed(
  request: Pick<WireSample, "tool" | "graphTool">,
  message: Record<string, unknown>,
): boolean {
  const result = object(message.result);
  const payload = object(result.structuredContent);
  if ("error" in message || result.isError === true) return true;
  if (request.tool === "action.run" && payload.outcome !== "succeeded")
    return true;
  const mediated =
    request.tool === "action.run" && request.graphTool !== undefined;
  if (!mediated && !GRAPH_TOOLS.some((tool) => tool === request.tool))
    return false;
  if ("error" in payload) return true;
  // Direct replies may be text-only. action.run puts the bounded downstream
  // text inside structuredContent.content, after its own successful receipt.
  const content = mediated ? payload.content : result.content;
  return (
    Array.isArray(content) &&
    content.some((item: unknown) => {
      const block = object(item);
      if (block.type !== "text" || typeof block.text !== "string") return false;
      try {
        return "error" in object(JSON.parse(block.text));
      } catch {
        return false;
      }
    })
  );
}

function main() {
  const [log, surface, command, ...args] = process.argv.slice(2);
  if (!log || (surface !== "direct" && surface !== "facade") || !command)
    throw new Error("Missing relay arguments");
  const allowed =
    surface === "direct" ? new Set<string>(GRAPH_TOOLS) : undefined;
  const pending = new Map<unknown, Omit<WireSample, "bytes" | "error">>();
  const plans = new Map<string, (typeof GRAPH_TOOLS)[number]>();
  const env = allowed
    ? {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(
          GRAPH_ENV.map((key) => {
            const value = process.env[ENV_PREFIX + key];
            if (!value || !isAbsolute(value))
              throw new Error(`Missing isolated graph directory: ${key}`);
            return [key, value];
          }),
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
        ...(typeof tool === "string"
          ? {
              tool:
                [...GRAPH_TOOLS, ...FACADE_TOOLS].find(
                  (name) => name === tool,
                ) ?? "unlisted",
            }
          : {}),
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
        !("error" in message) &&
        result.isError !== true
      ) {
        const full = payload.detail === "full";
        const envelope = object(payload.envelope);
        const identity = object(envelope.tool);
        const actionId = full ? envelope.actionId : payload.actionId;
        const graphTool = GRAPH_TOOLS.find((tool) =>
          full
            ? identity.serverRef === "graph" && identity.toolName === tool
            : payload.toolRef === "graph." + tool,
        );
        if (typeof actionId === "string" && graphTool)
          plans.set(actionId, graphTool);
      }
      if (
        request.method === "tools/list" &&
        allowed &&
        Array.isArray(result.tools)
      )
        result.tools = result.tools.flatMap((value: unknown) => {
          const tool = object(value);
          if (typeof tool.name !== "string" || !allowed.has(tool.name))
            return [];
          // The pinned graph server does not declare these hints. Codex
          // requires explicit read-only metadata in a noninteractive run.
          return [
            {
              ...tool,
              annotations: { ...object(tool.annotations), readOnlyHint: true },
            },
          ];
        });
      const sample: WireSample = {
        ...request,
        bytes: Buffer.byteLength(
          JSON.stringify(message.result ?? message.error ?? null),
        ),
        error: wireCallFailed(request, message),
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
