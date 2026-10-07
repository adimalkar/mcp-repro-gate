import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { sha256File } from "./file-digest.js";
import type { Digest } from "./types.js";

export interface DownstreamTool {
  name: string;
  inputSchema: unknown;
}

/** A listed downstream tool, for host-side catalog review only. */
export interface DownstreamToolDescription extends DownstreamTool {
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

const MAX_LISTED_TOOLS = 1024;
const MAX_LIST_PAGES = 32;

export interface DownstreamSession {
  getTool(name: string): Promise<DownstreamTool | undefined>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface DownstreamConnector {
  connect(
    serverRef: string,
    expectedArtifactDigest?: Digest,
  ): Promise<DownstreamSession>;
}

export interface StdioBackendConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  artifact?: {
    path: string;
    digest: Digest;
  };
}

class McpDownstreamSession implements DownstreamSession {
  constructor(readonly client: Client) {}

  async getTool(name: string): Promise<DownstreamTool | undefined> {
    const listed = await this.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === name);
    return tool === undefined
      ? undefined
      : { name: tool.name, inputSchema: tool.inputSchema };
  }

  async listTools(): Promise<DownstreamToolDescription[]> {
    const tools: DownstreamToolDescription[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
      );
      for (const tool of listed.tools) {
        tools.push({
          name: tool.name,
          inputSchema: tool.inputSchema,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          ...(tool.annotations === undefined
            ? {}
            : {
                annotations: {
                  ...(tool.annotations.readOnlyHint === undefined
                    ? {}
                    : { readOnlyHint: tool.annotations.readOnlyHint }),
                  ...(tool.annotations.destructiveHint === undefined
                    ? {}
                    : { destructiveHint: tool.annotations.destructiveHint }),
                },
              }),
        });
        if (tools.length > MAX_LISTED_TOOLS)
          throw new Error("Downstream lists too many tools");
      }
      cursor = listed.nextCursor;
      if (cursor === undefined) return tools;
    }
    throw new Error("Downstream tool listing did not finish");
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.callTool({ name, arguments: arguments_ });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export class StdioMcpConnector implements DownstreamConnector {
  readonly #backends: ReadonlyMap<string, StdioBackendConfig>;

  constructor(backends: Readonly<Record<string, StdioBackendConfig>>) {
    this.#backends = new Map(Object.entries(backends));
  }

  /** List one backend's tools under the same artifact checks as execution. */
  async describeTools(
    serverRef: string,
    expectedArtifactDigest?: Digest,
  ): Promise<DownstreamToolDescription[]> {
    const session = await this.connect(serverRef, expectedArtifactDigest);
    try {
      return await (session as McpDownstreamSession).listTools();
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async connect(
    serverRef: string,
    expectedArtifactDigest?: Digest,
  ): Promise<DownstreamSession> {
    const config = this.#backends.get(serverRef);
    if (config === undefined) {
      throw new Error(`No stdio backend configured for ${serverRef}`);
    }

    if (config.artifact !== undefined || expectedArtifactDigest !== undefined) {
      if (
        config.artifact === undefined ||
        expectedArtifactDigest === undefined
      ) {
        throw new Error(
          `Artifact identity is not bound on both the plan and backend ${serverRef}`,
        );
      }
      if (config.artifact.digest !== expectedArtifactDigest) {
        throw new Error(
          `Configured artifact digest does not match the action plan for ${serverRef}`,
        );
      }
      const observedArtifactDigest = await sha256File(config.artifact.path);
      if (observedArtifactDigest !== expectedArtifactDigest) {
        throw new Error(
          `Downstream artifact changed before execution: ${serverRef}`,
        );
      }
    }

    const client = new Client({
      name: "mcp-repro-gate-downstream",
      version: "0.0.0",
    });
    const transport = new StdioClientTransport(config);
    try {
      await client.connect(transport);
      return new McpDownstreamSession(client);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}
