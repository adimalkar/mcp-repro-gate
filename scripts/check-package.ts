// Exercise the consumer's tarball, bin shim and package exports after a build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run the package check with npm run pack:check");
const root = mkdtempSync(join(tmpdir(), "reprogate-package-"));
try {
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  execFileSync(process.execPath, [
    npm,
    "pack",
    "--ignore-scripts",
    "--silent",
    "--pack-destination",
    root,
  ]);
  const tarballs = readdirSync(root).filter((name) => name.endsWith(".tgz"));
  assert.equal(
    tarballs.length,
    1,
    "npm pack must produce one installable tarball",
  );
  const [filename] = tarballs;
  assert.ok(filename);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "reprogate-package-consumer",
      private: true,
      scripts: { smoke: "reprogate --help" },
    }),
  );
  const runNpm = (...args: string[]) =>
    execFileSync(process.execPath, [npm, ...args], {
      cwd: consumer,
      encoding: "utf8",
    });
  runNpm(
    "install",
    "--ignore-scripts",
    "--prefer-offline",
    "--no-fund",
    "--no-audit",
    join(root, filename),
  );
  accessSync(
    join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "reprogate.cmd" : "reprogate",
    ),
  );
  assert.match(runNpm("run", "--silent", "smoke"), /Usage: reprogate/u);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { canonicalJson } from "mcp-repro-gate"; import assert from "node:assert/strict"; assert.equal(canonicalJson({ok:true}), \'{"ok":true}\');',
    ],
    { cwd: consumer },
  );
  process.stdout.write("Packed CLI and library passed in a fresh consumer.\n");
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
