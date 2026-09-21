import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";

import { issueCapabilityToken } from "../src/capability-token.js";
import { demoPolicy } from "../src/demo-config.js";
import { sha256File } from "../src/file-digest.js";
import {
  createConfiguredRuntime,
  loadRuntimeConfig,
  type ConfiguredRuntime,
} from "../src/runtime-config.js";
import { createReproGateServer } from "../src/server.js";

const capabilitySecret = "configured-capability-secret-at-least-32-bytes";
const receiptSecret = "configured-receipt-secret-different-32-bytes";

async function createFixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-config-"));
  const workspace = join(directory, "workspace");
  const state = join(directory, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  writeFileSync(join(workspace, "tracked.txt"), "stable");

  const fixtureUrl = pathToFileURL(
    fileURLToPath(new URL("./fixtures/downstream-server.js", import.meta.url)),
  ).href;
  const artifactPath = join(state, "downstream.mjs");
  writeFileSync(artifactPath, `await import(${JSON.stringify(fixtureUrl)});\n`);
  const artifactDigest = await sha256File(artifactPath);
  const configPath = join(state, "runtime.json");
  const databasePath = join(state, "reprogate.sqlite");
  const config = {
    configVersion: 1,
    databasePath,
    catalog: [
      {
        toolRef: "configured.publish",
        serverRef: "configured",
        toolName: "publish",
        description: "Configured integration fixture",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
        effects: ["local_write", "network_write"],
        scopes: ["configured:publish"],
        filesystemRoots: [workspace],
        artifactDigest,
      },
    ],
    policy: {
      ...demoPolicy,
      rules: demoPolicy.rules.map((rule) => ({
        ...rule,
        match: { ...rule.match, toolRef: "configured.publish" },
      })),
    },
    backends: {
      configured: {
        transport: "stdio",
        command: process.execPath,
        args: [artifactPath],
        cwd: state,
        environment: { inherit: "safe", from: {} },
        artifact: { path: artifactPath, digest: artifactDigest },
      },
    },
    observer: {
      kind: "filesystem_manifest",
      roots: [workspace],
      maxEntries: 100,
      maxBytes: 1024 * 1024,
    },
    secrets: {
      capabilitySecretEnv: "TEST_CAPABILITY_SECRET",
      receiptSecretEnv: "TEST_RECEIPT_SECRET",
      receiptKeyId: "test-key-1",
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  let runtime: ConfiguredRuntime | undefined;
  context.after(() => {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    artifactPath,
    config,
    configPath,
    setRuntime(value: ConfiguredRuntime) {
      runtime = value;
    },
  };
}

function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TEST_CAPABILITY_SECRET: capabilitySecret,
    TEST_RECEIPT_SECRET: receiptSecret,
  };
}

test("configured runtime enables an artifact-bound execution facade", async (context) => {
  const fixture = await createFixture(context);
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../schemas/runtime-config.schema.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as object;
  assert.equal(
    new Ajv2020({ strict: true }).validate(schema, fixture.config),
    true,
  );
  const runtime = await createConfiguredRuntime(
    fixture.configPath,
    environment(),
  );
  fixture.setRuntime(runtime);
  assert.equal(runtime.recoveredExecutions, 0);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createReproGateServer(runtime.kernel, runtime.executor);
  const client = new Client({ name: "configured-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["action.execute", "action.plan", "catalog.search", "policy.explain"],
  );

  const now = new Date();
  const plan = runtime.kernel.plan({
    toolRef: "configured.publish",
    arguments: { content: "hello" },
    now,
  });
  const token = issueCapabilityToken(
    {
      actionId: plan.envelope.actionId,
      envelopeDigest: plan.envelopeDigest,
      scopes: plan.envelope.authority.scopes,
      issuedAt: now.toISOString(),
      expiresAt: plan.envelope.expiresAt,
      jti: "configured-token",
    },
    capabilitySecret,
  );
  const result = await runtime.executor.execute({
    actionId: plan.envelope.actionId,
    arguments: { content: "hello" },
    capabilityToken: token,
    now,
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(
    JSON.stringify(runtime.config).includes(capabilitySecret),
    false,
  );
});

test("artifact drift fails before consuming the capability", async (context) => {
  const fixture = await createFixture(context);
  const runtime = await createConfiguredRuntime(
    fixture.configPath,
    environment(),
  );
  fixture.setRuntime(runtime);
  const now = new Date();
  const plan = runtime.kernel.plan({
    toolRef: "configured.publish",
    arguments: { content: "hello" },
    now,
  });
  const token = issueCapabilityToken(
    {
      actionId: plan.envelope.actionId,
      envelopeDigest: plan.envelopeDigest,
      scopes: plan.envelope.authority.scopes,
      issuedAt: now.toISOString(),
      expiresAt: plan.envelope.expiresAt,
      jti: "artifact-drift-token",
    },
    capabilitySecret,
  );
  appendFileSync(fixture.artifactPath, "// changed\n");

  await assert.rejects(
    runtime.executor.execute({
      actionId: plan.envelope.actionId,
      arguments: { content: "hello" },
      capabilityToken: token,
      now,
    }),
    /artifact changed/,
  );
  assert.equal(runtime.store.consume("artifact-drift-token"), true);
});

test("configured startup rejects an artifact that already drifted", async (context) => {
  const fixture = await createFixture(context);
  appendFileSync(fixture.artifactPath, "// changed before startup\n");
  await assert.rejects(
    createConfiguredRuntime(fixture.configPath, environment()),
    /digest does not match the file/,
  );
});

test("CLI exposes execution only after configured startup succeeds", async (context) => {
  const fixture = await createFixture(context);
  const childEnvironment = Object.fromEntries(
    Object.entries(environment()).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const client = new Client({ name: "configured-cli-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "serve",
      "--config",
      fixture.configPath,
    ],
    env: childEnvironment,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ["action.execute", "action.plan", "catalog.search", "policy.explain"],
    );
  } finally {
    await client.close();
  }
});

test("runtime configuration rejects raw secrets and incomplete backends", async (context) => {
  const fixture = await createFixture(context);
  const invalid = structuredClone(fixture.config) as Record<string, unknown>;
  invalid.secrets = {
    ...(invalid.secrets as Record<string, unknown>),
    capabilitySecret: capabilitySecret,
  };
  writeFileSync(fixture.configPath, JSON.stringify(invalid));
  assert.throws(() => loadRuntimeConfig(fixture.configPath));

  const missingBackend = structuredClone(fixture.config) as Record<
    string,
    unknown
  >;
  missingBackend.backends = {};
  writeFileSync(fixture.configPath, JSON.stringify(missingBackend));
  assert.throws(() => loadRuntimeConfig(fixture.configPath), /missing backend/);
});
