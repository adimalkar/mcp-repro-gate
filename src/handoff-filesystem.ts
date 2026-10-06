import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./digest.js";
import {
  HandoffError,
  MAX_HANDOFF_BYTES,
  MAX_HANDOFF_DOCUMENT_BYTES,
  parseHandoffConfig,
  type HandoffConfigV1,
} from "./handoff-contract.js";

const optionalFlag = (key: "O_NOFOLLOW" | "O_NONBLOCK") =>
  (constants as Partial<Record<string, number>>)[key] ?? 0;
const readFlags =
  constants.O_RDONLY | optionalFlag("O_NOFOLLOW") | optionalFlag("O_NONBLOCK");
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function canonicalHandoffPath(path: string): string {
  if (
    !isAbsolute(path) ||
    path.length > 4096 ||
    /[\0\r\n]/u.test(path) ||
    Buffer.from(path).toString("utf8") !== path
  )
    throw new HandoffError("unavailable");
  const bytes = realpathSync.native(Buffer.from(path), { encoding: "buffer" });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!Buffer.from(text).equals(bytes)) throw new HandoffError("unavailable");
  return text;
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function stableFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function privateStats(stats: BigIntStats, directory: boolean): void {
  if (directory ? !stats.isDirectory() : !stats.isFile() || stats.nlink !== 1n)
    throw new HandoffError("unavailable");
  if (
    process.platform !== "win32" &&
    ((stats.mode & 0o077n) !== 0n ||
      (process.getuid !== undefined && stats.uid !== BigInt(process.getuid())))
  )
    throw new HandoffError("unavailable");
}
interface DirectoryBinding {
  path: string;
  stats: BigIntStats;
}
function directory(path: string, privateMode: boolean): DirectoryBinding {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory()) throw new HandoffError("unavailable");
  if (privateMode) privateStats(stats, true);
  else if (process.platform !== "win32" && (stats.mode & 0o022n) !== 0n)
    throw new HandoffError("unavailable");
  const physical = canonicalHandoffPath(path);
  if (!sameIdentity(stats, lstatSync(physical, { bigint: true })))
    throw new HandoffError("unavailable");
  return { path: physical, stats };
}
function verifyDirectory(
  binding: DirectoryBinding,
  privateMode: boolean,
): void {
  const current = directory(binding.path, privateMode);
  if (
    current.path !== binding.path ||
    !sameIdentity(current.stats, binding.stats) ||
    current.stats.mode !== binding.stats.mode ||
    current.stats.uid !== binding.stats.uid ||
    current.stats.gid !== binding.stats.gid
  )
    throw new HandoffError("unavailable");
}
export function readPrivateHandoffFile(path: string, cap: number): Buffer {
  const before = lstatSync(path, { bigint: true });
  privateStats(before, false);
  const fd = openSync(path, readFlags);
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(Math.min(cap + 1, 32768));
  let total = 0;
  try {
    const opened = fstatSync(fd, { bigint: true });
    privateStats(opened, false);
    if (!stableFile(before, opened) || opened.size > BigInt(cap))
      throw new HandoffError("unavailable");
    for (;;) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, cap + 1 - total),
        null,
      );
      if (count === 0) break;
      total += count;
      if (total > cap) throw new HandoffError("unavailable");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(fd, { bigint: true });
    privateStats(after, false);
    if (!stableFile(opened, after) || after.size !== BigInt(total))
      throw new HandoffError("unavailable");
  } finally {
    closeSync(fd);
    chunk.fill(0);
  }
  const final = lstatSync(path, { bigint: true });
  privateStats(final, false);
  if (!stableFile(before, final)) throw new HandoffError("unavailable");
  return Buffer.concat(chunks, total);
}
function verifyPrivateFile(path: string): BigIntStats {
  const before = lstatSync(path, { bigint: true });
  privateStats(before, false);
  const fd = openSync(path, readFlags);
  try {
    const stats = fstatSync(fd, { bigint: true });
    privateStats(stats, false);
    if (!sameIdentity(before, stats)) throw new HandoffError("unavailable");
  } finally {
    closeSync(fd);
  }
  const after = lstatSync(path, { bigint: true });
  privateStats(after, false);
  if (!sameIdentity(before, after)) throw new HandoffError("unavailable");
  return after;
}
export interface HandoffDatabaseBinding {
  path: string;
  verify(): void;
}
/** Host opt-in only: create0600 before SQLite, resolve existing filename before WAL. */
export function prepareHandoffDatabase(path: string): HandoffDatabaseBinding {
  if (
    !isAbsolute(path) ||
    basename(path) === "" ||
    basename(path) === "." ||
    basename(path) === ".." ||
    /[\0\r\n]/u.test(path) ||
    Buffer.from(path).toString("utf8") !== path
  )
    throw new HandoffError("unavailable");
  const parent = directory(dirname(path), true);
  const candidate = join(parent.path, basename(path));
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      verifyPrivateFile(candidate + suffix);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  let canonical: string;
  try {
    verifyPrivateFile(candidate);
    canonical = canonicalHandoffPath(candidate);
  } catch (error) {
    if (!missing(error)) throw error;
    verifyDirectory(parent, true);
    const fd = openSync(
      candidate,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        optionalFlag("O_NOFOLLOW"),
      0o600,
    );
    try {
      privateStats(fstatSync(fd, { bigint: true }), false);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    canonical = canonicalHandoffPath(candidate);
  }
  const identity = verifyPrivateFile(canonical);
  const verify = () => {
    verifyDirectory(parent, true);
    if (
      canonicalHandoffPath(canonical) !== canonical ||
      !sameIdentity(identity, verifyPrivateFile(canonical))
    )
      throw new HandoffError("unavailable");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        verifyPrivateFile(canonical + suffix);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  };
  verify();
  return { path: canonical, verify };
}
// Physical location of a database path whose leaf may not exist yet.
function physicalDatabaseLocation(path: string): string | undefined {
  try {
    return canonicalHandoffPath(path);
  } catch {
    try {
      return join(canonicalHandoffPath(dirname(path)), basename(path));
    } catch {
      return undefined;
    }
  }
}
/** Whether two configured database paths name the same physical file. */
export function sameHandoffDatabase(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false;
  const a = physicalDatabaseLocation(left);
  return a !== undefined && a === physicalDatabaseLocation(right);
}
export const MAX_HANDOFF_HISTORY = 32;
const HISTORY_NAME =
  /^[0-9]{16}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.md$/u;
// Make a completed rename durable; Windows cannot open directories for sync.
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function loadHandoffConfig(path: string): HandoffConfigV1 {
  try {
    const bytes = readPrivateHandoffFile(path, MAX_HANDOFF_BYTES);
    canonicalHandoffPath(path);
    return parseHandoffConfig(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new HandoffError("invalid_input");
  }
}
export interface HandoffDocument {
  digest: string | null;
  bytes: Buffer | null;
}
export class HandoffFiles {
  readonly #workspace: DirectoryBinding;
  readonly #agentPath: string;
  readonly #documentPath: string;
  #agent: DirectoryBinding | undefined;
  #history: DirectoryBinding | undefined;
  readonly workspaceRoot: string;
  constructor(workspaceRoot: string) {
    this.#workspace = directory(workspaceRoot, false);
    this.workspaceRoot = this.#workspace.path;
    this.#agentPath = join(this.workspaceRoot, ".agent");
    this.#documentPath = join(this.#agentPath, "handoff.md");
    try {
      this.#agent = directory(this.#agentPath, true);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  assertDatabaseOutsideProjection(path: string): void {
    // Keep the database out of .agent entirely. macOS and Windows volumes
    // are usually case-insensitive, so HANDOFF.md would alias handoff.md.
    const fold = (value: string) =>
      process.platform === "darwin" || process.platform === "win32"
        ? value.toLowerCase()
        : value;
    const relation = relative(fold(this.#agentPath), fold(path));
    if (
      relation === "" ||
      (!relation.startsWith(`..${sep}`) &&
        relation !== ".." &&
        !isAbsolute(relation)) ||
      basename(path).startsWith(".handoff-")
    )
      throw new HandoffError("unavailable");
  }
  #verify(): void {
    verifyDirectory(this.#workspace, false);
    if (this.#agent !== undefined) verifyDirectory(this.#agent, true);
    else {
      try {
        this.#agent = directory(this.#agentPath, true);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (this.#history !== undefined) verifyDirectory(this.#history, true);
  }
  document(): HandoffDocument {
    this.#verify();
    if (this.#agent === undefined) return { digest: null, bytes: null };
    let bytes: Buffer;
    try {
      bytes = readPrivateHandoffFile(
        this.#documentPath,
        MAX_HANDOFF_DOCUMENT_BYTES,
      );
    } catch (error) {
      if (missing(error)) return { digest: null, bytes: null };
      throw error;
    }
    this.#verify();
    return { digest: sha256(bytes), bytes };
  }
  project(
    revision: number,
    updateId: string,
    expectedDigest: string | null,
    bytes: Buffer,
  ): void {
    if (bytes.length > MAX_HANDOFF_DOCUMENT_BYTES)
      throw new HandoffError("unavailable");
    this.#verify();
    if (this.#agent === undefined) {
      mkdirSync(this.#agentPath, { mode: 0o700 });
      this.#agent = directory(this.#agentPath, true);
    }
    const base = this.document();
    if (base.digest === sha256(bytes)) return;
    if (base.digest !== expectedDigest) throw new HandoffError("drifted");
    if (base.bytes !== null) {
      const historyPath = join(this.#agentPath, "handoff-history");
      if (this.#history === undefined) {
        try {
          mkdirSync(historyPath, { mode: 0o700 });
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
        }
        this.#history = directory(historyPath, true);
      }
      this.#verify();
      const archive = join(
        historyPath,
        `${String(revision).padStart(16, "0")}-${updateId}-${(base.digest ?? "").slice(7)}.md`,
      );
      try {
        const archived = readPrivateHandoffFile(
          archive,
          MAX_HANDOFF_DOCUMENT_BYTES,
        );
        if (!archived.equals(base.bytes)) throw new HandoffError("unavailable");
      } catch (error) {
        if (!missing(error)) throw error;
        this.#writeExclusive(archive, base.bytes);
      }
    }
    this.#verify();
    const temporary = join(
      this.#agentPath,
      `.handoff-${updateId}-${randomUUID()}.tmp`,
    );
    const identity = this.#writeExclusive(temporary, bytes);
    let renamed = false;
    try {
      this.#verify();
      if (
        this.document().digest !== base.digest ||
        !sameIdentity(identity, verifyPrivateFile(temporary))
      )
        throw new HandoffError("drifted");
      renameSync(temporary, this.#documentPath);
      renamed = true;
      syncDirectory(this.#agentPath);
      this.#verify();
      if (this.document().digest !== sha256(bytes))
        throw new HandoffError("unavailable");
      this.#pruneHistory();
    } finally {
      if (!renamed) {
        this.#verify();
        const observed = verifyPrivateFile(temporary);
        if (sameIdentity(identity, observed)) unlinkSync(temporary);
      }
    }
  }
  // Keep the newest archives; delete only private single-link files with
  // our own name shape. Best effort: the projection already succeeded.
  #pruneHistory(): void {
    if (this.#history === undefined) return;
    try {
      const archives = readdirSync(this.#history.path)
        .filter((name) => HISTORY_NAME.test(name))
        .sort();
      for (const name of archives.slice(
        0,
        Math.max(0, archives.length - MAX_HANDOFF_HISTORY),
      )) {
        this.#verify();
        const path = join(this.#history.path, name);
        verifyPrivateFile(path);
        unlinkSync(path);
      }
    } catch {
      // Leave remaining archives in place; the next projection retries.
    }
  }
  #writeExclusive(path: string, bytes: Buffer): BigIntStats {
    this.#verify();
    const fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        optionalFlag("O_NOFOLLOW"),
      0o600,
    );
    try {
      return this.#finishExclusive(fd, path, bytes);
    } catch (error) {
      // Never leave a partial file that would block an identical retry.
      try {
        const created = fstatSync(fd, { bigint: true });
        const current = lstatSync(path, { bigint: true });
        if (sameIdentity(created, current)) unlinkSync(path);
      } catch {
        // The original failure is more informative than cleanup trouble.
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  #finishExclusive(fd: number, path: string, bytes: Buffer): BigIntStats {
    let stats: BigIntStats;
    {
      const before = fstatSync(fd, { bigint: true });
      privateStats(before, false);
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count <= 0) throw new HandoffError("unavailable");
        written += count;
      }
      fsyncSync(fd);
      stats = fstatSync(fd, { bigint: true });
      privateStats(stats, false);
      if (!sameIdentity(before, stats) || stats.size !== BigInt(bytes.length))
        throw new HandoffError("unavailable");
    }
    this.#verify();
    const current = verifyPrivateFile(path);
    if (
      !sameIdentity(stats, current) ||
      !readPrivateHandoffFile(path, MAX_HANDOFF_DOCUMENT_BYTES).equals(bytes)
    )
      throw new HandoffError("unavailable");
    return current;
  }
}
