import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { demoPolicy } from "../src/demo-config.js";
import { FilesystemManifestObserver } from "../src/filesystem-observer.js";
import { ReproGateKernel } from "../src/kernel.js";

test("filesystem observer detects content changes without returning content", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "reprogate-observer-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, "value.txt");
  writeFileSync(path, "before", { mode: 0o600 });
  const kernel = new ReproGateKernel(
    [
      {
        toolRef: "test.write",
        serverRef: "test",
        toolName: "write",
        description: "test",
        inputSchema: { type: "object" },
        effects: ["local_write"],
        filesystemRoots: [root],
      },
    ],
    demoPolicy,
  );
  const envelope = kernel.plan({
    toolRef: "test.write",
    arguments: {},
  }).envelope;
  const observer = new FilesystemManifestObserver({ roots: [root] });

  const before = await observer.snapshot(envelope);
  writeFileSync(path, "after", { mode: 0o600 });
  const after = await observer.snapshot(envelope);

  assert.notDeepEqual(after, before);
  assert.equal(JSON.stringify(after).includes("after"), false);
});

test("filesystem observer rejects roots not configured by the operator", async (context) => {
  const allowed = mkdtempSync(join(tmpdir(), "reprogate-allowed-"));
  const unconfigured = mkdtempSync(join(tmpdir(), "reprogate-unconfigured-"));
  context.after(() => {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(unconfigured, { recursive: true, force: true });
  });
  const envelope = new ReproGateKernel(
    [
      {
        toolRef: "test.escape",
        serverRef: "test",
        toolName: "escape",
        description: "test",
        inputSchema: { type: "object" },
        effects: ["local_write"],
        filesystemRoots: [unconfigured],
      },
    ],
    demoPolicy,
  ).plan({ toolRef: "test.escape", arguments: {} }).envelope;

  await assert.rejects(
    new FilesystemManifestObserver({ roots: [allowed] }).snapshot(envelope),
    /unconfigured filesystem root/,
  );
});
