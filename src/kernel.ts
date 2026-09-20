import { randomUUID } from "node:crypto";

import { digestCanonical } from "./digest.js";
import { createActionEnvelope, envelopeDigest } from "./envelope.js";
import { evaluatePolicy } from "./policy.js";
import type {
  ActionEnvelopeV1,
  CatalogTool,
  PolicyDecision,
  PolicyV1,
  Principal,
} from "./types.js";

export interface PlannedAction {
  envelope: ActionEnvelopeV1;
  envelopeDigest: ReturnType<typeof envelopeDigest>;
  policy: PolicyDecision;
}

export interface PlanInput {
  toolRef: string;
  arguments: unknown;
  principal?: Principal;
  runId?: string;
  now?: Date;
  ttlMs?: number;
}

export class ReproGateKernel {
  readonly #catalog: Map<string, CatalogTool>;
  readonly #policy: PolicyV1;
  readonly #plans = new Map<string, PlannedAction>();

  constructor(tools: CatalogTool[], policy: PolicyV1) {
    this.#catalog = new Map(tools.map((tool) => [tool.toolRef, tool]));
    if (this.#catalog.size !== tools.length) {
      throw new Error("Catalog contains duplicate toolRef values");
    }
    this.#policy = policy;
  }

  search(query: string, limit = 10): CatalogTool[] {
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return [...this.#catalog.values()]
      .map((tool) => {
        const haystack = `${tool.toolRef} ${tool.description}`.toLowerCase();
        return {
          tool,
          score: terms.reduce(
            (score, term) => score + (haystack.includes(term) ? 1 : 0),
            0,
          ),
        };
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.tool.toolRef.localeCompare(right.tool.toolRef),
      )
      .slice(0, Math.max(0, Math.min(limit, 50)))
      .map(({ tool }) => tool);
  }

  plan(input: PlanInput): PlannedAction {
    const tool = this.#catalog.get(input.toolRef);
    if (tool === undefined) {
      throw new Error(`Unknown catalog tool: ${input.toolRef}`);
    }

    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? 5 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be a positive safe integer");
    }
    const policy = evaluatePolicy(this.#policy, tool.toolRef, tool.effects);
    const envelope = createActionEnvelope({
      envelopeVersion: 1,
      runId: input.runId ?? randomUUID(),
      principal: input.principal ?? {
        host: "unknown-mcp-host",
        source: "unknown",
      },
      tool: {
        serverRef: tool.serverRef,
        toolName: tool.toolName,
        schemaDigest: digestCanonical(tool.inputSchema),
        trustSource: "operator_catalog",
        ...(tool.artifactDigest === undefined
          ? {}
          : { artifactDigest: tool.artifactDigest }),
      },
      input: {
        argumentsDigest: digestCanonical(input.arguments),
        sensitivityLabels: [...(tool.sensitivityLabels ?? [])].sort(),
      },
      authority: {
        policyDigest: policy.policyDigest,
        effects: [...new Set(tool.effects)].sort(),
        scopes: [...new Set(tool.scopes ?? [])].sort(),
        filesystemRoots: [...new Set(tool.filesystemRoots ?? [])].sort(),
        networkDestinations: [
          ...new Set(tool.networkDestinations ?? []),
        ].sort(),
        secretHandles: [...new Set(tool.secretHandles ?? [])].sort(),
      },
      plannedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    const plan = { envelope, envelopeDigest: envelopeDigest(envelope), policy };
    this.#plans.set(envelope.actionId, plan);
    return plan;
  }

  explain(actionId: string): PlannedAction | undefined {
    return this.#plans.get(actionId);
  }
}
