import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runArtifactDigest, runCatalogImport } from "../src/catalog-cli.js";
import {
  MAX_IMPORTED_DESCRIPTION,
  importCatalogEntries,
} from "../src/catalog-import.js";
import { demoPolicy } from "../src/demo-config.js";
import { digestCanonical } from "../src/digest.js";
import { sha256File } from "../src/file-digest.js";
import { createConfiguredRuntime } from "../src/runtime-config.js";
import type { Digest } from "../src/types.js";

const digest: Digest = `sha256:${"a".repeat(64)}`;
const schema = { type: "object", properties: { q: { type: "string" } } };

test("import copies live schemas and declared effects, and only warns", () => {
  const { entries, report } = importCatalogEntries(
    [
      {
        name: "search",
        description: "Search",
        inputSchema: schema,
        annotations: { readOnlyHint: true },
      },
      {
        name: "delete_item",
        inputSchema: {},
        annotations: { destructiveHint: true },
      },
      { name: "plain", description: "x".repeat(5000), inputSchema: {} },
    ],
    {
      serverRef: "graph",
      artifactDigest: digest,
      effects: ["local_read", "local_read"],
      scopes: ["b", "a", "a"],
      filesystemRoots: ["/srv/b", "/srv/a"],
    },
  );
  assert.deepEqual(
    entries.map((entry) => entry.toolRef),
    ["graph.delete_item", "graph.plain", "graph.search"],
  );
  const search = entries.find((entry) => entry.toolName === "search");
  assert.deepEqual(search, {
    toolRef: "graph.search",
    serverRef: "graph",
    toolName: "search",
    description: "Search",
    inputSchema: schema,
    effects: ["local_read"],
    scopes: ["a", "b"],
    filesystemRoots: ["/srv/a", "/srv/b"],
    artifactDigest: digest,
  });
  assert.equal(
    entries.find((entry) => entry.toolName === "plain")?.description.length,
    MAX_IMPORTED_DESCRIPTION,
  );
  const warnings = Object.fromEntries(
    report.map(({ toolRef, warnings: list }) => [toolRef, list.join(" | ")]),
  );
  assert.equal(warnings["graph.search"], "");
  assert.match(warnings["graph.delete_item"] ?? "", /destructive/u);
  assert.match(warnings["graph.delete_item"] ?? "", /name suggests/u);
  assert.match(warnings["graph.plain"] ?? "", /readOnlyHint/u);
  assert.equal(
    report.find((item) => item.toolRef === "graph.search")?.schemaDigest,
    digestCanonical(schema),
  );
});

test("import refuses unknown, duplicate, oversized and undeclared input", () => {
  const listed = [{ name: "a", inputSchema: {} }];
  const options = { serverRef: "graph", artifactDigest: digest };
  const refusals: [() => unknown, RegExp][] = [
    [
      () => importCatalogEntries(listed, { ...options, effects: [] }),
      /at least one effect/u,
    ],
    [
      () =>
        importCatalogEntries(listed, {
          ...options,
          effects: ["local_read"],
          tools: ["missing"],
        }),
      /does not list a tool named missing/u,
    ],
    [
      () =>
        importCatalogEntries(listed, {
          ...options,
          effects: ["local_read"],
          tools: ["a", "a"],
        }),
      /more than once/u,
    ],
    [
      () =>
        importCatalogEntries([...listed, ...listed], {
          ...options,
          effects: ["local_read"],
        }),
      /more than once/u,
    ],
    [
      () =>
        importCatalogEntries(
          Array.from({ length: 129 }, (_, index) => ({
            name: `t${String(index)}`,
            inputSchema: {},
          })),
          { ...options, effects: ["local_read"] },
        ),
      /at most 128/u,
    ],
    [
      () =>
        importCatalogEntries(
          [{ name: "big", inputSchema: { description: "x".repeat(70_000) } }],
          { ...options, effects: ["local_read"] },
        ),
      /exceeds 64 KiB/u,
    ],
    [
      () =>
        importCatalogEntries([{ name: "bad name", inputSchema: {} }], {
          ...options,
          effects: ["local_read"],
        }),
      /must match/u,
    ],
  ];
  for (const [operation, message] of refusals)
    assert.throws(operation, message);
});

