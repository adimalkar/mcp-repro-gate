import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { fixture } from "./git-promotion-journal.js";

type Fixture = ReturnType<typeof fixture>;

/** Run one promotion in a child process that can stop at a durable boundary. */
export function startGateWorker(
  f: Fixture,
  mode:
    | "before-admission"
    | "after-admission"
    | "after-update-ref"
    | "after-outcome"
    | "run",
) {
  const path = join(f.scratch, `gate-worker-${randomUUID()}.json`);
  const context = {
    repositoryPath: f.context.repositoryPath,
    repositoryId: f.context.repositoryId,
    destinationRef: f.context.destinationRef,
    catalogTool: f.context.catalogTool,
    currentPolicy: f.context.currentPolicy,
  };
  writeFileSync(
    path,
    JSON.stringify({
      databasePath: f.databasePath,
      plansPath: join(f.scratch, "plans.sqlite"),
      mode,
      request: {
        attemptId: f.prepared.attemptId,
        context,
        trust: f.trust,
        hostControl: f.hostControl,
        owner: f.owner,
      },
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../fixtures/git-promotion-gate-worker.js", import.meta.url),
      ),
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  };
  // Reap before the fixture deletes its scratch directory.
  f.asyncClosers.push(kill);
  const waitFor = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const seen = () => output.includes(`{"event":"${event}"}`);
      if (seen()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`Gate worker did not emit ${event}`));
      }, 90_000);
      const onData = () => {
        if (seen()) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      void closed.then(() => {
        clearTimeout(timer);
        if (!seen()) reject(new Error(`Gate worker exited before ${event}`));
      });
    });
  const finished = closed.then(() => ({ output, errors }));
  return { waitFor, kill, finished };
}
