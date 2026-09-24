import { lstatSync, realpathSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { digestCanonical } from "./digest.js";
import type { EffectObserver } from "./executor.js";
import { sha256File } from "./file-digest.js";
import type { ActionEnvelopeV1, Digest } from "./types.js";

interface ManifestEntry {
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  mode: number;
  size?: number;
  digest?: Digest;
}

export interface FilesystemManifestObserverOptions {
  roots: string[];
  maxEntries?: number;
  maxBytes?: number;
}

export class FilesystemManifestObserver implements EffectObserver {
  readonly #roots: ReadonlyMap<string, string>;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(options: FilesystemManifestObserverOptions) {
    if (options.roots.length === 0) {
      throw new Error("Filesystem observer must configure at least one root");
    }
    const roots = new Map<string, string>();
    for (const root of options.roots) {
      if (!isAbsolute(root)) {
        throw new Error(`Filesystem observer root must be absolute: ${root}`);
      }
      const configured = resolve(root);
      const metadata = lstatSync(configured);
      if (!metadata.isDirectory()) {
        throw new Error(`Filesystem observer root is not a directory: ${root}`);
      }
      roots.set(configured, realpathSync(configured));
    }
    if (roots.size !== options.roots.length) {
      throw new Error("Filesystem observer contains duplicate roots");
    }
    this.#roots = roots;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new Error("Filesystem observer maxEntries must be positive");
    }
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new Error("Filesystem observer maxBytes must be positive");
    }
  }

  async snapshot(envelope: ActionEnvelopeV1): Promise<unknown> {
    const requestedRoots = [...envelope.authority.filesystemRoots].sort();
    const manifests = [];
    for (const requestedRoot of requestedRoots) {
      const configuredRoot = resolve(requestedRoot);
      const canonicalRoot = this.#roots.get(configuredRoot);
      if (canonicalRoot === undefined) {
        throw new Error(
          `Action requested an unconfigured filesystem root: ${requestedRoot}`,
        );
      }
      manifests.push({
        root: configuredRoot,
        entries: await this.#manifest(canonicalRoot),
      });
    }
    return { observerVersion: 1, kind: "filesystem_manifest", manifests };
  }

  async #manifest(root: string): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    let observedBytes = 0;

    const visit = async (absolutePath: string): Promise<void> => {
      if (entries.length >= this.#maxEntries) {
        throw new Error("Filesystem observer entry limit exceeded");
      }
      const before = await lstat(absolutePath);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (before.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          kind: "symlink",
          mode: before.mode,
          digest: digestCanonical(await readlink(absolutePath)),
        });
        return;
      }
      if (before.isDirectory()) {
        entries.push({
          path: relativePath,
          kind: "directory",
          mode: before.mode,
        });
        const children = await readdir(absolutePath);
        children.sort();
        for (const child of children) {
          await visit(resolve(absolutePath, child));
        }
        return;
      }
      if (before.isFile()) {
        observedBytes += before.size;
        if (observedBytes > this.#maxBytes) {
          throw new Error("Filesystem observer byte limit exceeded");
        }
        const digest = await sha256File(absolutePath);
        const after = await lstat(absolutePath);
        if (
          !after.isFile() ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        ) {
          throw new Error(`File changed while being observed: ${absolutePath}`);
        }
        entries.push({
          path: relativePath,
          kind: "file",
          mode: before.mode,
          size: before.size,
          digest,
        });
        return;
      }
      entries.push({ path: relativePath, kind: "other", mode: before.mode });
    };

    await visit(root);
    return entries;
  }
}
