import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { digestCanonical, sha256 } from "../src/digest.js";
import {
  createGitChangeProposal,
  createGitChangeProposalV2,
  observeGitPromotionWorkspace,
  type GitChangeProposalV2,
} from "../src/git-change-proposal.js";
import { runGit } from "../src/git-runner.js";
import { stageGitChangeForReview } from "../src/git-change-stage.js";

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function line(root: string, ...args: string[]): string {
  return git(root, ...args)
    .toString("utf8")
    .trim();
}
function fixture(t: TestContext, format?: "sha256") {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "reprogate objects é ")),
  );
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = join(scratch, "source ü repo");
  mkdirSync(root);
  git(
    root,
    "init",
    "-q",
    "-b",
    "reviewer",
    ...(format ? [`--object-format=${format}`] : []),
  );
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "value.txt"), "before\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "target");
  const patch = Buffer.from(
    "diff --git a/value.txt b/value.txt\nindex 90be1f3..294186e 100644\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
  );
  const proposal = proposalFor(root, patch, ["value.txt"]);
  return { root, scratch, patch, proposal };
}
function proposalFor(
  root: string,
  patch: Buffer,
  allowedPaths: string[],
): GitChangeProposalV2 {
  return createGitChangeProposalV2({
    repositoryPath: root,
    repositoryId: "example/repository",
    destinationRef: "refs/heads/target",
    actionId: sha256("action"),
    policyDigest: sha256("policy"),
    patch,
    allowedPaths,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}
function snapshot(root: string) {
  const index = line(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  );
  return {
    head: git(root, "symbolic-ref", "HEAD"),
    refs: git(
      root,
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
    ),
    index: readFileSync(index),
    file: readFileSync(join(root, "value.txt")),
    status: git(root, "status", "--porcelain=v1", "-z"),
    fetchHead: existsSync(join(root, ".git", "FETCH_HEAD")),
  };
}
async function materializer() {
  // Dynamic path lets the RED phase exercise real fixtures before the module exists.
  return import("../src/" + "git-promotion-objects.js") as Promise<
    typeof import("../src/git-promotion-objects.js")
  >;
}

for (const format of [undefined, "sha256"] as const) {
  test(`imports exact one-parent objects without source mutations (${format ?? "sha1"})`, async (t) => {
    const { root, patch, proposal } = fixture(t, format);
    const before = snapshot(root);
    const reviewed = stageGitChangeForReview(proposal, root, patch);
    assert.throws(() =>
      git(root, "cat-file", "-e", reviewed.staged.candidateTreeOid),
    );
    const { prepareGitPromotionObjects } = await materializer();
    const attemptId = randomUUID();
    const prepared = prepareGitPromotionObjects({
      proposal,
      repositoryPath: root,
      patch,
      attemptId,
    });
    assert.equal(prepared.attemptId, attemptId);
    assert.equal(prepared.proposalId, proposal.proposalId);
    assert.equal(prepared.expectedOldOid, proposal.workspace.destinationOid);
    assert.equal(prepared.baseCommit, proposal.workspace.headCommit);
    assert.deepEqual(prepared.staged, reviewed.staged);
    assert.equal(prepared.effectDigest, digestCanonical(reviewed.staged));
    assert.match(prepared.hostCommitMetadataDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(
      new Date(prepared.createdAt).toISOString(),
      prepared.createdAt,
    );
    const raw = git(
      root,
      "cat-file",
      "commit",
      prepared.candidateCommitOid,
    ).toString("utf8");
    const seconds = Math.floor(Date.parse(prepared.createdAt) / 1000);
    assert.equal(
      raw,
      `tree ${prepared.candidateTreeOid}\nparent ${prepared.expectedOldOid}\nauthor ReproGate <reprogate@localhost> ${String(seconds)} +0000\ncommitter ReproGate <reprogate@localhost> ${String(seconds)} +0000\n\nReproGate candidate v1\nproposal ${proposal.proposalId}\nattempt ${attemptId}\ncreated ${prepared.createdAt}\n`,
    );
    assert.equal(prepared.hostCommitMetadataDigest, sha256(raw));
    assert.equal(
      line(root, "rev-parse", `${prepared.candidateCommitOid}^{tree}`),
      reviewed.staged.candidateTreeOid,
    );
    assert.deepEqual(
      git(
        root,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        prepared.baseCommit,
        prepared.candidateCommitOid,
        "--",
      ),
      Buffer.from(reviewed.stagedPatch),
    );
    assert.equal(
      line(
        root,
        "cat-file",
        "blob",
        `${prepared.candidateCommitOid}:value.txt`,
      ),
      "after",
    );
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(
      Object.keys(prepared).sort(),
      [
        "preparedVersion",
        "attemptId",
        "proposalId",
        "expectedOldOid",
        "baseCommit",
        "candidateCommitOid",
        "candidateTreeOid",
        "staged",
        "effectDigest",
        "hostCommitMetadataDigest",
        "createdAt",
      ].sort(),
    );
  });
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}
function helperScript(scratch: string, name: string) {
  const marker = join(scratch, `${name}-executed`);
  const script = join(scratch, `${name}.cjs`);
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  );
  return { marker, command: `${quote(process.execPath)} ${quote(script)}` };
}

for (const driver of ["evil", "nested.é.Driver"]) {
  for (const field of ["command", "textconv"] as const) {
    test(`shared runner suppresses configured diff ${field} (${driver}) without changing review or materialization`, async (t) => {
      const { root, scratch, patch } = fixture(t);
      writeFileSync(join(root, ".gitattributes"), `value.txt diff=${driver}\n`);
      git(root, "add", ".gitattributes");
      git(root, "commit", "-qm", "diff attributes");
      git(root, "branch", "-f", "target", "HEAD");
      const proposal = proposalFor(root, patch, ["value.txt"]);
      const reviewed = stageGitChangeForReview(proposal, root, patch);
      const { prepareGitPromotionObjects } = await materializer();
      const attemptId = randomUUID();
      const now = Date.now();
      t.mock.method(Date, "now", () => now);
      const input = { proposal, repositoryPath: root, patch, attemptId };
      const baseline = prepareGitPromotionObjects(input);
      const { marker, command } = helperScript(scratch, field);
      // Include-file config is part of the source repository's effective config.
      const included = join(scratch, "included-config");
      git(root, "config", "include.path", included);
      execFileSync("git", [
        "config",
        "--file",
        included,
        `diff.${driver}.${field}`,
        command,
      ]);
      // Duplicate keys must not leave a later command value unprotected.
      execFileSync("git", [
        "config",
        "--file",
        included,
        "--add",
        `diff.${driver}.${field}`,
        command,
      ]);
      writeFileSync(join(root, "value.txt"), "after\n");
      const diffArgs =
        field === "command"
          ? ["diff", "HEAD"]
          : ["diff", "--no-ext-diff", "--textconv", "HEAD"];
      git(root, ...diffArgs);
      assert.equal(
        readFileSync(marker, "utf8"),
        "executed",
        "ordinary Git must execute this callback on tracked data",
      );
      rmSync(marker);
      // Empty driver overrides may deliberately make a generic diff fail closed.
      try {
        runGit(["-C", root, ...diffArgs]);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^Git staging command failed: nonzero command result$/u,
        );
      }
      assert.equal(
        existsSync(marker),
        false,
        "the shared runner must not execute the callback",
      );
      assert.deepEqual(
        runGit(["-C", root, "diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        git(root, "diff", "--no-ext-diff", "--no-textconv", "HEAD"),
      );
      writeFileSync(join(root, "value.txt"), "before\n");
      git(root, "status", "--porcelain=v1");
      const before = snapshot(root);
      assert.deepEqual(
        stageGitChangeForReview(proposal, root, patch),
        reviewed,
      );
      const prepared = prepareGitPromotionObjects(input);
      assert.deepEqual(prepared, baseline);
      assert.deepEqual(
        git(
          root,
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          prepared.baseCommit,
          prepared.candidateCommitOid,
          "--",
        ),
        Buffer.from(reviewed.stagedPatch),
      );
      assert.deepEqual(
        git(
          root,
          "cat-file",
          "blob",
          `${prepared.candidateCommitOid}:value.txt`,
        ),
        Buffer.from("after\n"),
      );
      assert.deepEqual(snapshot(root), before);
      assert.equal(existsSync(marker), false);
    });
  }
}

test("runner bounds combined filter/diff driver discovery and deduplicates names", (t) => {
  const { root } = fixture(t);
  const configPath = join(root, ".git", "config");
  const original = readFileSync(configPath);
  const names = Array.from(
    { length: 64 },
    (_, i) =>
      `[filter "f${String(i)}"]\n clean = private-command\n required = true\n[diff "d${String(i)}"]\n command = private-command\n textconv = private-command\n command = duplicate-private-command\n`,
  ).join("");
  writeFileSync(configPath, Buffer.concat([original, Buffer.from(names)]));
  assert.deepEqual(
    runGit(["-C", root, "rev-parse", "HEAD"]),
    git(root, "rev-parse", "HEAD"),
  );
  writeFileSync(
    configPath,
    Buffer.concat([
      original,
      Buffer.from(`${names}[diff "one-more"]\n textconv = private-command\n`),
    ]),
  );
  assert.throws(
    () => runGit(["-C", root, "rev-parse", "HEAD"]),
    /configuration exceeds its bound/u,
  );
});

test("runner validates diff driver UTF-8, control characters, byte lengths and probe output bounds", (t) => {
  const { root } = fixture(t);
  const configPath = join(root, ".git", "config");
  const original = readFileSync(configPath);
  const setName = (name: Buffer) => {
    writeFileSync(
      configPath,
      Buffer.concat([
        original,
        Buffer.from('[diff "'),
        name,
        Buffer.from('"]\n textconv = private-command\n'),
      ]),
    );
  };
  setName(Buffer.from("é".repeat(128)));
  assert.deepEqual(
    runGit(["-C", root, "rev-parse", "HEAD"]),
    git(root, "rev-parse", "HEAD"),
  );
  for (const name of [
    Buffer.from("é".repeat(128) + "x"),
    Buffer.from("bad\nname"),
    Buffer.from("bad\x7fname"),
    Buffer.from([0xff]),
  ]) {
    setName(name);
    assert.throws(
      () => runGit(["-C", root, "rev-parse", "HEAD"]),
      `unsafe driver bytes ${name.toString("hex")} must fail closed`,
    );
  }
  // Repeated names stay one driver, but discovery bytes are independently bounded.
  writeFileSync(
    configPath,
    Buffer.concat([
      original,
      Buffer.from(
        '[diff "bounded"]\n' + " textconv = private-command\n".repeat(60_000),
      ),
    ]),
  );
  assert.throws(
    () => runGit(["-C", root, "rev-parse", "HEAD"]),
    /output bound/u,
  );
});

function hostileConfiguration(t: TestContext, scratch: string, root: string) {
  const marker = join(scratch, "EXECUTED");
  const script = join(scratch, "evil.cjs");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const hooks = join(scratch, "hooks");
  mkdirSync(hooks);
  for (const hook of [
    "reference-transaction",
    "post-checkout",
    "post-index-change",
    "pre-commit",
    "post-commit",
    "pre-auto-gc",
  ]) {
    const path = join(hooks, hook);
    writeFileSync(path, `#!/bin/sh\n${command}\n`);
    chmodSync(path, 0o755);
  }
  const config = join(scratch, "hostile-config");
  writeFileSync(
    config,
    `[core]\n hooksPath = ${JSON.stringify(hooks.replaceAll("\\", "/"))}\n fsmonitor = ${JSON.stringify(command)}\n[uploadpack]\n packObjectsHook = ${JSON.stringify(command)}\n[diff]\n external = ${JSON.stringify(command)}\n[init]\n templateDir = ${JSON.stringify(hooks.replaceAll("\\", "/"))}\n`,
  );
  const names = [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_SSH_COMMAND",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
  ];
  const old = names.map((name) => process.env[name]);
  t.after(() => {
    names.forEach((name, i) => {
      if (old[i] === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = old[i];
    });
  });
  git(root, "config", "core.hooksPath", hooks);
  git(root, "config", "core.fsmonitor", command);
  git(root, "config", "uploadpack.packObjectsHook", command);
  git(root, "config", "diff.external", command);
  const home = join(scratch, "hostile-home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), readFileSync(config));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = home;
  process.env.GIT_CONFIG_SYSTEM = config;
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_TEMPLATE_DIR = hooks;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "uploadpack.packObjectsHook";
  process.env.GIT_CONFIG_VALUE_0 = command;
  process.env.GIT_SSH_COMMAND = command;
  return { marker, names, old };
}

test("review staging suppresses malicious system/global/template/source hooks including upload-pack child", (t) => {
  const { root, scratch, proposal, patch } = fixture(t);
  const { marker } = hostileConfiguration(t, scratch, root);
  // Positive control: these are executable scripts, not inert config strings.
  assert.throws(() =>
    execFileSync(
      "git",
      [
        "clone",
        "--no-local",
        "--no-checkout",
        root,
        join(scratch, "unsafe-clone"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  stageGitChangeForReview(proposal, root, patch);
  assert.equal(existsSync(marker), false);
});

test("materialization suppresses hostile configuration and inherited object/index/worktree redirects", async (t) => {
  const { root, scratch, proposal, patch } = fixture(t);
  const { marker } = hostileConfiguration(t, scratch, root);
  const { prepareGitPromotionObjects } = await materializer();
  process.env.GIT_DIR = join(scratch, "other.git");
  process.env.GIT_INDEX_FILE = join(scratch, "other-index");
  process.env.GIT_WORK_TREE = scratch;
  process.env.GIT_OBJECT_DIRECTORY = join(scratch, "other-objects");
  const result = prepareGitPromotionObjects({
    proposal,
    repositoryPath: root,
    patch,
    attemptId: randomUUID(),
  });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(scratch, "other-index")), false);
  assert.equal(existsSync(join(scratch, "other-objects")), false);
  assert.match(result.candidateCommitOid, /^[0-9a-f]{40}$/u);
});

test("rejects noncanonical UUIDs, V1, extra fields, changed patch, expired and drifted proposals", async (t) => {
  const { root, proposal, patch } = fixture(t);
  const { prepareGitPromotionObjects } = await materializer();
  const attemptId = randomUUID();
  const v1 = createGitChangeProposal({
    repositoryPath: root,
    repositoryId: proposal.repositoryId,
    destinationRef: proposal.workspace.headRef,
    actionId: proposal.actionId,
    policyDigest: proposal.policyDigest,
    patch,
    allowedPaths: ["value.txt"],
    expiresAt: proposal.expiresAt,
  });
  assert.throws(
    () =>
      prepareGitPromotionObjects({
        proposal: v1 as unknown as GitChangeProposalV2,
        repositoryPath: root,
        patch,
        attemptId,
      }),
    /requires a V2 proposal/u,
  );
  for (const id of [
    attemptId.toUpperCase(),
    `${attemptId}\n`,
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    assert.throws(
      () =>
        prepareGitPromotionObjects({
          proposal,
          repositoryPath: root,
          patch,
          attemptId: id,
        }),
      /UUID/u,
    );
  }
  const run = (p: GitChangeProposalV2, bytes = patch) =>
    prepareGitPromotionObjects({
      proposal: p,
      repositoryPath: root,
      patch: bytes,
      attemptId,
    });
  assert.throws(() => run(proposal, Buffer.from("wrong")), /Patch bytes/u);
  assert.throws(
    () => run({ ...proposal, author: "caller" } as GitChangeProposalV2),
    /unknown fields/u,
  );
  assert.throws(() =>
    run({ ...proposal, proposalVersion: 1 } as unknown as GitChangeProposalV2),
  );
  for (const field of ["headCommit", "headTree", "destinationOid"] as const) {
    const p = structuredClone(proposal);
    p.workspace[field] = "0".repeat(p.workspace[field].length);
    const unsigned: Record<string, unknown> = { ...p };
    Reflect.deleteProperty(unsigned, "proposalId");
    p.proposalId = digestCanonical(unsigned);
    assert.throws(() => run(p));
  }
  const expired = { ...proposal, expiresAt: "2000-01-01T00:00:00.000Z" };
  const unsignedExpired: Record<string, unknown> = { ...expired };
  Reflect.deleteProperty(unsignedExpired, "proposalId");
  expired.proposalId = digestCanonical(unsignedExpired);
  assert.throws(() => run(expired), /expired/u);
  writeFileSync(join(root, "value.txt"), "dirty\n");
  assert.throws(() => run(proposal), /workspace changed/u);
});

test("copies bytes before proposal getters and captures each input getter once", async (t) => {
  const { root, proposal, patch } = fixture(t);
  const { prepareGitPromotionObjects } = await materializer();
  const attemptId = randomUUID();
  const fields = { proposal, repositoryPath: root, patch, attemptId };
  const seen = new Map<string, number>();
  const input = {} as typeof fields;
  for (const [key, value] of Object.entries(fields))
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        seen.set(key, (seen.get(key) ?? 0) + 1);
        return value;
      },
    });
  const ownedProposal = structuredClone(proposal);
  for (const [key, value] of Object.entries(ownedProposal))
    Object.defineProperty(proposal, key, {
      enumerable: true,
      configurable: true,
      get(): unknown {
        seen.set(`proposal.${key}`, (seen.get(`proposal.${key}`) ?? 0) + 1);
        patch.fill(0);
        return value;
      },
    });
  const result = prepareGitPromotionObjects(input);
  assert.equal(result.proposalId, ownedProposal.proposalId);
  assert.equal(
    line(root, "cat-file", "blob", `${result.candidateCommitOid}:value.txt`),
    "after",
  );
  assert.ok([...seen.values()].every((count) => count === 1));
  ownedProposal.allowedPaths[0] = "elsewhere";
  assert.deepEqual(result.staged.changedPaths, ["value.txt"]);
});

test("supports linked .git-file worktrees without changing the common refs or either index", async (t) => {
  const { root, scratch, patch } = fixture(t);
  const linked = join(scratch, "linked ü repo");
  git(root, "worktree", "add", "-q", "-b", "linked-source", linked);
  const proposal = proposalFor(linked, patch, ["value.txt"]);
  const before = snapshot(root),
    linkedBefore = snapshot(linked);
  const { prepareGitPromotionObjects } = await materializer();
  const result = prepareGitPromotionObjects({
    proposal,
    repositoryPath: linked,
    patch,
    attemptId: randomUUID(),
  });
  assert.equal(
    line(root, "cat-file", "blob", `${result.candidateCommitOid}:value.txt`),
    "after",
  );
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(linked), linkedBefore);
});

test("preserves binary addition/deletion, executable mode and two-path rename manifests", async (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "old.dat"), Buffer.from([0, 254, 0, 1]));
  git(root, "add", ".");
  git(root, "commit", "-qm", "binary base");
  git(root, "branch", "-f", "target", "HEAD");
  rmSync(join(root, "old.dat"));
  writeFileSync(join(root, "new.dat"), Buffer.from([0, 255, 0, 7]));
  git(root, "mv", "value.txt", "renamed ü.txt");
  git(root, "add", "-A");
  git(root, "update-index", "--chmod=+x", "renamed ü.txt");
  const patch = git(root, "diff", "--cached", "--binary");
  git(root, "reset", "--hard", "-q", "HEAD");
  const proposal = proposalFor(root, patch, [
    "old.dat",
    "new.dat",
    "value.txt",
    "renamed ü.txt",
  ]);
  const before = snapshot(root);
  const { prepareGitPromotionObjects } = await materializer();
  const result = prepareGitPromotionObjects({
    proposal,
    repositoryPath: root,
    patch,
    attemptId: randomUUID(),
  });
  assert.deepEqual(result.staged.changedPaths, [
    "new.dat",
    "old.dat",
    "renamed ü.txt",
    "value.txt",
  ]);
  assert.deepEqual(
    git(root, "cat-file", "blob", `${result.candidateCommitOid}:new.dat`),
    Buffer.from([0, 255, 0, 7]),
  );
  assert.match(
    line(root, "ls-tree", result.candidateTreeOid, "renamed ü.txt"),
    /^100755 blob/u,
  );
  assert.throws(() =>
    git(root, "cat-file", "-e", `${result.candidateCommitOid}:old.dat`),
  );
  assert.deepEqual(snapshot(root), before);
  const scoped = proposalFor(root, patch, [
    "new.dat",
    "old.dat",
    "renamed ü.txt",
  ]);
  assert.throws(
    () =>
      prepareGitPromotionObjects({
        proposal: scoped,
        repositoryPath: root,
        patch,
        attemptId: randomUUID(),
      }),
    /outside the proposal scope/u,
  );
});

test("rejects symlink/submodule effects before importing any candidate", async (t) => {
  const { root } = fixture(t);
  const { prepareGitPromotionObjects } = await materializer();
  for (const mode of ["120000", "160000"]) {
    const oid =
      mode === "160000"
        ? line(root, "rev-parse", "HEAD")
        : execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
            input: "value.txt",
            encoding: "utf8",
          }).trim();
    git(
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      `${mode},${oid},forbidden`,
    );
    const patch = git(root, "diff", "--cached", "--binary");
    git(root, "reset", "--hard", "-q", "HEAD");
    // A reset may retain the empty submodule directory; remove only our fixture.
    rmSync(join(root, "forbidden"), { recursive: true, force: true });
    const proposal = proposalFor(root, patch, ["forbidden"]);
    const before = snapshot(root);
    assert.throws(
      () =>
        prepareGitPromotionObjects({
          proposal,
          repositoryPath: root,
          patch,
          attemptId: randomUUID(),
        }),
      /symlink, submodule/u,
    );
    assert.deepEqual(snapshot(root), before);
  }
});

