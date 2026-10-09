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

server.registerTool(
  "echo",
  {
    description: "Test-only read-shaped downstream tool",
    inputSchema: z.object({ text: z.string() }),
  },
  ({ text }) =>
    // "fail:" models a failing command for the strike gate.
    text.startsWith("fail:")
      ? { content: [{ type: "text", text }], isError: true }
      : {
          content: [{ type: "text", text }],
          structuredContent: { length: text.length },
        },
);

server.registerTool(
  "resolve",
  {
    description: "Test-only resolver for the strike gate",
    inputSchema: z.object({ text: z.string() }),
  },
  ({ text }) => ({ content: [{ type: "text", text: `resolved:${text}` }] }),
);

serveStdio(() => server);
