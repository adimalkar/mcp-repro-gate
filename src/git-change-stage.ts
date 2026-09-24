import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "./digest.js";
import {
  matchesCurrentGitWorkspace,
  verifyGitChangeProposal,
  type GitChangeProposalV1,
} from "./git-change-proposal.js";
import type { Digest } from "./types.js";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RAW_CHANGE_PATTERN =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/u;
const REGULAR_MODES = new Set(["000000", "100644", "100755"]);

export interface StagedGitChangeV1 {
  stageVersion: 1;
  proposalId: Digest;
  baseCommit: string;
  candidateTreeOid: string;
  changedPaths: string[];
  stagedPatchDigest: Digest;
}

function git(args: string[], input?: Uint8Array): Buffer {
  // Never let the caller's Git environment redirect the disposable index.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      input: input === undefined ? undefined : Buffer.from(input),
      encoding: null,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: environment,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Git staging command failed: ${result.error?.message ?? result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

function gitLine(args: string[]): string {
  const output = git(args).toString("ascii");
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n")) {
    throw new Error("Git returned an unexpected single-line value");
  }
  return output.slice(0, -1);
}

function changedPathsFromRawDiff(
  raw: Buffer,
  allowedPaths: string[],
): string[] {
  const allowedByBytes = new Map(
    allowedPaths.map((path) => [
      Buffer.from(path, "utf8").toString("hex"),
      path,
    ]),
  );
  const fields = raw.subarray(0, raw.length - 1).toString("binary");
  if (raw.length === 0 || raw[raw.length - 1] !== 0) {
    throw new Error("Git staged diff was empty or malformed");
  }
  // Latin-1 preserves each byte while splitting NUL-delimited raw records.
  const records = fields.split("\0");
  if (records.length % 2 !== 0 || records.length / 2 > 256) {
    throw new Error("Git staged diff has an unexpected number of paths");
  }
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index += 2) {
    const change = RAW_CHANGE_PATTERN.exec(records[index] ?? "");
    const pathBytes = Buffer.from(records[index + 1] ?? "", "binary");
    if (!change || pathBytes.length === 0) {
      throw new Error("Git staged diff contains a malformed change");
    }
    if (
      !REGULAR_MODES.has(change[1] ?? "") ||
      !REGULAR_MODES.has(change[2] ?? "")
    ) {
      throw new Error(
        "Git staged diff contains a symlink, submodule, or unsupported file mode",
      );
    }
    const path = allowedByBytes.get(pathBytes.toString("hex"));
    if (path === undefined) {
      throw new Error(
        "Git staged diff changes a path outside the proposal scope",
      );
    }
    if (paths.has(path)) {
      throw new Error("Git staged diff contains a duplicate path");
    }
    paths.add(path);
  }
  return [...paths].sort();
}

/** Validate a patch in an isolated index. Does not write to the protected repository. */
export function stageGitChangeProposal(
  proposal: GitChangeProposalV1,
  repositoryPath: string,
  patch: Uint8Array,
): StagedGitChangeV1 {
  if (!verifyGitChangeProposal(proposal)) {
    throw new Error("Git change proposal failed its integrity check");
  }
  const expiry = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("Git change proposal has expired");
  }
  if (
    patch.byteLength === 0 ||
    patch.byteLength > MAX_PATCH_BYTES ||
    sha256(patch) !== proposal.patchDigest
  ) {
    throw new Error("Patch bytes do not match the bounded proposal patch");
  }
  if (!matchesCurrentGitWorkspace(proposal, repositoryPath, patch)) {
    throw new Error("Git workspace changed before staging");
  }

  const scratch = mkdtempSync(join(tmpdir(), "reprogate-git-stage-"));
  try {
    const clone = join(scratch, "clone");
    git([
      "clone",
      "--no-local",
      "--no-checkout",
      "--quiet",
      "--",
      realpathSync(repositoryPath),
      clone,
    ]);
    const inClone = (...args: string[]) => ["-C", clone, ...args];
    git(inClone("read-tree", proposal.workspace.headCommit));
    git(inClone("apply", "--cached", "--binary", "-"), patch);

    // --no-renames makes a rename appear as a deletion and addition, so both
    // old and new path must be inside the exact allowlist.
    const raw = git(
      inClone(
        "diff",
        "--cached",
        "--raw",
        "-z",
        "--no-renames",
        proposal.workspace.headCommit,
        "--",
      ),
    );
    const changedPaths = changedPathsFromRawDiff(raw, proposal.allowedPaths);
    const candidateTreeOid = gitLine(inClone("write-tree"));
    if (
      !OID_PATTERN.test(candidateTreeOid) ||
      candidateTreeOid === proposal.workspace.headTree
    ) {
      throw new Error("Staged patch did not produce a new Git tree");
    }
    const stagedPatch = git(
      inClone(
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        proposal.workspace.headCommit,
        "--",
      ),
    );
    if (Date.now() >= expiry) {
      throw new Error("Git change proposal expired during staging");
    }
    if (!matchesCurrentGitWorkspace(proposal, repositoryPath, patch)) {
      throw new Error("Git workspace changed during staging");
    }
    return {
      stageVersion: 1,
      proposalId: proposal.proposalId,
      baseCommit: proposal.workspace.headCommit,
      candidateTreeOid,
      changedPaths,
      stagedPatchDigest: sha256(stagedPatch),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
