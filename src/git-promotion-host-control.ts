import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseGitWorktreeList } from "./git-change-contract.js";
import { readBoundedRegularFile } from "./git-review-config.js";
import { runGit } from "./git-runner.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u;
export const MAX_GIT_PROMOTION_FENCE_OWNER_BYTES = 16 * 1024;
const OWNER_FILE = "owner.json";
const SIDECARS = ["", "-wal", "-shm", "-journal"];

export interface GitPromotionHostControlConfig {
  repositoryPath: string;
  approvalDatabasePath: string;
  /** Existing private parent required. The latch itself is created by acquire. */
  fencePath: string;
  /** Private host plan/config/key/state files or directories; omit for no paths. */
  statePaths?: readonly string[];
}
export interface GitPromotionFenceOwnerV1 {
  readonly ownerVersion: 1;
  readonly token: string;
  readonly attemptId: string;
  readonly commonDirectory: string;
  readonly approvalDatabasePath: string;
  readonly fencePath: string;
  readonly createdAt: string;
}
export type GitPromotionFenceStatus =
  | { readonly status: "available" }
  | { readonly status: "held"; readonly owner: GitPromotionFenceOwnerV1 }
  | { readonly status: "held-invalid" };
export interface GitPromotionHostControl {
  query(): GitPromotionFenceStatus;
  /** attemptId is a fresh host-generated UUIDv4, shared with object preparation. */
  acquire(attemptId: string): GitPromotionFenceOwnerV1;
  release(owner: unknown, acknowledgement: { childrenQuiescent: true }): void;
}

