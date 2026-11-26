import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { runGit } from "./git-runner.js";

const KEEP_NAME = /^pack-[0-9a-f]{40}(?:[0-9a-f]{24})?\.keep$/u;

/**
 * Nothing refers to a candidate commit until promotion, so repacking could
 * delete it and spend the one-use approval. `index-pack --keep` writes this
 * text next to the candidate's pack before the pack itself is installed, and
 * Git never repacks or deletes a pack that has such a file.
 */
export function candidateKeepMessage(attemptId: string): string {
  return `reprogate promotion candidate ${attemptId}`;
}

/**
 * Let Git's normal garbage collection have the candidate again. Call only
 * once the attempt is resolved, or was never reserved. Removes only a keep
 * file holding exactly this attempt's text. Best effort: a leftover file
 * retains one small pack and must never change an attempt's result.
 */
export function releaseCandidateKeep(
  repositoryPath: string,
  attemptId: string,
): void {
  try {
    const commonDirectory = new TextDecoder("utf-8", { fatal: true })
      .decode(
        runGit([
          "-C",
          repositoryPath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      )
      .replace(/\n$/u, "");
    const directory = join(commonDirectory, "objects", "pack");
    const expected = Buffer.from(
      `${candidateKeepMessage(attemptId)}\n`,
      "ascii",
    );
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !KEEP_NAME.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        if (holdsExactly(path, expected)) unlinkSync(path);
      } catch {
        // Unreadable or already gone; other keep files are still checked.
      }
    }
  } catch {
    // The pack stays kept.
  }
}

function holdsExactly(path: string, expected: Buffer): boolean {
  // A pack entry can change between listing and opening. Check the descriptor
  // and avoid waiting on a special file on platforms that have O_NONBLOCK.
  const flags = constants as Partial<typeof constants>;
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0),
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size !== expected.length) return false;
    const actual = Buffer.alloc(expected.length);
    return (
      readSync(descriptor, actual, 0, actual.length, 0) === actual.length &&
      actual.equals(expected)
    );
  } finally {
    closeSync(descriptor);
  }
}
