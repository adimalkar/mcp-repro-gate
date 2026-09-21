#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({
  name: "reprogate-test-downstream",
  version: "1.0.0",
});

server.registerTool(
  "publish",
  {
    description: "Test-only write-shaped downstream tool",
    inputSchema: z.object({ content: z.string() }),
  },
  ({ content }) => ({
    content: [{ type: "text", text: `published:${content}` }],
    structuredContent: { published: true },
  }),
);

serveStdio(() => server);
