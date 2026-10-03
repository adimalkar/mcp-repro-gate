import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestCanonical, sha256 } from "./digest.js";
import { ownGitChangeProposal } from "./git-change-contract.js";
import {
  matchesCurrentGitWorkspace,
  verifyGitChangeProposal,
  type GitChangeProposal,
  type GitChangeProposalV2,
} from "./git-change-proposal.js";
import { runGit as git, runGitLine as gitLine } from "./git-runner.js";
import type { PreparedGitPromotionObjectsV1 } from "./git-promotion-objects.js";
import type { Digest } from "./types.js";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_COMMIT_BYTES = 4096;
const ATTEMPT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
  proposal: GitChangeProposal,
  repositoryPath: string,
  patch: Uint8Array,
): StagedGitChangeV1 {
  return stageGitChange(proposal, repositoryPath, patch).staged;
}

/** Return the exact Git-generated staged binary diff from one isolated pass. */
export function stageGitChangeForReview(
  proposal: GitChangeProposal,
  repositoryPath: string,
  patch: Uint8Array,
): { staged: StagedGitChangeV1; stagedPatch: Uint8Array } {
  return stageGitChange(proposal, repositoryPath, patch);
}

/** Internal concrete extension of the same interpreter; never an approval gate. */
export function stageGitChangeForPromotion(
  proposal: GitChangeProposalV2,
  repositoryPath: string,
  patch: Uint8Array,
  attemptId: string,
): PreparedGitPromotionObjectsV1 {
  const result = stageGitChange(proposal, repositoryPath, patch, attemptId);
  if (!result.prepared) throw new Error("Candidate objects were not prepared");
  return result.prepared;
}

function stageGitChange(
  input: GitChangeProposal,
  repositoryPath: string,
  patchInput: Uint8Array,
  attemptId?: string,
): {
  staged: StagedGitChangeV1;
  stagedPatch: Uint8Array;
  prepared?: PreparedGitPromotionObjectsV1;
} {
  if (
    !(patchInput instanceof Uint8Array) ||
    patchInput.byteLength === 0 ||
    patchInput.byteLength > MAX_PATCH_BYTES
  ) {
    throw new Error("Patch bytes do not match the bounded proposal patch");
  }
  const patch = Buffer.from(patchInput);
  const proposal = ownGitChangeProposal(input);
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
    const root = realpathSync.native(repositoryPath);
    const clone = join(scratch, "clone");
    git(["clone", "--no-local", "--no-checkout", "--quiet", "--", root, clone]);
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
        "--no-abbrev",
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
    const staged: StagedGitChangeV1 = {
      stageVersion: 1,
      proposalId: proposal.proposalId,
      baseCommit: proposal.workspace.headCommit,
      candidateTreeOid,
      changedPaths,
      stagedPatchDigest: sha256(stagedPatch),
    };
    if (attemptId === undefined) return { staged, stagedPatch };
    if (proposal.proposalVersion !== 2)
      throw new Error("Object preparation requires a V2 proposal");
    const prepared = materializeStagedGitObjects(
      proposal,
      root,
      clone,
      attemptId,
      staged,
      stagedPatch,
      raw,
    );
    if (Date.now() >= expiry)
      throw new Error("Git change proposal expired during staging");
    if (!matchesCurrentGitWorkspace(proposal, root, patch))
      throw new Error("Git workspace changed during staging");
    return { staged, stagedPatch, prepared };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Internal staging continuation, concrete only; never a caller-supplied callback. */
function materializeStagedGitObjects(
  proposal: GitChangeProposalV2,
  repositoryPath: string,
  clone: string,
  attemptId: string,
  staged: StagedGitChangeV1,
  stagedPatch: Buffer,
  stagedRawDiff: Buffer,
): PreparedGitPromotionObjectsV1 {
  const inClone = (...args: string[]) => ["-C", clone, ...args];
  const inRepository = (...args: string[]) => ["-C", repositoryPath, ...args];
  const parent = proposal.workspace.destinationOid;
  if (
    !ATTEMPT_PATTERN.test(attemptId) ||
    parent !== proposal.workspace.headCommit ||
    staged.candidateTreeOid.length !== parent.length
  ) {
    throw new Error("Candidate metadata is inconsistent");
  }
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const seconds = Math.floor(now / 1000);
  const rawCommit = Buffer.from(
    `tree ${staged.candidateTreeOid}\nparent ${parent}\nauthor ReproGate <reprogate@localhost> ${String(seconds)} +0000\ncommitter ReproGate <reprogate@localhost> ${String(seconds)} +0000\n\nReproGate candidate v1\nproposal ${proposal.proposalId}\nattempt ${attemptId}\ncreated ${createdAt}\n`,
    "utf8",
  );
  if (rawCommit.length > MAX_COMMIT_BYTES)
    throw new Error("Candidate commit exceeds its bound");
  const candidateCommitOid = gitLine(
    inClone("hash-object", "-t", "commit", "-w", "--stdin"),
    rawCommit,
    MAX_COMMIT_BYTES,
  );
  if (
    !OID_PATTERN.test(candidateCommitOid) ||
    candidateCommitOid.length !== parent.length
  )
    throw new Error("Candidate commit has an invalid object ID");
  const rawTree = git(inClone("cat-file", "tree", staged.candidateTreeOid));
  // No thin pack or reuse of base deltas: import contains precisely the new
  // candidate closure, never the old base closure. Full blobs can hit the cap
  // even for small textual patches; that is a deliberate fail-closed limit.
  const pack = git(
    inClone(
      "pack-objects",
      "--stdout",
      "--revs",
      "--no-reuse-delta",
      "--no-reuse-object",
      "--window=0",
    ),
    Buffer.from(`${candidateCommitOid}\n^${parent}\n`, "ascii"),
  );
  git(inRepository("index-pack", "--stdin", "--strict"), pack);
  const importedCommit = git(
    inRepository("cat-file", "commit", candidateCommitOid),
    undefined,
    MAX_COMMIT_BYTES,
  );
  const importedTree = git(
    inRepository("cat-file", "tree", staged.candidateTreeOid),
  );
  const importedTreeOid = gitLine(
    inRepository("rev-parse", "--verify", `${candidateCommitOid}^{tree}`),
    undefined,
    MAX_COMMIT_BYTES,
  );
  const importedRawDiff = git(
    inRepository(
      "diff",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "--no-ext-diff",
      "--no-textconv",
      parent,
      candidateCommitOid,
      "--",
    ),
  );
  const importedPatch = git(
    inRepository(
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      parent,
      candidateCommitOid,
      "--",
    ),
  );
  if (
    !importedCommit.equals(rawCommit) ||
    !importedTree.equals(rawTree) ||
    importedTreeOid !== staged.candidateTreeOid ||
    !importedRawDiff.equals(stagedRawDiff) ||
    !importedPatch.equals(stagedPatch) ||
    sha256(importedPatch) !== staged.stagedPatchDigest
  ) {
    throw new Error(
      "Imported candidate differs from exact staged commit/tree/effect",
    );
  }
  return {
    preparedVersion: 1,
    attemptId,
    proposalId: proposal.proposalId,
    expectedOldOid: parent,
    baseCommit: proposal.workspace.headCommit,
    candidateCommitOid,
    candidateTreeOid: staged.candidateTreeOid,
    staged,
    effectDigest: digestCanonical(staged),
    hostCommitMetadataDigest: sha256(rawCommit),
    createdAt,
  };
}
