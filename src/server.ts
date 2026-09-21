import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { demoCatalog, demoPolicy } from "./demo-config.js";
import type { ReproGateExecutor } from "./executor.js";
import { ReproGateKernel } from "./kernel.js";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function createDemoKernel(): ReproGateKernel {
  return new ReproGateKernel(demoCatalog, demoPolicy);
}

export function createReproGateServer(
  kernel = createDemoKernel(),
  executor?: ReproGateExecutor,
): McpServer {
  const server = new McpServer({ name: "mcp-repro-gate", version: "0.0.0" });

  server.registerTool(
    "catalog.search",
    {
      description:
        "Search the trusted downstream tool catalog without exposing every schema",
      inputSchema: z.object({
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    ({ query, limit }) =>
      result({
        tools: kernel.search(query, limit).map((tool) => ({
          toolRef: tool.toolRef,
          description: tool.description,
          effects: tool.effects,
        })),
      }),
  );

  server.registerTool(
    "action.plan",
    {
      description:
        "Create a digest-bound action envelope and evaluate deterministic policy; this Phase 1 tool never executes the action",
      inputSchema: z.object({
        toolRef: z.string().min(1),
        arguments: z.unknown(),
      }),
    },
    ({ toolRef, arguments: toolArguments }) => {
      try {
        return result(kernel.plan({ toolRef, arguments: toolArguments }));
      } catch (error) {
        return {
          ...result({
            error:
              error instanceof Error ? error.message : "Unknown planning error",
          }),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "policy.explain",
    {
      description:
        "Explain the deterministic decision for a previously planned action",
      inputSchema: z.object({ actionId: z.string().min(1) }),
    },
    ({ actionId }) => {
      const plan = kernel.explain(actionId);
      if (plan === undefined) {
        return {
          ...result({ error: `Unknown actionId: ${actionId}` }),
          isError: true,
        };
      }
      return result({ actionId, policy: plan.policy });
    },
  );

  if (executor !== undefined) {
    server.registerTool(
      "action.execute",
      {
        description:
          "Execute one previously planned action using an exact, one-use out-of-band approval capability",
        inputSchema: z.object({
          actionId: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()),
          capabilityToken: z.string().min(1),
        }),
      },
      async ({ actionId, arguments: toolArguments, capabilityToken }) => {
        try {
          return result(
            await executor.execute({
              actionId,
              arguments: toolArguments,
              capabilityToken,
            }),
          );
        } catch (error) {
          return {
            ...result({
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown execution error",
            }),
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
