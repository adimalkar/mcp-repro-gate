import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGit } from "../src/git-runner.js";

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("runner preserves safe line-ending configuration avoiding spurious dirty status", () => {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-runner-"));
  try {
    const root = join(scratch, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");

    // Simulate Windows checkout where core.autocrlf is enabled globally or locally
    git(root, "config", "core.autocrlf", "true");

    // Create a file and track it
    // Under autocrlf=true, git add will convert CRLF to LF in the object database
    writeFileSync(join(root, "value.txt"), "line1\r\nline2\r\n");
    git(root, "add", "value.txt");
    git(root, "commit", "-m", "Initial");

    // Ordinary git sees it as clean
    const ordinary = git(root, "status", "--porcelain", "-z");
    assert.equal(ordinary.toString("utf8"), "");

    // Hardened runner must also see it as clean (it was failing before the fix)
    const hardened = runGit(["-C", root, "status", "--porcelain", "-z"]);
    assert.equal(hardened.toString("utf8"), "");

    // Real drift must still be detected
    writeFileSync(join(root, "value.txt"), "line1\r\nchanged\r\n");
    const drift = runGit(["-C", root, "status", "--porcelain", "-z"]);
    assert.equal(drift.toString("utf8"), " M value.txt\0");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

for (const settings of [
  "eol",
  "eol =",
  "eol = unsafe",
  "autocrlf = unsafe",
  'eol = "lf\\ncrlf"',
  'autocrlf = "true\\nfalse"',
]) {
  test(`runner rejects invalid effective normalization setting ${settings}`, () => {
    const root = mkdtempSync(
      join(tmpdir(), "reprogate-invalid-normalization-"),
    );
    try {
      git(root, "init", "-q", "-b", "main");
      appendFileSync(join(root, ".git", "config"), `[core]\n\t${settings}\n`);
      assert.throws(() => runGit(["-C", root, "status", "--porcelain", "-z"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("runner rejects oversized and invalid UTF-8 normalization values", () => {
  const root = mkdtempSync(join(tmpdir(), "reprogate-invalid-normalization-"));
  try {
    git(root, "init", "-q", "-b", "main");
    const config = join(root, ".git", "config");
    const original = execFileSync("git", [
      "-C",
      root,
      "config",
      "--local",
      "--list",
    ]);
    assert.ok(original.length > 0);
    const base = Buffer.from(
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
    );
    for (const value of [Buffer.alloc(1025, 0x78), Buffer.from([0xff])]) {
      writeFileSync(
        config,
        Buffer.concat([
          base,
          Buffer.from("\teol = "),
          value,
          Buffer.from("\n"),
        ]),
      );
      assert.throws(() => runGit(["-C", root, "status", "--porcelain", "-z"]));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact metadata reads use one real Git spawn per command and retain observed bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reprogate-metadata-spawns-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Metadata fixture");
    git(root, "config", "user.email", "metadata@example.invalid");
    writeFileSync(join(root, "value.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const commands = [
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--is-bare-repository"],
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["rev-parse", "--verify", "HEAD^{tree}"],
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      ["symbolic-ref", "--quiet", "HEAD"],
      [
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)",
        "refs/heads/main",
      ],
      ["check-ref-format", "refs/heads/main"],
      ["worktree", "list", "--porcelain", "-z"],
    ];
    const expected = commands.map((command) => git(root, ...command));
    const original = childProcess.spawnSync;
    const calls: string[][] = [];
    const spawning = t.mock.method(
      childProcess,
      "spawnSync",
      (...args: Parameters<typeof childProcess.spawnSync>) => {
        assert.equal(args[0], "git");
        assert.ok(Array.isArray(args[1]));
        calls.push(args[1] as string[]);
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    const started = performance.now();
    try {
      for (const [index, command] of commands.entries())
        assert.deepEqual(runGit(["-C", root, ...command]), expected[index]);
    } finally {
      spawning.mock.restore();
      syncBuiltinESMExports();
    }
    t.diagnostic(
      `metadata workload: ${String(commands.length)} reads, ${String(calls.length)} real Git spawns, ${(performance.now() - started).toFixed(1)} ms`,
    );
    assert.equal(calls.length, commands.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata optimization keeps fresh probes for every ambiguous or interpreting command shape", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-probe-boundaries-"));
  const root = join(scratch, "repo");
  try {
    git(scratch, "init", "-q", "-b", "main", root);
    git(root, "config", "user.name", "Probe boundary fixture");
    git(root, "config", "user.email", "probe@example.invalid");
    git(root, "config", "core.autocrlf", "false");
    writeFileSync(join(root, "value.txt"), "before\n");
    writeFileSync(
      join(root, ".gitattributes"),
      "value.txt text filter=evil diff=evil\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const marker = join(scratch, "EXECUTED");
    const script = join(scratch, "evil.cjs");
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected callback'); process.exit(1);`,
    );
    const quote = (value: string) =>
      process.platform === "win32"
        ? `"${value.replaceAll('"', '\\"')}"`
        : `'${value.replaceAll("'", "'\\''")}'`;
    const callback = `${quote(process.execPath)} ${quote(script)}`;
    for (const name of [
      "filter.evil.clean",
      "filter.evil.smudge",
      "filter.evil.process",
      "diff.evil.command",
      "diff.evil.textconv",
      "core.fsmonitor",
      "core.alternateRefsCommand",
      "uploadpack.packObjectsHook",
    ])
      git(root, "config", name, callback);
    git(root, "config", "filter.evil.required", "false");
    const head = git(root, "rev-parse", "HEAD").toString("ascii").trim();
    const treeRead = ["-C", root, "rev-parse", "--verify", `${head}^{tree}`];
    const cases: {
      args: string[];
      input?: Uint8Array;
      driverProbe: boolean;
    }[] = [
      { args: ["-C", root, "rev-parse", "--exec-path"], driverProbe: true },
      {
        args: ["-C", root, "rev-parse", "--show-toplevel", "--exec-path"],
        driverProbe: true,
      },
      {
        args: ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        driverProbe: true,
      },
      {
        args: ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
        input: Buffer.from("ignored input"),
        driverProbe: true,
      },
      {
        args: [
          "-C",
          root,
          "for-each-ref",
          "--format=%(contents)",
          "refs/heads/main",
        ],
        driverProbe: true,
      },
      {
        args: [
          "-C",
          root,
          "for-each-ref",
          "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)",
          "refs/heads/main^{}",
        ],
        driverProbe: true,
      },
      {
        args: [
          "-C",
          root,
          "rev-parse",
          "--verify",
          "refs/heads/main..other^{commit}",
        ],
        driverProbe: true,
      },
      {
        args: [
          "-C",
          root,
          "for-each-ref",
          "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)",
          "refs/heads/nested/./main",
        ],
        driverProbe: true,
      },
      {
        args: ["-C", root, "check-ref-format", "refs/heads/main.lock"],
        driverProbe: true,
      },
      {
        args: ["-C", root, "check-ref-format", "--branch", "main"],
        driverProbe: true,
      },
      {
        args: ["-C", root, "symbolic-ref", "--quiet", "refs/heads/main"],
        driverProbe: true,
      },
      {
        args: ["-C", root, "worktree", "list", "--porcelain"],
        driverProbe: true,
      },
      {
        args: [
          "-C",
          root,
          "worktree",
          "add",
          "--detach",
          "--no-checkout",
          join(scratch, "linked"),
        ],
        driverProbe: true,
      },
      {
        args: ["-C", root, "read-tree", "--reset", "-u", "HEAD"],
        driverProbe: true,
      },
      {
        args: [
          "-C",
          root,
          "hash-object",
          "--filters",
          "--path=value.txt",
          "--stdin",
        ],
        input: Buffer.from("after\r\n"),
        driverProbe: true,
      },
      { args: ["-C", root, "diff", "--textconv", "HEAD"], driverProbe: true },
      { args: ["-C", root, "status", "--porcelain", "-z"], driverProbe: true },
      {
        args: ["-C", root, "apply", "--cached", "--binary", "-"],
        input: Buffer.from(
          "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
        ),
        driverProbe: true,
      },
      {
        args: [
          "clone",
          "--no-local",
          "--no-checkout",
          "--quiet",
          "--",
          root,
          join(scratch, "clone"),
        ],
        driverProbe: false,
      },
    ];
    const original = childProcess.spawnSync;
    const calls: string[][] = [];
    const spawning = t.mock.method(
      childProcess,
      "spawnSync",
      (...args: Parameters<typeof childProcess.spawnSync>) => {
        assert.ok(Array.isArray(args[1]));
        calls.push(args[1] as string[]);
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      runGit(treeRead);
      assert.equal(
        calls.length,
        1,
        "exact object tree peel is still one bounded Git read",
      );
      for (const example of cases) {
        calls.length = 0;
        // A disabled named driver may reject. Its callback must never execute,
        // and safety probes must precede either a successful or failed command.
        try {
          runGit(example.args, example.input);
        } catch (error) {
          assert.ok(error instanceof Error);
        }
        const probes = calls.filter((call) => call.includes("config"));
        assert.ok(
          probes.some((call) =>
            call.includes("^(core\\.autocrlf|core\\.eol)$"),
          ),
          example.args.join(" "),
        );
        assert.equal(
          probes.some((call) => call.includes("--name-only")),
          example.driverProbe,
          example.args.join(" "),
        );
        assert.equal(
          existsSync(marker),
          false,
          "configured callback must remain suppressed",
        );
      }
      // No cross-call cache: an intervening local setting change is observed.
      spawning.mock.restore();
      syncBuiltinESMExports();
      git(root, "config", "core.eol", "unsupported");
      assert.doesNotThrow(() => runGit(treeRead));
      assert.throws(
        () => runGit(["-C", root, "status", "--porcelain", "-z"]),
        /Unsupported Git line-ending configuration/u,
      );
    } finally {
      spawning.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("metadata classification and dispatch use one owned argument snapshot", () => {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-owned-git-arguments-"));
  const root = join(scratch, "repo");
  try {
    git(scratch, "init", "-q", "-b", "main", root);
    git(root, "config", "user.name", "Owned argument fixture");
    git(root, "config", "user.email", "arguments@example.invalid");
    writeFileSync(join(root, "value.txt"), "before\n");
    writeFileSync(join(root, ".gitattributes"), "value.txt diff=evil\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    writeFileSync(join(root, "value.txt"), "after\n");
    const marker = join(scratch, "EXECUTED");
    const script = join(scratch, "evil.cjs");
    writeFileSync(
      script,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected textconv'); process.stdout.write(fs.readFileSync(process.argv[2]));`,
    );
    const quote = (value: string) =>
      process.platform === "win32"
        ? `"${value.replaceAll('"', '\\"')}"`
        : `'${value.replaceAll("'", "'\\''")}'`;
    git(
      root,
      "config",
      "diff.evil.textconv",
      `${quote(process.execPath)} ${quote(script)}`,
    );
    const expected = git(root, "rev-parse", "--verify", "HEAD^{commit}");
    let commandReads = 0;
    let optionReads = 0;
    let revisionReads = 0;
    const args = ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"];
    Object.defineProperty(args, 2, {
      get: () => (++commandReads === 1 ? "rev-parse" : "diff"),
    });
    Object.defineProperty(args, 3, {
      get: () => (++optionReads === 1 ? "--verify" : "--no-ext-diff"),
    });
    Object.defineProperty(args, 4, {
      get: () => (++revisionReads === 1 ? "HEAD^{commit}" : "--textconv"),
    });
    const observed = runGit(args);
    assert.equal(
      existsSync(marker),
      false,
      "switching caller values must never dispatch a named callback",
    );
    assert.deepEqual(observed, expected);
    assert.equal(commandReads, 1);
    assert.equal(optionReads, 1);
    assert.equal(revisionReads, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