function optionalFlag(name: string): number {
  return (constants as Partial<Record<string, number>>)[name] ?? 0;
}
function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function optionalStat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}
function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  // A read may change atime; it must not excuse any observed owner mutation.
  const stable = [
    "size",
    "mode",
    "nlink",
    "uid",
    "gid",
    "rdev",
    "mtimeNs",
    "ctimeNs",
    "birthtimeNs",
  ] as const;
  return sameIdentity(a, b) && stable.every((field) => a[field] === b[field]);
}
function pathString(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 4096 ||
    Buffer.from(value).toString("utf8") !== value
  )
    throw new Error(
      "Host fence locations require bounded absolute lossless paths",
    );
  return value;
}
function physicalPath(path: string): string {
  // String realpath replaces invalid physical UTF-8 with U+FFFD, which may
  // name a different existing file. Decode native bytes before any path use.
  // This module rejects unrepresentable paths; it does not support raw paths.
  const bytes = realpathSync.native(pathString(path), { encoding: "buffer" });
  if (bytes.length > 4096)
    throw new Error("Physical locations require bounded lossless UTF-8 paths");
  return pathString(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
}
class FenceLocationError extends Error {}
function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}
function within(child: string, parent: string): boolean {
  const tail = relative(fold(parent), fold(child));
  return (
    tail === "" ||
    (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
  );
}
function overlap(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}
function location(value: unknown): string {
  const path = pathString(value);
  const parent = physicalPath(dirname(path));
  if (
    !statSync(parent).isDirectory() ||
    basename(path) === "" ||
    resolve(path) === parent
  )
    throw new Error(
      "Fence/state location requires an existing parent and a leaf",
    );
  return pathString(join(parent, basename(path)));
}
function directory(path: string): string {
  const physical = physicalPath(path);
  if (!statSync(physical).isDirectory())
    throw new Error("Expected a physical directory");
  return physical;
}
function privateStats(stats: BigIntStats, kind: "file" | "directory"): void {
  if (
    !(kind === "file"
      ? stats.isFile() && stats.nlink === 1n
      : stats.isDirectory())
  )
    throw new Error(
      "Host locations require physical directories or regular single-link files",
    );
  if (process.platform !== "win32") {
    if (
      !process.getuid ||
      stats.uid !== BigInt(process.getuid()) ||
      (stats.mode & 0o7777n) !== (kind === "file" ? 0o600n : 0o700n)
    )
      throw new Error(
        "Host locations require private current-user POSIX ownership and permissions",
      );
  }
}
function safeAncestors(parent: string): void {
  if (process.platform === "win32") return; // Host-managed ACLs, not Unix mode emulation.
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Current-user POSIX ownership unavailable");
  for (let path = parent; ; path = dirname(path)) {
    const stats = lstatSync(path, { bigint: true });
    // Canonical ancestor directories must not be replaceable by other users.
    // Root-owned sticky temporary parents are allowed; the immediate parent
    // must still be current-user private and identity-pinned separately.
    const trustedOwner = stats.uid === 0n || stats.uid === BigInt(uid);
    const stickyRoot = stats.uid === 0n && (stats.mode & 0o1000n) !== 0n;
    if (
      !stats.isDirectory() ||
      !trustedOwner ||
      ((stats.mode & 0o022n) !== 0n && !stickyRoot)
    )
      throw new Error("Unsafe ownership or writable fence ancestor");
    if (dirname(path) === path) break;
  }
}
function safeState(path: string, directoryTarget = false): void {
  for (const suffix of SIDECARS) {
    const target = path + suffix;
    if (location(target) !== target)
      throw new Error("Ledger/state parent alias changed");
    const stats = optionalStat(target);
    // Directory support applies only to the captured base, never its sidecars.
    // lstat rejects even dangling symlinks; files may not alias any other inode.
    if (stats)
      privateStats(
        stats,
        suffix === "" && directoryTarget ? "directory" : "file",
      );
  }
}
function stateArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error("Host state paths require a plain bounded array");
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = descriptor?.value;
  if (
    !descriptor ||
    descriptor.enumerable ||
    !("value" in descriptor) ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 256
  )
    throw new Error("Host state paths require a bounded array");
  const keys = Reflect.ownKeys(value);
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  )
    throw new Error("Host state paths contain holes or unknown fields");
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !("value" in item))
      throw new Error(
        "Host state paths require dense enumerable data elements",
      );
    copy.push(item.value);
  }
  return copy;
}
function strictData(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Fence input must be a plain object");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Fence input must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("Fence input contains unknown fields");
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new Error(
        "Fence input accessors/nonenumerable fields are forbidden",
      );
    copy[key as string] = descriptor.value;
  }
  return copy;
}
const OWNER_FIELDS = [
  "ownerVersion",
  "token",
  "attemptId",
  "commonDirectory",
  "approvalDatabasePath",
  "fencePath",
  "createdAt",
] as const;
/** Detached strict bounded scalar record; accessors are rejected without invocation. */
export function parseGitPromotionFenceOwner(
  value: unknown,
): GitPromotionFenceOwnerV1 {
  const v = strictData(value, OWNER_FIELDS);
  if (
    v.ownerVersion !== 1 ||
    typeof v.token !== "string" ||
    !UUID.test(v.token) ||
    typeof v.attemptId !== "string" ||
    !UUID.test(v.attemptId) ||
    typeof v.createdAt !== "string" ||
    v.createdAt.length !== 24 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/u.test(
      v.createdAt,
    ) ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    new Date(v.createdAt).toISOString() !== v.createdAt
  )
    throw new Error(
      "Invalid fence owner version, UUIDs or canonical creation time",
    );
  const commonDirectory = pathString(v.commonDirectory);
  const approvalDatabasePath = pathString(v.approvalDatabasePath);
  const fencePath = pathString(v.fencePath);
  for (const path of [commonDirectory, approvalDatabasePath, fencePath])
    if (resolve(path) !== path)
      throw new Error("Fence owner paths must be canonical");
  const owned: GitPromotionFenceOwnerV1 = Object.freeze({
    ownerVersion: 1,
    token: v.token,
    attemptId: v.attemptId,
    commonDirectory,
    approvalDatabasePath,
    fencePath,
    createdAt: v.createdAt,
  });
  if (
    Buffer.byteLength(JSON.stringify(owned)) >
    MAX_GIT_PROMOTION_FENCE_OWNER_BYTES
  )
    throw new Error("Fence owner record exceeds its byte bound");
  return owned;
}
function gitPath(root: string, option: string): string {
  const raw = runGit(
    ["-C", root, "rev-parse", "--path-format=absolute", option],
    undefined,
    4097,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (
    !text.endsWith("\n") ||
    text.slice(0, -1).includes("\n") ||
    text.includes("\r")
  )
    throw new Error("Git metadata path is not a bounded single line");
  return directory(text.slice(0, -1));
}
function metadataRoots(root: string): string[] {
  const gitdir = gitPath(root, "--git-dir");
  const dotGit = physicalPath(join(root, ".git"));
  const entry = statSync(dotGit, { bigint: true });
  if (!entry.isDirectory()) {
    if (!entry.isFile() || entry.nlink !== 1n)
      throw new Error("Unsafe Git metadata pointer alias");
    // Git, not this module, interprets pointers. Bound the accepted pointer file
    // and decode fatally; protect its physical location as well as the gitdir.
    new TextDecoder("utf-8", { fatal: true }).decode(
      readBoundedRegularFile(dotGit, 4096, "Git metadata pointer"),
    );
  }
  const roots = [gitdir, dotGit];
  const commonPointer = join(gitdir, "commondir");
  if (optionalStat(commonPointer)) {
    const physicalPointer = physicalPath(commonPointer);
    readBoundedRegularFile(
      physicalPointer,
      4096,
      "Git common-directory pointer",
      {
        verify(stats) {
          if (stats.nlink !== 1n)
            throw new Error("Unsafe common-directory pointer alias");
        },
      },
    );
    roots.push(physicalPointer);
  }
  return roots;
}
/** Same Git-driven resolution for directory/file/symlink .git and commondir layouts. */
function repositoryRoots(root: string): {
  commonDirectory: string;
  roots: string[];
} {
  const top = gitPath(root, "--show-toplevel");
  if (
    !sameIdentity(
      statSync(root, { bigint: true }),
      statSync(top, { bigint: true }),
    )
  )
    throw new Error("Host repository path must be the Git worktree root");
  const commonDirectory = gitPath(root, "--git-common-dir");
  const roots = [root, commonDirectory, ...metadataRoots(root)];
  const worktrees = parseGitWorktreeList(
    runGit(
      ["-C", root, "worktree", "list", "--porcelain", "-z"],
      undefined,
      1024 * 1024,
    ),
  );
  for (const worktree of worktrees) {
    // Existing byte-preserving parser; reject unrepresentable paths rather than replace-decode.
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      worktree.path,
    );
    const registered = directory(path);
    roots.push(registered);
    const bare = runGit(
      ["-C", registered, "rev-parse", "--is-bare-repository"],
      undefined,
      6,
    );
    if (
      !bare.equals(Buffer.from("true\n")) &&
      !bare.equals(Buffer.from("false\n"))
    )
      throw new Error("Unexpected Git bare-repository marker");
    if (bare.equals(Buffer.from("false\n"))) {
      const common = gitPath(registered, "--git-common-dir");
      if (common !== commonDirectory)
        throw new Error("Registered worktree common-directory mismatch");
      roots.push(...metadataRoots(registered));
    }
  }
  return { commonDirectory, roots: [...new Set(roots)] };
}
function syncDirectory(path: string): void {
  // Node does not offer portable Windows directory fsync. Never silently swallow
  // POSIX fsync errors: acquisition/release becomes uncertain and throws.
  if (process.platform === "win32") return;
  const fd = openSync(
    path,
    constants.O_RDONLY |
      optionalFlag("O_DIRECTORY") |
      optionalFlag("O_NOFOLLOW"),
  );
  try {
    if (!fstatSync(fd).isDirectory())
      throw new Error("Expected directory for metadata flush");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function onlyOwnerEntry(path: string): boolean {
  const dir = opendirSync(path);
  try {
    return dir.readSync()?.name === OWNER_FILE && dir.readSync() === null;
  } finally {
    dir.closeSync();
  }
}

/**
 * Concrete HOST-ONLY cooperative persistent repository fence, not an MCP
 * capability, callback executor, OS sandbox, or distributed Git/SQLite commit.
 * Deployment MUST map one canonical common-directory/approval-ledger pair to
 * one fence, and make promotion/revocation/checkout/worktree/config/plan/key
 * writers cooperate. Noncooperating processes and same-user attackers are not
 * excluded. Host paths are captured once; callers cannot retarget release.
 *
 * POSIX requires current-user 0700 ledger/state/fence parents and directory
 * targets, and 0600 regular single-link files (including present sidecars).
 * Unsafe host inputs are rejected, never chmodded/repaired. Relevant physical
 * directory identities are pinned; missing file leaves do not create a DB.
 * Windows deployment MUST enforce equivalent private current-user ACLs on the
 * parents/ancestors, fence, ledger and state; Unix bits cannot verify those ACLs.
 *
 * Atomic mkdir survives worker death, including incomplete owner writes: every
 * existing invalid/empty latch remains held. There is NO PID/age stealing,
 * automatic repair, recursive deletion or force unlock. After mkdir any error
 * retains the latch, even if the local host believes no child was dispatched.
 * fsync owner + POSIX latch/parent metadata before returning; release flushes
 * unlink/rmdir metadata. These calls do NOT promise power-loss survival on all
 * filesystems/devices, nor directory-flush durability on Windows. Flush errors
 * are uncertain failures, not proof of an unlocked/reusable state.
 *
 * Release is allowed only after the trusted host explicitly acknowledges ALL
 * possible dispatched children/writers have completed or been stopped/reaped.
 * A boolean is a host contract, not inferred proof. Ambiguous dispatch MUST
 * retain the fence. Future trusted-host recovery must establish quiescence;
 * this module does not establish it or infer historical Git effects.
 */
export function createGitPromotionHostControl(
  input: GitPromotionHostControlConfig,
): GitPromotionHostControl {
  const config = strictData(input, [
    "repositoryPath",
    "approvalDatabasePath",
    "fencePath",
    "statePaths",
  ]);
  const root = directory(pathString(config.repositoryPath));
  const approvalDatabasePath = location(config.approvalDatabasePath);
  const fencePath = location(config.fencePath);
  const parent = dirname(fencePath);
  // exactOptionalPropertyTypes: absence is optional, explicit undefined/null
  // is not an array. Capture all elements once before resolving their paths.
  const statePaths = (
    Object.hasOwn(config, "statePaths") ? stateArray(config.statePaths) : []
  ).map(location);
  const stateDirectories = new Set(
    statePaths.filter((path) => optionalStat(path)?.isDirectory()),
  );
  const directoryIdentities = new Map<string, BigIntStats>();
  for (const path of new Set([
    parent,
    dirname(approvalDatabasePath),
    ...statePaths.map(dirname),
    ...stateDirectories,
  ])) {
    const identity = lstatSync(path, { bigint: true });
    privateStats(identity, "directory");
    directoryIdentities.set(path, identity);
  }
  const initial = repositoryRoots(root);
  const commonDirectory = initial.commonDirectory;
  const commonIdentity = statSync(commonDirectory, { bigint: true });
  // The same complete CURRENT location policy applies throughout every API,
  // not merely at construction/acquisition. No HEAD/cleanliness/proposal gate.
  function validateLocations(): void {
    for (const [path, identity] of directoryIdentities) {
      if (physicalPath(path) !== path)
        throw new Error("Host directory alias changed");
      safeAncestors(path);
      const stats = lstatSync(path, { bigint: true });
      privateStats(stats, "directory");
      if (!sameIdentity(stats, identity))
        throw new Error("Host directory identity changed");
    }
    safeState(approvalDatabasePath);
    for (const path of statePaths) safeState(path, stateDirectories.has(path));
    // Reobserve Git's CURRENT mapping, not just the old captured directory:
    // .git/commondir can redirect while that old directory still exists.
    // These metadata-only observations impose no HEAD or cleanliness gate.
    const current = repositoryRoots(root);
    if (
      current.commonDirectory !== commonDirectory ||
      !sameIdentity(
        commonIdentity,
        statSync(current.commonDirectory, { bigint: true }),
      )
    )
      throw new Error("Repository common-directory binding changed");
    const protectedPaths = [
      ...current.roots,
      ...statePaths.flatMap((path) => SIDECARS.map((suffix) => path + suffix)),
      ...SIDECARS.map((suffix) => approvalDatabasePath + suffix),
    ];
    if (protectedPaths.some((path) => overlap(fencePath, path)))
      throw new FenceLocationError(
        "Host fence must not overlap protected repository/ledger/state locations",
      );
    const stats = optionalStat(fencePath);
    if (stats && !stats.isDirectory())
      throw new FenceLocationError(
        "Host fence must be a physical directory, not an alias or file",
      );
  }
  validateLocations();
  function bound(owner: GitPromotionFenceOwnerV1): boolean {
    return (
      owner.commonDirectory === commonDirectory &&
      owner.approvalDatabasePath === approvalDatabasePath &&
      owner.fencePath === fencePath
    );
  }
  function inspect():
    | { owner: GitPromotionFenceOwnerV1; file: BigIntStats; dir: BigIntStats }
    | undefined {
    const dir = lstatSync(fencePath, { bigint: true });
    privateStats(dir, "directory");
    if (!onlyOwnerEntry(fencePath)) return undefined;
    const path = join(fencePath, OWNER_FILE);
    const file = lstatSync(path, { bigint: true });
    privateStats(file, "file");
    const bytes = readBoundedRegularFile(
      path,
      MAX_GIT_PROMOTION_FENCE_OWNER_BYTES,
      "Fence owner",
      {
        noFollow: true,
        verify(stats) {
          privateStats(stats, "file");
          if (!sameSnapshot(file, stats))
            throw new Error("Fence owner file changed");
        },
      },
    );
    const owner = parseGitPromotionFenceOwner(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!bound(owner) || !bytes.equals(Buffer.from(JSON.stringify(owner))))
      return undefined;
    const finalDir = lstatSync(fencePath, { bigint: true });
    const finalFile = lstatSync(path, { bigint: true });
    privateStats(finalDir, "directory");
    privateStats(finalFile, "file");
    if (!sameSnapshot(dir, finalDir) || !sameSnapshot(file, finalFile))
      return undefined;
    return { owner, file: finalFile, dir: finalDir };
  }
  function query(): GitPromotionFenceStatus {
    try {
      validateLocations();
    } catch (error) {
      // An existing latch is never reported held/available on separation
      // uncertainty, nor inspected as a valid owner in protected metadata.
      if (error instanceof FenceLocationError && optionalStat(fencePath))
        return Object.freeze({ status: "held-invalid" });
      throw error;
    }
    if (!optionalStat(fencePath)) {
      validateLocations();
      return Object.freeze({ status: "available" });
    }
    try {
      const current = inspect();
      validateLocations();
      return current
        ? Object.freeze({ status: "held", owner: current.owner })
        : Object.freeze({ status: "held-invalid" });
    } catch {
      return Object.freeze({ status: "held-invalid" });
    }
  }
  function acquire(attemptId: string): GitPromotionFenceOwnerV1 {
    if (typeof attemptId !== "string" || !UUID.test(attemptId))
      throw new Error("Fence attempt requires canonical lowercase UUIDv4");
    validateLocations();
    const owner = parseGitPromotionFenceOwner({
      ownerVersion: 1,
      token: randomUUID(),
      attemptId,
      commonDirectory,
      approvalDatabasePath,
      fencePath,
      createdAt: new Date().toISOString(),
    });
    try {
      mkdirSync(fencePath, { mode: 0o700 });
    } catch (error) {
      if (code(error) === "EEXIST")
        throw new Error("Repository ownership fence is held", { cause: error });
      throw new Error("Repository fence acquisition failed before ownership", {
        cause: error,
      });
    }
    // From this point NEVER remove/repair on error: a crash/partial write must stay held.
    try {
      validateLocations();
      privateStats(lstatSync(fencePath, { bigint: true }), "directory");
      syncDirectory(parent);
      validateLocations();
      const path = join(fencePath, OWNER_FILE);
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          optionalFlag("O_NOFOLLOW") |
          optionalFlag("O_NONBLOCK"),
        0o600,
      );
      try {
        privateStats(fstatSync(fd, { bigint: true }), "file");
        const bytes = Buffer.from(JSON.stringify(owner));
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written === 0) throw new Error("Incomplete owner write");
          offset += written;
        }
        fsyncSync(fd);
        privateStats(fstatSync(fd, { bigint: true }), "file");
      } finally {
        closeSync(fd);
      }
      validateLocations();
      syncDirectory(fencePath);
      validateLocations();
      const observed = inspect();
      if (!observed || JSON.stringify(observed.owner) !== JSON.stringify(owner))
        throw new Error("Fence owner verification failed");
      validateLocations();
      return owner;
    } catch (error) {
      throw new Error(
        "Fence acquisition uncertain; persistent latch retained",
        { cause: error },
      );
    }
  }
  function release(
    value: unknown,
    acknowledgement: { childrenQuiescent: true },
  ): void {
    const ack = strictData(acknowledgement, ["childrenQuiescent"]);
    if (ack.childrenQuiescent !== true)
      throw new Error(
        "Release requires explicit trusted-host child quiescence acknowledgement",
      );
    const owner = parseGitPromotionFenceOwner(value);
    if (!bound(owner))
      throw new Error("Fence release bindings do not match host configuration");
    validateLocations();
    const current = inspect();
    validateLocations();
    if (!current || JSON.stringify(current.owner) !== JSON.stringify(owner))
      throw new Error(
        "Fence release requires the exact persisted owner/token/attempt/bindings",
      );
    // Cooperating host protocol only; path operations cannot exclude same-user attackers.
    const final = inspect();
    if (
      !final ||
      !sameSnapshot(current.file, final.file) ||
      !sameSnapshot(current.dir, final.dir) ||
      JSON.stringify(final.owner) !== JSON.stringify(owner)
    )
      throw new Error("Fence changed before release");
    validateLocations();
    unlinkSync(join(fencePath, OWNER_FILE));
    validateLocations();
    syncDirectory(fencePath);
    // If observation drifts during the unlink/flush, retain the now-invalid
    // directory latch rather than completing an uncertain release.
    validateLocations();
    rmdirSync(fencePath);
    validateLocations();
    syncDirectory(parent);
    validateLocations();
  }
  return Object.freeze({ query, acquire, release });
}
