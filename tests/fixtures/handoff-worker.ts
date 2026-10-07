import { existsSync, readFileSync } from "node:fs";

import { createHandoffService } from "../../src/handoff.js";
import { HandoffError } from "../../src/handoff-contract.js";
import { HandoffFiles } from "../../src/handoff-filesystem.js";

// Usage: handoff-worker <update|crash-in-projection> <config.json> <update.json> [barrier]
const [mode, configPath, updatePath, barrier] = process.argv.slice(2);
if (configPath === undefined || updatePath === undefined)
  throw new Error("handoff worker arguments are missing");
const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
const update: unknown = JSON.parse(readFileSync(updatePath, "utf8"));
if (barrier !== undefined) {
  const deadline = Date.now() + 10_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) throw new Error("barrier never opened");
    Atomics.wait(pause, 0, 0, 2);
  }
}
// Created after the barrier, so racing workers also race first-time
// database creation and schema initialization.
const service = createHandoffService(config);
if (mode === "crash-in-projection") {
  // Die inside the projection transaction, after the snapshot committed.
  HandoffFiles.prototype.project = () => process.exit(86);
}
try {
  const status = service.update(update);
  process.stdout.write(`${JSON.stringify({ revision: status.revision })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ code: error instanceof HandoffError ? error.code : "thrown" })}\n`,
  );
} finally {
  service.close();
}
