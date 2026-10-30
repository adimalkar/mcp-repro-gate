import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  MAX_OBSERVED_PATHS,
  MAX_OBSERVED_SUBJECTS,
  printableText,
  type HandoffGitObservation,
} from "./handoff-session-contract.js";
import { runGit } from "./git-runner.js";

const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/u;

export function emptyGitObservation(
  state: "disabled" | "unavailable",
): HandoffGitObservation {
  return {
    state,
    branch: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    operation: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    paths: [],
    omittedPaths: 0,
    commitsSince: null,
  };
}

/** The current HEAD commit, or null when there is none or Git fails. */
export function observeHead(root: string): string | null {
  try {
    const head = runGit(["-C", root, "rev-parse", "--verify", "HEAD^{commit}"])
      .toString("ascii")
      .trim();
    return OID.test(head) ? head : null;
  } catch {
    return null;
  }
}

function decodePath(bytes: string): string {
  return printableText(Buffer.from(bytes, "latin1").toString("utf8"), 512);
}

/**
 * Read the workspace's Git state for a resuming agent: branch, upstream
 * divergence, an operation left in progress, and changed paths with no file
 * contents. Reads only, through the hardened runner without optional locks,
 * so it never takes the index lock from an agent working concurrently.
 */
export function observeGit(
  root: string,
  sinceHead: string | null,
): HandoffGitObservation {
  let status: Buffer;
  try {
    status = runGit(
      [
        "-C",
        root,
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ],
      undefined,
      MAX_STATUS_BYTES,
    );
  } catch {
    // Not a repository, Git missing or too old, a submodule workspace, an
    // unsupported configuration, or a time or output bound.
    return emptyGitObservation("unavailable");
  }
  const observation = emptyGitObservation("unavailable");
  observation.state = "observed";
  const fields = status.toString("latin1").split("\0");
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    if (field === "") continue;
    if (field.startsWith("# ")) {
      const [, key, ...rest] = field.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid" && OID.test(value)) observation.head = value;
      else if (key === "branch.head") {
        if (value === "(detached)") observation.detached = true;
        else observation.branch = decodePath(value);
      } else if (key === "branch.upstream")
        observation.upstream = decodePath(value);
      else if (key === "branch.ab") {
        const match = /^\+(\d{1,9}) -(\d{1,9})$/u.exec(value);
        if (match !== null) {
          observation.ahead = Number(match[1]);
          observation.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = field[0];
    let path: string | undefined;
    let code: string;
    if (type === "1" || type === "2") {
      const parts = field.split(" ");
      code = parts[1] ?? "..";
      path = parts.slice(type === "1" ? 8 : 9).join(" ");
      if (type === "2") index++; // The original path follows a rename.
      if (!code.startsWith(".")) observation.changes.staged++;
      if (code[1] !== ".") observation.changes.unstaged++;
    } else if (type === "u") {
      const parts = field.split(" ");
      code = parts[1] ?? "UU";
      path = parts.slice(10).join(" ");
      observation.changes.conflicted++;
    } else if (type === "?") {
      code = "??";
      path = field.slice(2);
      observation.changes.untracked++;
    } else continue;
    if (observation.paths.length < MAX_OBSERVED_PATHS)
      observation.paths.push({ status: code, path: decodePath(path) });
    else observation.omittedPaths++;
  }
  observation.operation = operationInProgress(root);
  if (
    sinceHead !== null &&
    OID.test(sinceHead) &&
    observation.head !== null &&
    sinceHead !== observation.head
  )
    observation.commitsSince = commitsSince(root, sinceHead);
  return observation;
}

function operationInProgress(root: string): HandoffGitObservation["operation"] {
  let gitDir: string;
  try {
    gitDir = runGit([
      "-C",
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ])
      .toString("utf8")
      .replace(/\n$/u, "");
  } catch {
    return null;
  }
  if (!isAbsolute(gitDir) || gitDir.includes("\n")) return null;
  const has = (name: string) => existsSync(join(gitDir, name));
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("MERGE_HEAD")) return "merge";
  if (has("CHERRY_PICK_HEAD")) return "cherry_pick";
  if (has("REVERT_HEAD")) return "revert";
  if (has("BISECT_LOG")) return "bisect";
  return null;
}

function commitsSince(
  root: string,
  base: string,
): HandoffGitObservation["commitsSince"] {
  try {
    const count = Number(
      runGit(
        ["-C", root, "rev-list", "--count", `${base}..HEAD`],
        undefined,
        64,
      )
        .toString("ascii")
        .trim(),
    );
    if (!Number.isSafeInteger(count) || count < 0) return null;
    const subjects = runGit(
      [
        "-C",
        root,
        "log",
        `--max-count=${String(MAX_OBSERVED_SUBJECTS)}`,
        "--format=%h %s%x00",
        `${base}..HEAD`,
      ],
      undefined,
      64 * 1024,
    )
      .toString("utf8")
      .split("\0")
      .map((line) => line.replace(/^\n/u, ""))
      .filter((line) => line !== "")
      .map((line) => printableText(line, 200));
    return { base, count, subjects };
  } catch {
    // The base may be gone after a rebase and garbage collection.
    return null;
  }
}
