import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, {
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  candidateKeepMessage,
  releaseCandidateKeep,
} from "../src/git-promotion-keep.js";

function scratchDirectory(t: TestContext): string {
  const scratch = mkdtempSync(join(tmpdir(), "reprogate-keep-"));
  t.after(() => {
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  return scratch;
}

const name = (digit: string, length = 40) =>
  `pack-${digit.repeat(length)}.keep`;

test("only keep files holding exactly this attempt's text are removed", (t) => {
  // A non-ASCII path, reached through a linked worktree.
  const scratch = scratchDirectory(t);
  const root = join(scratch, "dépôt");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  mkdirSync(root);
  git("init", "-q");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@localhost",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  const linked = join(scratch, "linked");
  git("worktree", "add", "-q", "--detach", linked);

  const attemptId = randomUUID();
  const text = `${candidateKeepMessage(attemptId)}\n`;
  const pack = join(root, ".git", "objects", "pack");
  mkdirSync(pack, { recursive: true });
  const mine = [name("a"), name("b", 64)];
  for (const file of mine) writeFileSync(join(pack, file), text);
  const others: [string, string][] = [
    [name("c"), `${candidateKeepMessage(randomUUID())}\n`],
    [name("d"), text.trimEnd()],
    [name("e"), `${text}more\n`],
    [name("f"), ""],
    ["pack-short.keep", text],
    [`${name("1")}.bak`, text],
  ];
  for (const [file, contents] of others)
    writeFileSync(join(pack, file), contents);
  mkdirSync(join(pack, name("2")));
  const left = [...others.map(([file]) => file), name("2")];
  if (process.platform !== "win32") {
    const outside = join(scratch, "outside");
    writeFileSync(outside, text);
    symlinkSync(outside, join(pack, name("3")));
    left.push(name("3"));
  }

  const opening = t.mock.method(fs, "openSync");
  syncBuiltinESMExports();
  try {
    releaseCandidateKeep(linked, attemptId);
  } finally {
    opening.mock.restore();
    syncBuiltinESMExports();
  }
  const opened = new Map<string, number>();
  for (const {
    arguments: [path, flags],
  } of opening.mock.calls) {
    if (typeof path === "string" && typeof flags === "number") {
      opened.set(basename(path), flags);
    }
  }
  assert.equal(opened.has(name("2")), false, "skip directory before open");
  const available = constants as Partial<typeof constants>;
  const required = (available.O_NONBLOCK ?? 0) | (available.O_NOFOLLOW ?? 0);
  for (const file of mine) {
    const flags = opened.get(file);
    assert.notEqual(flags, undefined);
    assert.equal((flags ?? 0) & required, required);
  }
  assert.deepEqual(readdirSync(pack).sort(), left.sort());
  // Nothing left to release is fine too.
  releaseCandidateKeep(linked, attemptId);
  assert.deepEqual(readdirSync(pack).sort(), left.sort());
});

test("a failed release never throws", (t) => {
  const scratch = scratchDirectory(t);
  releaseCandidateKeep(scratch, randomUUID());
  releaseCandidateKeep(join(scratch, "absent"), randomUUID());
});
