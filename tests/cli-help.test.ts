import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });

test("help prints usage on stdout and succeeds", () => {
  for (const flag of ["help", "--help", "-h"]) {
    const result = run(flag);
    assert.equal(result.status, 0, flag);
    assert.match(result.stdout, /^Usage: reprogate \[serve/u);
  }
});

test("an unknown command prints usage on stderr and fails as a usage error", () => {
  const result = run("frobnicate");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Usage: reprogate \[serve/u);
});
