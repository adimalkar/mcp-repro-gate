import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { demoCatalog, demoPolicy } from "./demo-config.js";
import type { ReproGateExecutor } from "./executor.js";
import {
  actionIdInputSchema,
  actionInspectOutputSchema,
  actionRunOutputSchema,
  actionPlanOutputSchema,
  catalogDescribeOutputSchema,
  catalogSearchOutputSchema,
  compactPlan,
  describeCatalogTool,
  fullPlan,
  policyExplainOutputSchema,
  toolRefInputSchema,
} from "./facade.js";
import type { HandoffService } from "./handoff.js";
import { MediationError, type HostMediator } from "./mediation.js";
import {
  HandoffError,
  handoffStatusInputSchema,
  handoffStatusSchema,
  handoffUpdateSchema,
} from "./handoff-contract.js";
import { ReproGateKernel } from "./kernel.js";

// Error results carry text only, so they never have to satisfy outputSchema.
function error(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

// Stable codes only: never echo file contents, SQL, or host paths.
function handoffResult(operation: () => unknown) {
  try {
    return result(operation());
  } catch (error) {
    const code = error instanceof HandoffError ? error.code : "unavailable";
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ error: code }) },
      ],
      isError: true,
    };
  }
}

export function createDemoKernel(): ReproGateKernel {
  return new ReproGateKernel(demoCatalog, demoPolicy);
}

export function createReproGateServer(
  kernel = createDemoKernel(),
  executor?: ReproGateExecutor,
  handoff?: HandoffService,
  mediator?: HostMediator,
): McpServer {
  const server = new McpServer({ name: "mcp-repro-gate", version: "0.0.0" });

  const executorConfigured = executor !== undefined;
  const readOnly = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    "catalog.search",
    {
      description:
        "Search the trusted downstream tool catalog by name and description; returns no schemas. Use catalog.describe for one tool's input schema",
      inputSchema: z.object({
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      outputSchema: catalogSearchOutputSchema,
      annotations: readOnly,
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
    "catalog.describe",
    {
      description:
        "Return one catalog tool's input schema, effects, declared authority and the schemaDigest a plan for it binds",
      inputSchema: z.object({ toolRef: toolRefInputSchema }),
      outputSchema: catalogDescribeOutputSchema,
      annotations: readOnly,
    },
    ({ toolRef }) => {
      const tool = kernel.describe(toolRef);
      if (tool === undefined) {
        return error(`Unknown catalog tool: ${toolRef}`);
      }
      return result(describeCatalogTool(tool));
    },
  );

  server.registerTool(
    "action.plan",
    {
      description:
        'Create and persist a digest-bound action envelope and evaluate deterministic policy; never executes. Returns a compact summary with decision, reasonCodes and nextStep; pass detail "full" or call action.inspect for the full envelope',
      inputSchema: z.object({
        toolRef: toolRefInputSchema,
        arguments: z.unknown(),
        detail: z.enum(["compact", "full"]).default("compact"),
      }),
      outputSchema: actionPlanOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ toolRef, arguments: toolArguments, detail }) => {
      try {
        const plan = kernel.plan({ toolRef, arguments: toolArguments });
        return result(
          detail === "full"
            ? fullPlan(plan, executorConfigured)
            : compactPlan(plan, toolRef, executorConfigured),
        );
      } catch (planError) {
        return error(
          planError instanceof Error
            ? planError.message
            : "Unknown planning error",
        );
      }
    },
  );

  server.registerTool(
    "action.inspect",
    {
      description:
        "Return the complete persisted plan (envelope, envelope digest and policy decision) for one actionId",
      inputSchema: z.object({ actionId: actionIdInputSchema }),
      outputSchema: actionInspectOutputSchema,
      annotations: readOnly,
    },
    ({ actionId }) => {
      const plan = kernel.explain(actionId);
      if (plan === undefined) return error(`Unknown actionId: ${actionId}`);
      return result(fullPlan(plan, executorConfigured));
    },
  );

  server.registerTool(
    "policy.explain",
    {
      description:
        "Explain the deterministic decision for a previously planned action",
      inputSchema: z.object({ actionId: actionIdInputSchema }),
      outputSchema: policyExplainOutputSchema,
      annotations: readOnly,
    },
    ({ actionId }) => {
      const plan = kernel.explain(actionId);
      if (plan === undefined) return error(`Unknown actionId: ${actionId}`);
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
        // Downstream effects are operator-defined; claim nothing narrower.
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
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
        } catch (executionError) {
          // Unchanged result shape: execute declares no outputSchema.
          return {
            ...result({
              error:
                executionError instanceof Error
                  ? executionError.message
                  : "Unknown execution error",
            }),
            isError: true,
          };
        }
      },
    );
  }

  if (executor !== undefined && mediator !== undefined) {
    server.registerTool(
      "action.run",
      {
        description:
          "Run one previously planned action without passing a token: either a plan that policy allows with only host-mediated read effects, or, when enabled, a plan an operator approved on the host. The host issues the one-use capability. Returns a compact receipt summary and redacted, bounded downstream text",
        inputSchema: z.object({
          actionId: actionIdInputSchema,
          arguments: z.record(z.string(), z.unknown()),
        }),
        outputSchema: actionRunOutputSchema,
        // Held approvals let operator-approved plans write, so claim
        // nothing narrower than action.execute does.
        annotations: {
          readOnlyHint: false,
          destructiveHint: mediator.runsApprovedPlans,
          idempotentHint: false,
          openWorldHint: mediator.mediatesNetwork || mediator.runsApprovedPlans,
        },
      },
      async ({ actionId, arguments: toolArguments }) => {
        try {
          return result(
            await mediator.run({ actionId, arguments: toolArguments }),
          );
        } catch (runError) {
          // Refusals are stable codes; executor failures keep their message.
          // Executor and downstream messages are bounded and redacted too.
          return error(
            runError instanceof MediationError
              ? runError.code
              : mediator.redactMessage(
                  runError instanceof Error
                    ? runError.message
                    : "Unknown execution error",
                ),
          );
        }
      },
    );
  }

  if (handoff !== undefined) {
    server.registerTool(
      "handoff_status",
      {
        description:
          "Report the host-configured workspace handoff state with revision, digests and counts; set includeContext for the caller-asserted context. Advisory only: it never authorizes actions",
        inputSchema: handoffStatusInputSchema,
        outputSchema: handoffStatusSchema,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input) => handoffResult(() => handoff.status(input)),
    );
    if (handoff.config.allowUpdates) {
      server.registerTool(
        "handoff_update",
        {
          description:
            "Record a new caller-asserted handoff revision for the host-configured workspace and project it to .agent/handoff.md. Requires the expected revision and document digest from handoff_status; retry with the same updateId. Advisory only: it never authorizes actions or changes plans",
          inputSchema: handoffUpdateSchema,
          outputSchema: handoffStatusSchema,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        (input) => handoffResult(() => handoff.update(input)),
      );
    }
  }

  return server;
}
