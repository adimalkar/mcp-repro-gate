import { closeSync, constants, openSync } from "node:fs";

/**
 * Create a missing on-disk SQLite database file readable by its owner only
 * (0600). SQLite gives its -wal and -shm sidecars the database file's mode,
 * so they stay private too. An existing file is never changed, and any
 * failure is left for SQLite itself to report when it opens the path.
 * Windows ignores the mode; deployments there rely on ACLs.
 */
export function createPrivateDatabaseFile(path: string): void {
  if (path === "" || path === ":memory:" || path.startsWith("file:")) return;
  try {
    closeSync(
      openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          ((constants as Partial<Record<string, number>>).O_NOFOLLOW ?? 0),
        0o600,
      ),
    );
  } catch {
    // Exists already, or SQLite will report the problem with the path.
  }
}
