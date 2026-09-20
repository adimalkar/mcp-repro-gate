import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createReproGateServer } from "../src/server.js";

test("an MCP client can list and call the Phase 1 facade", async (context) => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createReproGateServer();
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "action.plan",
    "catalog.search",
    "policy.explain",
  ]);

  const planned = await client.callTool({
    name: "action.plan",
    arguments: {
      toolRef: "demo.publish",
      arguments: { content: "hello" },
    },
  });
  assert.equal(planned.isError, undefined);
  assert.equal(
    (planned.structuredContent as { policy?: { decision?: string } }).policy
      ?.decision,
    "approval_required",
  );
});

test("the CLI negotiates the modern 2026 MCP era over stdio", async (context) => {
  const client = new Client(
    { name: "modern-integration-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve"],
    stderr: "pipe",
  });
  context.after(async () => client.close());

  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 3);
});
