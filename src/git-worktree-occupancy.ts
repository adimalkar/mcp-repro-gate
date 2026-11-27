import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  MAX_WORKTREES,
  parseGitWorktreeList,
  type GitWorktreeRecord,
} from "./git-change-contract.js";
import { readBoundedRegularFile } from "./git-review-config.js";
import { GitRunnerUnavailableError, runGit } from "./git-runner.js";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function stateLines(path: string, limit: number): string[] {
  if (!lstatSync(path).isFile())
    throw new Error("Git worktree operation state requires a regular file");
  const bytes = readBoundedRegularFile(
    path,
    limit,
    "Git worktree operation state",
    {
      noFollow: true,
    },
  );
  const text = utf8.decode(bytes);
  if (text.includes("\0"))
    throw new Error("Invalid Git worktree operation state");
  return text.replace(/\n$/u, "").split("\n");
}

function namesDestination(path: string, destinationRef: string): boolean {
  const lines = stateLines(path, 4096);
  const [name] = lines;
  if (lines.length !== 1 || !name) throw new Error("Invalid operation branch");
  return name === destinationRef || `refs/heads/${name}` === destinationRef;
}

function operationUsesBranch(admin: string, destinationRef: string): boolean {
  const bisect = join(admin, "BISECT_START");
  if (
    lstatSync(bisect, { throwIfNoEntry: false }) &&
    namesDestination(bisect, destinationRef)
  )
    return true;
  for (const backend of ["rebase-apply", "rebase-merge"]) {
    const dir = join(admin, backend);
    const stats = lstatSync(dir, { throwIfNoEntry: false });
    if (!stats) continue;
    if (!stats.isDirectory()) throw new Error("Invalid rebase directory");
    if (
      backend === "rebase-apply" &&
      lstatSync(join(dir, "applying"), { throwIfNoEntry: false })
    )
      continue; // git am
    if (namesDestination(join(dir, "head-name"), destinationRef)) return true;
    const updates = join(dir, "update-refs");
    if (!lstatSync(updates, { throwIfNoEntry: false })) continue;
    const lines = stateLines(updates, 1024 * 1024);
    if (lines.length === 1 && lines[0] === "") continue;
    if (lines.length % 3 !== 0)
      throw new Error("Incomplete rebase update-refs state");
    for (let i = 0; i < lines.length; i += 3) {
      const ref = lines[i];
      if (
        !ref?.startsWith("refs/") ||
        !objectId.test(lines[i + 1] ?? "") ||
        !objectId.test(lines[i + 2] ?? "")
      )
        throw new Error("Invalid rebase update-refs state");
      if (ref === destinationRef) return true;
    }
  }
  return false;
}

function readCommonDirectory(root: string): string {
  const raw = runGit(
    ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    undefined,
    4097,
  );
  if (raw.at(-1) !== 10) throw new Error("Unterminated Git common directory");
  return utf8.decode(raw.subarray(0, -1));
}

/** Include branches Git reserves for rebase, rebase --update-refs and bisect. */
export function gitDestinationInUse(
  root: string,
  destinationRef: string,
  observed?: { commonDir: string; worktrees: GitWorktreeRecord[] },
): boolean {
  try {
    const worktrees =
      observed?.worktrees ??
      parseGitWorktreeList(
        runGit(
          ["-C", root, "worktree", "list", "--porcelain", "-z"],
          undefined,
          1024 * 1024,
        ),
      );
    if (worktrees.some((worktree) => worktree.branch === destinationRef))
      return true;

    // Git stores each linked checkout's operation state in the shared
    // worktrees/<id> registry. It remains there even when the checkout is offline.
    const commonDir = observed?.commonDir ?? readCommonDirectory(root);
    if (!isAbsolute(commonDir) || /[\r\n]/u.test(commonDir))
      throw new Error("Invalid Git common directory");
    if (operationUsesBranch(commonDir, destinationRef)) return true;
    const registry = join(commonDir, "worktrees");
    const stats = lstatSync(registry, { throwIfNoEntry: false });
    if (!stats) return false;
    if (!stats.isDirectory()) throw new Error("Invalid Git worktree registry");
    const entries = readdirSync(registry, {
      encoding: "buffer",
      withFileTypes: true,
    });
    if (entries.length > MAX_WORKTREES)
      throw new Error("Too many Git worktree records");
    for (const entry of entries) {
      if (!entry.isDirectory()) throw new Error("Invalid Git worktree record");
      if (
        operationUsesBranch(
          join(registry, utf8.decode(entry.name)),
          destinationRef,
        )
      )
        return true;
    }
    return false;
  } catch (cause) {
    throw new GitRunnerUnavailableError(
      "Git worktree operation state could not be verified",
      { cause },
    );
  }
}
