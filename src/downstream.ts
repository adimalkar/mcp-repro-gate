import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface DownstreamTool {
  name: string;
  inputSchema: unknown;
}

export interface DownstreamSession {
  getTool(name: string): Promise<DownstreamTool | undefined>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface DownstreamConnector {
  connect(serverRef: string): Promise<DownstreamSession>;
}

export interface StdioBackendConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
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

  async connect(serverRef: string): Promise<DownstreamSession> {
    const config = this.#backends.get(serverRef);
    if (config === undefined) {
      throw new Error(`No stdio backend configured for ${serverRef}`);
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