async function draft(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "reprogate-import-"));
  context.after(() => {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const state = join(directory, "state");
  const observed = join(directory, "observed");
  mkdirSync(state);
  mkdirSync(observed);
  const fixtureUrl = pathToFileURL(
    fileURLToPath(new URL("./fixtures/downstream-server.js", import.meta.url)),
  ).href;
  const artifactPath = join(state, "downstream.mjs");
  writeFileSync(artifactPath, `await import(${JSON.stringify(fixtureUrl)});\n`);
  const artifactDigest = await sha256File(artifactPath);
  const backend = {
    transport: "stdio",
    command: process.execPath,
    args: [artifactPath],
    cwd: state,
    environment: { inherit: "safe", from: {} },
    artifact: { path: artifactPath, digest: artifactDigest },
  };
  const configPath = join(state, "draft.json");
  writeFileSync(configPath, JSON.stringify({ backends: { fixture: backend } }));
  const lines = { stdout: "", stderr: "" };
  const io = {
    stdout: (text: string) => (lines.stdout += text),
    stderr: (text: string) => (lines.stderr += text),
  };
  return { state, observed, backend, configPath, artifactPath, lines, io };
}

test("catalog import from a draft config yields entries a mediated runtime can run", async (context) => {
  const d = await draft(context);
  const result = await runCatalogImport(
    [
      "--config",
      d.configPath,
      "--backend",
      "fixture",
      "--effects",
      "local_read",
    ],
    d.io,
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.toolRef),
    ["fixture.echo", "fixture.publish"],
  );
  assert.deepEqual(JSON.parse(d.lines.stdout), result.entries);
  assert.match(d.lines.stderr, /fixture\.echo sha256:[0-9a-f]{64}\n/u);
  assert.doesNotMatch(d.lines.stderr, /warning: fixture\.echo/u);
  assert.match(
    d.lines.stderr,
    /warning: fixture\.publish: declared read-only/u,
  );
  assert.match(d.lines.stderr, /import grants nothing/u);

  const runtimePath = join(d.state, "runtime.json");
  writeFileSync(
    runtimePath,
    JSON.stringify({
      configVersion: 1,
      databasePath: join(d.state, "reprogate.sqlite"),
      catalog: result.entries.filter((entry) => entry.toolName === "echo"),
      policy: demoPolicy,
      backends: { fixture: d.backend },
      observer: { kind: "filesystem_manifest", roots: [d.observed] },
      secrets: {
        capabilitySecretEnv: "IMPORT_CAPABILITY_SECRET",
        receiptSecretEnv: "IMPORT_RECEIPT_SECRET",
        receiptKeyId: "import-key",
      },
      mediation: { effects: ["local_read"] },
    }),
  );
  const runtime = await createConfiguredRuntime(runtimePath, {
    ...process.env,
    IMPORT_CAPABILITY_SECRET: "import-capability-secret-at-least-32-bytes",
    IMPORT_RECEIPT_SECRET: "import-receipt-secret-different-32-bytes!!",
  });
  try {
    const plan = runtime.kernel.plan({
      toolRef: "fixture.echo",
      arguments: { text: "graph query" },
    });
    assert.equal(plan.policy.decision, "allow");
    assert.ok(runtime.mediator);
    const run = await runtime.mediator.run({
      actionId: plan.envelope.actionId,
      arguments: { text: "graph query" },
    });
    assert.equal(run.outcome, "succeeded");
    assert.equal(run.content[0]?.text, "graph query");
  } finally {
    runtime.close();
  }
});

test("catalog import refuses bad usage, unknown backends and changed artifacts", async (context) => {
  const d = await draft(context);
  const base = ["--config", d.configPath, "--backend", "fixture"];
  await assert.rejects(runCatalogImport(base, d.io), /Usage/u);
  await assert.rejects(
    runCatalogImport([...base, "--effects", "local_reading"], d.io),
    /Unknown effect local_reading/u,
  );
  await assert.rejects(
    runCatalogImport(
      [...base, "--effects", "local_read", "--tools", "nope"],
      d.io,
    ),
    /does not list a tool named nope/u,
  );
  await assert.rejects(
    runCatalogImport(
      [
        "--config",
        d.configPath,
        "--backend",
        "other",
        "--effects",
        "local_read",
      ],
      d.io,
    ),
    /No backend named other/u,
  );
  await assert.rejects(
    runCatalogImport(
      [...base, "--effects", "local_read", "--filesystem-root", "rel"],
      d.io,
    ),
    /absolute path/u,
  );
  writeFileSync(d.artifactPath, "// changed\n");
  await assert.rejects(
    runCatalogImport([...base, "--effects", "local_read"], d.io),
    /artifact digest does not match/u,
  );
  assert.equal(d.lines.stdout, "");
});

test("artifact digest prints the pin backends and catalogs require", async (context) => {
  const d = await draft(context);
  await runArtifactDigest([d.artifactPath], d.io);
  assert.equal(d.lines.stdout, `${await sha256File(d.artifactPath)}\n`);
  await assert.rejects(runArtifactDigest(["relative"], d.io), /Usage/u);
});
