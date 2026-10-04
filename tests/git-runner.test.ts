import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
