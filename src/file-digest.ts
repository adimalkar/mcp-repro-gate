import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { Digest } from "./types.js";

export async function sha256File(path: string): Promise<Digest> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error(`Artifact is not a regular file: ${path}`);
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}
