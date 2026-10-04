import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { runGit } from "../src/git-runner.js";
import { sha256 } from "../src/digest.js";
import {
  createGitChangeProposal,
  createGitChangeProposalV2,
} from "../src/git-change-proposal.js";
import { stageGitChangeProposal } from "../src/git-change-stage.js";

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const configurations = [
  ...["true", "TRUE", "1", "yes"].map((value) => ({
    name: `global autocrlf=${value}`,
    global: [["core.autocrlf", value]],
    local: [] as string[][],
    bare: false,
    checkout: true,
    crlf: true,
  })),
  {
    name: "global autocrlf=INPUT",
    global: [["core.autocrlf", "INPUT"]],
    local: [],
    bare: false,
    checkout: false,
    crlf: true,
  },
  {
    name: "local autocrlf=INPUT overrides global true",
    global: [["core.autocrlf", "true"]],
    local: [["core.autocrlf", "INPUT"]],
    bare: false,
    checkout: false,
    crlf: true,
  },
  {
    name: "global bare autocrlf",
    global: [],
    local: [],
    bare: true,
    checkout: true,
    crlf: true,
  },
  {
    name: "local bare autocrlf overrides global false",
    global: [["core.autocrlf", "false"]],
    local: [],
    bare: "local",
    checkout: true,
    crlf: true,
  },
  {
    name: "local uppercase EOL overrides global CRLF",
    global: [
      ["core.autocrlf", "false"],
      ["core.eol", "CRLF"],
    ],
    local: [["core.eol", "LF"]],
    bare: false,
    checkout: true,
    crlf: false,
  },
  {
    name: "global uppercase EOL CRLF",
    global: [
      ["core.autocrlf", "false"],
      ["core.eol", "CRLF"],
    ],
    local: [],
    bare: false,
    checkout: true,
    crlf: true,
  },
  {
    name: "multivar effective autocrlf INPUT and EOL LF",
    global: [
      ["core.autocrlf", "true"],
      ["core.eol", "CRLF"],
    ],
    local: [
      ["core.autocrlf", "false"],
      ["core.autocrlf", "INPUT"],
      ["core.eol", "CRLF"],
      ["core.eol", "LF"],
    ],
    bare: false,
    checkout: false,
    crlf: true,
  },
];
for (const configuration of configurations) {
  test(`${configuration.name} preserves V1/V2 staging while real content drift rejects`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "reprogate-global-crlf-"));
    const names = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
    const saved = names.map((name) => [name, process.env[name]] as const);
    try {
      const home = join(scratch, "home");
      const root = join(scratch, "repo");
      mkdirSync(home);
      for (const name of names) process.env[name] = home;
      execFileSync("git", ["init", "-q", "-b", "main", root]);
      for (const entry of configuration.global)
        git(root, "config", "--global", "--add", ...entry);
      for (const entry of configuration.local)
        git(root, "config", "--local", "--add", ...entry);
      if (configuration.bare)
        appendFileSync(
          configuration.bare === "local"
            ? join(root, ".git", "config")
            : join(home, ".gitconfig"),
          "[core]\n\tautocrlf\n",
        );
      git(root, "config", "user.name", "Global normalization fixture");
      git(root, "config", "user.email", "normalization@example.invalid");
      const path = join(root, "value.txt");
      writeFileSync(path, "before\r\n");
      writeFileSync(join(root, ".gitattributes"), "value.txt text\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "base");
      git(root, "branch", "target");
      if (configuration.checkout) {
        rmSync(path);
        git(root, "checkout", "--", "value.txt");
      }
      assert.equal(
        readFileSync(path).includes(Buffer.from("\r\n")),
        configuration.crlf,
      );
      assert.equal(git(root, "status", "--porcelain", "-z").length, 0);
      assert.equal(
        runGit(["-C", root, "status", "--porcelain", "-z"]).length,
        0,
      );
      const patch = Buffer.from(
        "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
      );
      const input = {
        repositoryPath: root,
        repositoryId: "global-normalization-fixture",
        actionId: sha256("normalization action"),
        policyDigest: sha256("normalization policy"),
        patch,
        allowedPaths: ["value.txt"],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      const v1 = createGitChangeProposal({
        ...input,
        destinationRef: "refs/heads/main",
      });
      const v2 = createGitChangeProposalV2({
        ...input,
        destinationRef: "refs/heads/target",
      });
      const sourceSnapshot = () => ({
        file: readFileSync(path),
        index: readFileSync(join(root, ".git", "index")),
        head: git(root, "rev-parse", "HEAD"),
        refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
      });
      const before = sourceSnapshot();
      const stage1 = stageGitChangeProposal(v1, root, patch);
      const stage2 = stageGitChangeProposal(v2, root, patch);
      assert.equal(stage1.candidateTreeOid, stage2.candidateTreeOid);
      assert.equal(stage1.stagedPatchDigest, stage2.stagedPatchDigest);
      assert.deepEqual(stage1.changedPaths, ["value.txt"]);
      assert.deepEqual(stage2.changedPaths, ["value.txt"]);
      assert.deepEqual(sourceSnapshot(), before);
      writeFileSync(path, "changed content\r\n");
      assert.throws(() => stageGitChangeProposal(v1, root, patch));
      assert.throws(() => stageGitChangeProposal(v2, root, patch));
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
