#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

let parentGone = false;
process.stdin.once("close", () => {
  parentGone = true;
});

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
  async ({ content }) => {
    // Process-race fixtures: record each effect, then optionally stall until
    // released, or exit before replying (a lost response).
    const effects = process.env.REPROGATE_TEST_EFFECTS;
    if (effects !== undefined)
      appendFileSync(effects, `${String(process.pid)}:${content}\n`);
    const mode = process.env.REPROGATE_TEST_PUBLISH;
    if (mode === "exit-before-reply") process.exit(0);
    const release = process.env.REPROGATE_TEST_RELEASE;
    if (mode === "wait" && release !== undefined) {
      // A hard-killed client cannot stop this process: leave once its pipe
      // closes, and in any case after a minute.
      const deadline = Date.now() + 60_000;
      while (!existsSync(release)) {
        if (parentGone || Date.now() > deadline) process.exit(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return {
      content: [{ type: "text", text: `published:${content}` }],
      structuredContent: { published: true },
    };
  },
);

server.registerTool(
  "echo",
  {
    description: "Test-only read-shaped downstream tool",
    inputSchema: z.object({ text: z.string() }),
    annotations: { readOnlyHint: true },
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