test("configured hook commands cannot bypass the empty hooks directory", (t) => {
  const { root, scratch } = fixture(t);
  const marker = join(scratch, "configured-hook-executed");
  const script = join(scratch, "configured.cjs");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  );
  git(
    root,
    "config",
    "hook.evil.command",
    `${quote(process.execPath)} ${quote(script)}`,
  );
  git(root, "config", "hook.evil.event", "post-index-change");
  runGit(["-C", root, "read-tree", "HEAD"]);
  assert.equal(existsSync(marker), false);
});

test("huge unchanged base blob is excluded; tiny patch producing an over-cap new blob fails closed", async (t) => {
  const { root, patch } = fixture(t);
  const expensive = Buffer.from(
    `before\ncontext1\ncontext2\ncontext3\n${randomBytes(20 * 1024 * 1024).toString("base64")}\n`,
  );
  writeFileSync(join(root, "huge.txt"), expensive);
  git(root, "add", ".");
  git(root, "commit", "-qm", "large base");
  git(root, "branch", "-f", "target", "HEAD");
  const proposal = proposalFor(root, patch, ["value.txt"]);
  const { prepareGitPromotionObjects } = await materializer();
  const result = prepareGitPromotionObjects({
    proposal,
    repositoryPath: root,
    patch,
    attemptId: randomUUID(),
  });
  const packs = readdirSync(join(root, ".git", "objects", "pack")).filter(
    (name) => name.endsWith(".pack"),
  );
  assert.equal(packs.length, 1);
  const firstPack = packs[0];
  if (!firstPack) throw new Error("Expected a pack file");
  const importedPack = readFileSync(
    join(root, ".git", "objects", "pack", firstPack),
  );
  assert.equal(importedPack.readUInt32BE(8), 3); // only candidate commit/tree/new value blob
  assert.ok(importedPack.length < 4096);
  assert.equal(
    line(root, "cat-file", "blob", `${result.candidateCommitOid}:value.txt`),
    "after",
  );
  const tinyPatch = Buffer.from(
    "diff --git a/huge.txt b/huge.txt\n--- a/huge.txt\n+++ b/huge.txt\n@@ -1,4 +1,4 @@\n-before\n+after\n context1\n context2\n context3\n",
  );
  const hugeProposal = proposalFor(root, tinyPatch, ["huge.txt"]);
  const before = snapshot(root);
  assert.throws(
    () =>
      prepareGitPromotionObjects({
        proposal: hugeProposal,
        repositoryPath: root,
        patch: tinyPatch,
        attemptId: randomUUID(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /time or output bound exceeded/u);
      assert.match(error.stack ?? "", /materializeStagedGitObjects/u); // pack, not clone/staged-diff cap
      return true;
    },
  );
  assert.deepEqual(readFileSync(join(root, "huge.txt")), expensive);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(
    readdirSync(join(root, ".git", "objects", "pack")).filter((name) =>
      name.endsWith(".pack"),
    ),
    packs,
  );
});

test("runner rejects truncated stdout/stderr and unexpected nonzero quiet probes without diagnostics", (t) => {
  const { root } = fixture(t);
  assert.throws(
    () =>
      runGit(["-C", root, "cat-file", "blob", "HEAD:value.txt"], undefined, 1),
    /output bound/u,
  );
  assert.throws(
    () =>
      runGit(
        ["-C", root, "rev-parse", "--verify", "private-source-value"],
        undefined,
        1,
      ),
    /output bound/u,
  );
  assert.throws(
    () => runGit(["-C", root, "symbolic-ref", "--quiet", "refs/heads/target"]),
    /nonzero command result/u,
  );
});

for (const remote of [
  "ssh://example.invalid/repository",
  "https://example.invalid/repository",
  "ext::untrusted-helper",
  "file:///nonexistent-promisor",
]) {
  test(`missing promisor objects never execute a transport (${remote})`, async (t) => {
    const { root, scratch, patch, proposal } = fixture(t);
    const blob = line(root, "rev-parse", "HEAD:value.txt");
    const marker = join(scratch, "network-child");
    const script = join(scratch, "transport.cjs");
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);`,
    );
    const command = `${quote(process.execPath)} ${quote(script)}`;
    git(root, "config", "remote.trap.url", remote);
    git(root, "config", "remote.trap.promisor", "true");
    git(root, "config", "remote.trap.partialclonefilter", "blob:none");
    git(root, "config", "remote.trap.uploadpack", command);
    git(root, "config", "core.sshCommand", command);
    git(root, "config", "protocol.ext.allow", "always");
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const beforeIndex = readFileSync(join(root, ".git", "index"));
    const { prepareGitPromotionObjects } = await materializer();
    assert.throws(() =>
      prepareGitPromotionObjects({
        proposal,
        repositoryPath: root,
        patch,
        attemptId: randomUUID(),
      }),
    );
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readFileSync(join(root, ".git", "index")), beforeIndex);
    assert.equal(readFileSync(join(root, "value.txt"), "utf8"), "before\n");
  });
}

test("replacement refs and executable diff/textconv/filter config do not reinterpret the base or staged effect", async (t) => {
  const { root, scratch, patch } = fixture(t);
  writeFileSync(
    join(root, ".gitattributes"),
    "value.txt diff=evil filter=evil\n",
  );
  git(root, "add", ".gitattributes");
  git(root, "commit", "-qm", "attributes");
  git(root, "branch", "-f", "target", "HEAD");
  const proposal = proposalFor(root, patch, ["value.txt"]);
  const reviewed = stageGitChangeForReview(proposal, root, patch);
  const marker = join(scratch, "diff-child");
  const script = join(scratch, "diff.cjs");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  for (const key of [
    "diff.external",
    "diff.evil.command",
    "diff.evil.textconv",
    "filter.evil.clean",
    "filter.evil.smudge",
    "core.fsmonitor",
  ])
    git(root, "config", key, command);
  const replacement = execFileSync(
    "git",
    ["-C", root, "commit-tree", "HEAD^{tree}", "-m", "replacement"],
    { encoding: "utf8" },
  ).trim();
  git(root, "replace", proposal.workspace.headCommit, replacement);
  assert.equal(
    existsSync(marker),
    false,
    "fixture setup must not invoke the malicious command",
  );
  assert.deepEqual(
    observeGitPromotionWorkspace(root, "refs/heads/target"),
    proposal.workspace,
  );
  assert.equal(
    existsSync(marker),
    false,
    "observation must not invoke the malicious command",
  );
  const { prepareGitPromotionObjects } = await materializer();
  const result = prepareGitPromotionObjects({
    proposal,
    repositoryPath: root,
    patch,
    attemptId: randomUUID(),
  });
  assert.deepEqual(result.staged, reviewed.staged);
  assert.equal(existsSync(marker), false);
  assert.equal(
    line(root, "rev-parse", `refs/replace/${proposal.workspace.headCommit}`),
    replacement,
  );
});

test("expiry during object preparation rejects and always cleans staging/runner scratch without moving refs", async (t) => {
  const { root, scratch, patch, proposal } = fixture(t);
  const before = snapshot(root);
  const temporary = join(scratch, "temporary");
  mkdirSync(temporary);
  const names = ["TMPDIR", "TMP", "TEMP"];
  const old = names.map((name) => process.env[name]);
  const { prepareGitPromotionObjects } = await materializer();
  const now = Date.now();
  let calls = 0;
  const clock = t.mock.method(Date, "now", () =>
    ++calls >= 4 ? Date.parse(proposal.expiresAt) + 1 : now,
  );
  try {
    names.forEach((name) => (process.env[name] = temporary));
    assert.throws(
      () =>
        prepareGitPromotionObjects({
          proposal,
          repositoryPath: root,
          patch,
          attemptId: randomUUID(),
        }),
      /expired during staging/u,
    );
    assert.deepEqual(readdirSync(temporary), []);
  } finally {
    clock.mock.restore();
    names.forEach((name, i) => {
      if (old[i] === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = old[i];
    });
  }
  assert.deepEqual(snapshot(root), before);
});

test("read-only observation fails closed before recursive submodule status can execute nested filters", (t) => {
  const { root, scratch } = fixture(t);
  const child = join(root, "submodule");
  mkdirSync(child);
  git(child, "init", "-q", "-b", "main");
  git(child, "config", "user.name", "Test");
  git(child, "config", "user.email", "test@example.invalid");
  writeFileSync(join(child, "value.txt"), "data\n");
  writeFileSync(join(child, ".gitattributes"), "value.txt filter=nested\n");
  git(child, "add", ".");
  git(child, "commit", "-qm", "nested");
  writeFileSync(
    join(root, ".gitmodules"),
    '[submodule "nested"]\n path = submodule\n url = ./submodule\n',
  );
  git(root, "add", ".gitmodules");
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${line(child, "rev-parse", "HEAD")},submodule`,
  );
  git(root, "commit", "-qm", "gitlink base");
  git(root, "branch", "-f", "target", "HEAD");
  const marker = join(scratch, "nested-child");
  const script = join(scratch, "nested.cjs");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);`,
  );
  git(
    child,
    "config",
    "filter.nested.clean",
    `${quote(process.execPath)} ${quote(script)}`,
  );
  writeFileSync(join(child, "value.txt"), "data\n"); // force status to hash through the driver
  assert.throws(
    () => observeGitPromotionWorkspace(root, "refs/heads/target"),
    /submodule/u,
  );
  assert.equal(existsSync(marker), false);
});

test("exact readback rejects a changed Git-generated diff rather than trusting installed object hashes", async (t) => {
  const { root, patch, proposal } = fixture(t);
  const before = snapshot(root);
  git(root, "config", "diff.srcPrefix", "changed-prefix/");
  const { prepareGitPromotionObjects } = await materializer();
  assert.throws(
    () =>
      prepareGitPromotionObjects({
        proposal,
        repositoryPath: root,
        patch,
        attemptId: randomUUID(),
      }),
    /Imported candidate differs from exact staged commit\/tree\/effect/u,
  );
  assert.deepEqual(snapshot(root), before);
});
