import { realpathSync, statSync } from "node:fs";

import { digestCanonical, sha256 } from "./digest.js";
import {
  ownGitChangeProposal,
  parseGitWorktreeList,
} from "./git-change-contract.js";
import { runGit } from "./git-runner.js";
import type { Digest } from "./types.js";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_ALLOWED_PATHS = 256;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
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

/**
 * Witness for a destination branch that no worktree has checked out. The source
 * checkout is a different symbolic branch (`headRef`) at the same commit.
 */
export interface GitWorkspaceWitnessV2 {
  workspaceVersion: 2;
  source: "git_observed";
  destinationMode: "uncheckout_destination";
  rootDigest: Digest;
  commonDirDigest: Digest;
  headRef: string;
  headCommit: string;
  headTree: string;
  destinationRef: string;
  destinationOid: string;
  status: "clean";
}

export interface GitChangeProposalV2 {
  proposalVersion: 2;
  proposalId: Digest;
  repositoryId: string;
  actionId: Digest;
  policyDigest: Digest;
  workspace: GitWorkspaceWitnessV2;
  patchDigest: Digest;
  allowedPaths: string[];
  createdAt: string;
  expiresAt: string;
}

export type GitWorkspaceWitness = GitWorkspaceWitnessV1 | GitWorkspaceWitnessV2;
export type GitChangeProposal = GitChangeProposalV1 | GitChangeProposalV2;

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

/** Exact Git action arguments to persist in a trusted action plan. */
export interface GitChangeIntentV1 {
  intentVersion: 1;
  repositoryId: string;
  workspace: GitWorkspaceWitnessV1;
  patchDigest: Digest;
  allowedPaths: string[];
  expiresAt: string;
}

export interface GitChangeIntentV2 {
  intentVersion: 2;
  repositoryId: string;
  workspace: GitWorkspaceWitnessV2;
  patchDigest: Digest;
  allowedPaths: string[];
  expiresAt: string;
}

export type GitChangeIntent = GitChangeIntentV1 | GitChangeIntentV2;

export type CreateGitChangeIntentInput = Omit<
  CreateGitChangeProposalInput,
  "actionId" | "policyDigest"
>;

function gitBytes(repositoryPath: string, ...args: string[]): Buffer {
  return runGit(
    ["-C", repositoryPath, ...args],
    undefined,
    MAX_GIT_OUTPUT_BYTES,
  );
}

function git(repositoryPath: string, ...args: string[]): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    gitBytes(repositoryPath, ...args),
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
  // Path strings can differ for one directory (notably 8.3 aliases on Windows).
  // Compare filesystem identity so a nested directory is still rejected.
  const requestedStat = statSync(root, { bigint: true });
  const gitStat = statSync(gitRoot, { bigint: true });
  if (
    !requestedStat.isDirectory() ||
    !gitStat.isDirectory() ||
    requestedStat.ino === 0n ||
    requestedStat.dev !== gitStat.dev ||
    requestedStat.ino !== gitStat.ino
  ) {
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
    rootDigest: sha256(gitRoot),
    ...second,
    destinationRef,
    status: "clean",
  };
}

/**
 * Read-only witness for a clean source worktree whose symbolic branch differs
 * from a direct, unchecked-out destination branch at the same commit. Not an
 * atomic gate: a later promotion must recheck.
 */
