import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { digestCanonical, sha256 } from "./digest.js";
import type { Digest } from "./types.js";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_ALLOWED_PATHS = 256;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface GitWorkspaceWitnessV1 {
  source: "git_observed";
  rootDigest: Digest;
  headCommit: string;
  headTree: string;
  destinationRef: string;
  destinationOid: string;
  status: "clean";
}

export interface GitChangeProposalV1 {
  proposalVersion: 1;
  proposalId: Digest;
  repositoryId: string;
  actionId: Digest;
  policyDigest: Digest;
  workspace: GitWorkspaceWitnessV1;
  patchDigest: Digest;
  allowedPaths: string[];
  createdAt: string;
  expiresAt: string;
}

export interface CreateGitChangeProposalInput {
  repositoryPath: string;
  repositoryId: string;
  destinationRef: string;
  actionId: Digest;
  policyDigest: Digest;
  patch: Uint8Array;
  allowedPaths: string[];
  expiresAt: string;
}

function git(repositoryPath: string, ...args: string[]): string {
  // Inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE can redirect observations
  // away from the path we were asked to witness.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repositoryPath,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    },
  );
}

function gitLine(repositoryPath: string, ...args: string[]): string {
  const output = git(repositoryPath, ...args);
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n")) {
    throw new Error("Git returned an unexpected single-line value");
  }
  return output.slice(0, -1);
}

function validateRef(repositoryPath: string, destinationRef: string): void {
  if (!destinationRef.startsWith("refs/heads/")) {
    throw new Error("Destination must be a local branch ref");
  }
  git(repositoryPath, "check-ref-format", destinationRef);
}

/** Read-only witness for a clean, checked-out Git branch. Not an atomic commit gate. */
export function observeCleanGitWorkspace(
  repositoryPath: string,
  destinationRef: string,
): GitWorkspaceWitnessV1 {
  const root = realpathSync(repositoryPath);
  validateRef(root, destinationRef);
  const gitRoot = realpathSync(gitLine(root, "rev-parse", "--show-toplevel"));
  if (root !== gitRoot) {
    throw new Error("Repository path must be the Git worktree root");
  }

  const capture = () => {
    const currentRef = gitLine(root, "symbolic-ref", "--quiet", "HEAD");
    if (currentRef !== destinationRef) {
      throw new Error("Destination ref is not the checked-out branch");
    }
    const headCommit = gitLine(root, "rev-parse", "--verify", "HEAD^{commit}");
    const headTree = gitLine(root, "rev-parse", "--verify", "HEAD^{tree}");
    const destinationOid = gitLine(
      root,
      "rev-parse",
      "--verify",
      `${destinationRef}^{commit}`,
    );
    if (
      !OID_PATTERN.test(headCommit) ||
      !OID_PATTERN.test(headTree) ||
      destinationOid !== headCommit
    ) {
      throw new Error("Git HEAD, tree, or destination ref is inconsistent");
    }
    if (
      git(
        root,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ) !== ""
    ) {
      throw new Error("Git worktree must be clean, including untracked files");
    }
    return { headCommit, headTree, destinationOid };
  };

  const first = capture();
  const second = capture();
  if (digestCanonical(first) !== digestCanonical(second)) {
    throw new Error("Git workspace changed during observation");
  }
  return {
    source: "git_observed",
    rootDigest: sha256(root),
    ...second,
    destinationRef,
    status: "clean",
  };
}

function normalizeAllowedPaths(paths: string[]): string[] {
  if (paths.length === 0 || paths.length > MAX_ALLOWED_PATHS) {
    throw new Error("Allowed paths must contain 1 to 256 exact file paths");
  }
  const normalized = paths.map((path) => {
    let unsafeCharacter = false;
    for (let index = 0; index < path.length; index += 1) {
      const codeUnit = path.charCodeAt(index);
      if (
        codeUnit < 32 ||
        codeUnit === 127 ||
        ":*?[]".includes(path.charAt(index))
      ) {
        unsafeCharacter = true;
        break;
      }
    }
    if (
      path.length === 0 ||
      path.includes("\\") ||
      unsafeCharacter ||
      path
        .split("/")
        .some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            segment.toLowerCase() === ".git" ||
            segment.endsWith(".") ||
            segment.endsWith(" ") ||
            segment.normalize("NFC") !== segment,
        )
    ) {
      throw new Error(
        `Unsafe or non-exact allowed path: ${JSON.stringify(path)}`,
      );
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Allowed paths contain duplicates");
  }
  return normalized.sort();
}

/** Bind a proposed patch to observed Git state; does not approve or execute it. */
export function createGitChangeProposal(
  input: CreateGitChangeProposalInput,
): GitChangeProposalV1 {
  if (input.repositoryId.trim() === "") {
    throw new Error("Repository identity is required");
  }
  if (
    !DIGEST_PATTERN.test(input.actionId) ||
    !DIGEST_PATTERN.test(input.policyDigest)
  ) {
    throw new Error("Action and policy digests must be SHA-256 digests");
  }
  if (
    input.patch.byteLength === 0 ||
    input.patch.byteLength > MAX_PATCH_BYTES
  ) {
    throw new Error("Proposed patch must contain 1 byte to 4 MiB");
  }
  const allowedPaths = normalizeAllowedPaths(input.allowedPaths);
  const createdAt = new Date().toISOString();
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.parse(createdAt)) {
    throw new Error("Proposal expiry must be a future date-time");
  }
  const unsigned = {
    proposalVersion: 1 as const,
    repositoryId: input.repositoryId,
    actionId: input.actionId,
    policyDigest: input.policyDigest,
    workspace: observeCleanGitWorkspace(
      input.repositoryPath,
      input.destinationRef,
    ),
    patchDigest: sha256(input.patch),
    allowedPaths,
    createdAt,
    expiresAt: new Date(expiry).toISOString(),
  };
  return { ...unsigned, proposalId: digestCanonical(unsigned) };
}

/** Checks integrity only; authenticity and effect enforcement require later phases. */
export function verifyGitChangeProposal(
  proposal: GitChangeProposalV1,
): boolean {
  try {
    const { proposalId, ...unsigned } = proposal;
    return proposalId === digestCanonical(unsigned);
  } catch {
    return false;
  }
}

/** Read-only drift check; a later promotion gate must recheck atomically. */
export function matchesCurrentGitWorkspace(
  proposal: GitChangeProposalV1,
  repositoryPath: string,
  patch: Uint8Array,
): boolean {
  if (
    !verifyGitChangeProposal(proposal) ||
    sha256(patch) !== proposal.patchDigest
  ) {
    return false;
  }
  try {
    return (
      digestCanonical(
        observeCleanGitWorkspace(
          repositoryPath,
          proposal.workspace.destinationRef,
        ),
      ) === digestCanonical(proposal.workspace)
    );
  } catch {
    return false;
  }
}
