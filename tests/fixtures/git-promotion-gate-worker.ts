import { readFileSync, readSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteExecutionStore } from "../../src/execution-store.js";
import {
  SqliteGitApprovalStore,
  type PromoteGitPromotionAttemptInput,
} from "../../src/git-approval-store.js";

interface WorkerInput {
  databasePath: string;
  plansPath: string;
  mode: "before-admission" | "after-admission";
  request: Omit<PromoteGitPromotionAttemptInput, "context"> & {
    context: Omit<PromoteGitPromotionAttemptInput["context"], "plans">;
  };
}
function signal(event: string): void {
  writeSync(1, JSON.stringify({ event }) + "\n");
}
function pause(): void {
  // Owned gate only: the parent kills this worker while it waits here.
  const byte = Buffer.alloc(1);
  if (readSync(0, byte, 0, 1, null) !== 1)
    throw new Error("Worker gate closed");
}
const input = JSON.parse(
  readFileSync(process.argv[2] ?? "", "utf8"),
) as WorkerInput;
const store = new SqliteGitApprovalStore(input.databasePath);
const plans = new SqliteExecutionStore(input.plansPath);
// Test-only instrumentation of this worker's native exec boundary, installed
// after both stores opened: stop just before the admission transaction, or
// just after its durable COMMIT and before any ref dispatch.
const originalExec = Reflect.get(DatabaseSync.prototype, "exec");
let commits = 0;
DatabaseSync.prototype.exec = function (sql: string): void {
  if (sql === "BEGIN IMMEDIATE" && input.mode === "before-admission") {
    signal("before-admission");
    pause();
  }
  originalExec.call(this, sql);
  if (sql === "COMMIT" && ++commits === 1 && input.mode === "after-admission") {
    signal("admitted");
    pause();
  }
};
try {
  store.promoteGitPromotionAttempt({
    ...input.request,
    context: { ...input.request.context, plans },
  });
  signal("returned");
} catch {
  signal("rejected");
  process.exitCode = 1;
} finally {
  store.close();
  plans.close();
}