export function observeGitPromotionWorkspace(
  repositoryPath: string,
  destinationRef: string,
): GitWorkspaceWitnessV2 {
  const root = realpathSync.native(repositoryPath);
  validateRef(root, destinationRef);

  const capture = (): GitWorkspaceWitnessV2 => {
    const gitRoot = realpathSync.native(
      gitLine(root, "rev-parse", "--show-toplevel"),
    );
    // Compare filesystem identity, not path strings, so nested roots are rejected.
    const requestedStat = statSync(root, { bigint: true });
    const gitStat = statSync(gitRoot, { bigint: true });
    if (
      !requestedStat.isDirectory() ||
      !gitStat.isDirectory() ||
      requestedStat.ino === 0n ||
      requestedStat.dev !== gitStat.dev ||
      requestedStat.ino !== gitStat.ino ||
      gitLine(root, "rev-parse", "--is-bare-repository") !== "false"
    ) {
      throw new Error("Repository path must be the Git worktree root");
    }
    const commonDir = realpathSync.native(
      gitLine(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    if (!statSync(commonDir).isDirectory()) {
      throw new Error("Git common directory is not a directory");
    }

    let headRef: string;
    try {
      headRef = gitLine(root, "symbolic-ref", "--quiet", "HEAD");
    } catch {
      throw new Error("Source HEAD must be a symbolic local branch");
    }
    validateRef(root, headRef);
    if (headRef === destinationRef) {
      throw new Error(
        "Destination ref must differ from the source's checked-out branch",
      );
    }

    // for-each-ref reports a symbolic ref's target; rev-parse would follow it.
    const destination = git(
      root,
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)",
      destinationRef,
    )
      .split("\n")
      .filter((line) => line.startsWith(`${destinationRef}\t`));
    const [refname, listedOid, objectType, symref] =
      destination[0]?.split("\t") ?? [];
    if (
      destination.length !== 1 ||
      refname !== destinationRef ||
      objectType !== "commit" ||
      symref !== "" ||
      listedOid === undefined
    ) {
      throw new Error("Destination must be an existing direct local branch");
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
      destinationOid !== headCommit ||
      listedOid !== destinationOid ||
      gitLine(root, "rev-parse", "--verify", `${headRef}^{commit}`) !==
        headCommit
    ) {
      throw new Error("Git HEAD, tree, or destination ref is inconsistent");
    }

    const worktrees = parseGitWorktreeList(
      gitBytes(root, "worktree", "list", "--porcelain", "-z"),
    );
    if (worktrees.some((worktree) => worktree.branch === destinationRef)) {
      throw new Error("Destination branch is checked out in a worktree");
    }
    const sources = worktrees.filter((worktree) => {
      try {
        const stat = statSync(worktree.path, { bigint: true });
        return stat.dev === requestedStat.dev && stat.ino === requestedStat.ino;
      } catch {
        return false;
      }
    });
    if (sources.length !== 1 || sources[0]?.branch !== headRef) {
      throw new Error("Source worktree is not registered on its branch");
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
    return {
      workspaceVersion: 2,
      source: "git_observed",
      destinationMode: "uncheckout_destination",
      rootDigest: sha256(gitRoot),
      commonDirDigest: sha256(commonDir),
      headRef,
      headCommit,
      headTree,
      destinationRef,
      destinationOid,
      status: "clean",
    };
  };

  const first = capture();
  const second = capture();
  if (digestCanonical(first) !== digestCanonical(second)) {
    throw new Error("Git workspace changed during observation");
  }
  return second;
}

/** Observe the current workspace with the observer for the proposal's version. */
export function observeGitWorkspaceForProposal(
  input: GitChangeProposal,
  repositoryPath: string,
): GitWorkspaceWitness {
  const proposal = ownGitChangeProposal(input);
  return proposal.proposalVersion === 1
    ? observeCleanGitWorkspace(
        repositoryPath,
        proposal.workspace.destinationRef,
      )
    : observeGitPromotionWorkspace(
        repositoryPath,
        proposal.workspace.destinationRef,
      );
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

function validateIntentInput(input: CreateGitChangeIntentInput): number {
  if (input.repositoryId.trim() === "") {
    throw new Error("Repository identity is required");
  }
  if (
    input.patch.byteLength === 0 ||
    input.patch.byteLength > MAX_PATCH_BYTES
  ) {
    throw new Error("Proposed patch must contain 1 byte to 4 MiB");
  }
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("Proposal expiry must be a future date-time");
  }
  return expiry;
}

/** Observe and validate the exact arguments before asking the kernel to plan. */
export function createGitChangeIntent(
  input: CreateGitChangeIntentInput,
): GitChangeIntentV1 {
  const expiry = validateIntentInput(input);
  return {
    intentVersion: 1,
    repositoryId: input.repositoryId,
    workspace: observeCleanGitWorkspace(
      input.repositoryPath,
      input.destinationRef,
    ),
    patchDigest: sha256(input.patch),
    allowedPaths: normalizeAllowedPaths(input.allowedPaths),
    expiresAt: new Date(expiry).toISOString(),
  };
}

/** Like createGitChangeIntent, for an unchecked-out destination (V2 witness). */
export function createGitChangeIntentV2(
  input: CreateGitChangeIntentInput,
): GitChangeIntentV2 {
  const expiry = validateIntentInput(input);
  return {
    intentVersion: 2,
    repositoryId: input.repositoryId,
    workspace: observeGitPromotionWorkspace(
      input.repositoryPath,
      input.destinationRef,
    ),
    patchDigest: sha256(input.patch),
    allowedPaths: normalizeAllowedPaths(input.allowedPaths),
    expiresAt: new Date(expiry).toISOString(),
  };
}

/** Recover the exact plan arguments from a proposal for provenance checks. */
export function gitChangeIntentFromProposal(
  proposal: GitChangeProposalV1,
): GitChangeIntentV1;
export function gitChangeIntentFromProposal(
  proposal: GitChangeProposalV2,
): GitChangeIntentV2;
export function gitChangeIntentFromProposal(
  proposal: GitChangeProposal,
): GitChangeIntent;
export function gitChangeIntentFromProposal(
  input: GitChangeProposal,
): GitChangeIntent {
  const proposal = ownGitChangeProposal(input);
  if (!verifyGitChangeProposal(proposal)) {
    throw new Error("Git change proposal failed its integrity check");
  }
  const common = {
    repositoryId: proposal.repositoryId,
    patchDigest: proposal.patchDigest,
    allowedPaths: proposal.allowedPaths,
    expiresAt: proposal.expiresAt,
  };
  return proposal.proposalVersion === 1
    ? { intentVersion: 1, workspace: proposal.workspace, ...common }
    : { intentVersion: 2, workspace: proposal.workspace, ...common };
}

function assertPlanDigests(input: CreateGitChangeProposalInput): void {
  if (
    !DIGEST_PATTERN.test(input.actionId) ||
    !DIGEST_PATTERN.test(input.policyDigest)
  ) {
    throw new Error("Action and policy digests must be SHA-256 digests");
  }
}

function assertFutureExpiry(expiresAt: string, createdAt: string): void {
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error("Proposal expiry must be a future date-time");
  }
}

/** Bind a proposed patch to observed Git state; does not approve or execute it. */
export function createGitChangeProposal(
  input: CreateGitChangeProposalInput,
): GitChangeProposalV1 {
  assertPlanDigests(input);
  const intent = createGitChangeIntent(input);
  const createdAt = new Date().toISOString();
  assertFutureExpiry(intent.expiresAt, createdAt);
  const unsigned = {
    proposalVersion: 1 as const,
    repositoryId: intent.repositoryId,
    actionId: input.actionId,
    policyDigest: input.policyDigest,
    workspace: intent.workspace,
    patchDigest: intent.patchDigest,
    allowedPaths: intent.allowedPaths,
    createdAt,
    expiresAt: intent.expiresAt,
  };
  return { ...unsigned, proposalId: digestCanonical(unsigned) };
}

/** Bind a proposed patch to an unchecked-out destination; does not execute it. */
export function createGitChangeProposalV2(
  input: CreateGitChangeProposalInput,
): GitChangeProposalV2 {
  assertPlanDigests(input);
  const intent = createGitChangeIntentV2(input);
  const createdAt = new Date().toISOString();
  assertFutureExpiry(intent.expiresAt, createdAt);
  const unsigned = {
    proposalVersion: 2 as const,
    repositoryId: intent.repositoryId,
    actionId: input.actionId,
    policyDigest: input.policyDigest,
    workspace: intent.workspace,
    patchDigest: intent.patchDigest,
    allowedPaths: intent.allowedPaths,
    createdAt,
    expiresAt: intent.expiresAt,
  };
  return { ...unsigned, proposalId: digestCanonical(unsigned) };
}

/** Checks integrity only; authenticity and effect enforcement require later phases. */
export function verifyGitChangeProposal(proposal: GitChangeProposal): boolean {
  try {
    const { proposalId, ...unsigned } = proposal;
    return proposalId === digestCanonical(unsigned);
  } catch {
    return false;
  }
}

/** Read-only drift check; a later promotion gate must recheck atomically. */
export function matchesCurrentGitWorkspace(
  input: GitChangeProposal,
  repositoryPath: string,
  patch: Uint8Array,
): boolean {
  let proposal: GitChangeProposal;
  try {
    proposal = ownGitChangeProposal(input);
  } catch {
    return false;
  }
  if (
    !verifyGitChangeProposal(proposal) ||
    sha256(patch) !== proposal.patchDigest
  ) {
    return false;
  }
  try {
    return (
      digestCanonical(
        observeGitWorkspaceForProposal(proposal, repositoryPath),
      ) === digestCanonical(proposal.workspace)
    );
  } catch {
    return false;
  }
}
