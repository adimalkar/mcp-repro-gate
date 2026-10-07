import { readFileSync, readSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteExecutionStore } from "../../src/execution-store.js";
import {
  SqliteGitApprovalStore,
  type ReserveGitPromotionFromPlanInput,
} from "../../src/git-approval-store.js";
import type { PlanStore } from "../../src/kernel.js";

interface WorkerInput {
  databasePath: string;
  plansPath: string;
  request: Omit<ReserveGitPromotionFromPlanInput, "context"> & {
    context: Omit<ReserveGitPromotionFromPlanInput["context"], "plans">;
  };
  clockAt?: string;
  mode:
    | "reserve"
    | "before-commit"
    | "after-commit"
    | "wait"
    | "wait-expiry"
    | "silent"
    | "exit-before-event"
    | "event-stall";
}
function signal(event: string): void {
  writeSync(1, JSON.stringify({ event }) + "\n");
}
function pause(): void {
  const byte = Buffer.alloc(1);
  if (readSync(0, byte, 0, 1, null) !== 1)
    throw new Error("Worker gate closed");
}
const input = JSON.parse(
  readFileSync(process.argv[2] ?? "", "utf8"),
) as WorkerInput;
// Compiled negative fixtures stop before opening either database. They accept
// no commands: stdin is only an owned pause gate that the parent closes/kills.
if (input.mode === "exit-before-event") process.exit(17);
if (input.mode === "silent" || input.mode === "event-stall") {
  if (input.mode === "event-stall") signal("ready");
  pause();
  process.exit(18);
}
const store = new SqliteGitApprovalStore(input.databasePath);
const persistedPlans = new SqliteExecutionStore(input.plansPath);
let calls = 0;
const plans: PlanStore = {
  save: (plan) => {
    persistedPlans.save(plan);
  },
  get: (actionId) => {
    calls++;
    if (
      calls === 2 &&
      (input.mode === "wait" || input.mode === "wait-expiry")
    ) {
      signal("prechecked");
      pause();
      signal("continuing");
    }
    if (calls === 3 && input.mode === "wait-expiry") {
      // Deterministic trusted worker clock at the exact admission boundary,
      // never a tiny real-time signed TTL. No production clock hook is exposed.
      const deadline = Date.parse(
        input.clockAt ?? input.request.proposal.expiresAt,
      );
      Date.now = () => deadline;
    }

    return persistedPlans.get(actionId);
  },
};
// Test-only instrumentation of the owned worker's native exec boundary, not a
// production hook: pause after INSERT but immediately before durable COMMIT.
const originalExec = Reflect.get(DatabaseSync.prototype, "exec");
DatabaseSync.prototype.exec = function (sql: string): void {
  if (
    sql === "BEGIN IMMEDIATE" &&
    (input.mode === "wait" || input.mode === "wait-expiry")
  )
    signal("beginning-t1");
  if (sql === "COMMIT" && input.mode === "before-commit") {
    signal("before-commit");
    pause();
  }
  originalExec.call(this, sql);
};
try {
  const record = store.reserveGitPromotionFromPlan({
    ...input.request,
    context: { ...input.request.context, plans },
  });
  writeSync(1, JSON.stringify({ event: "reserved", record }) + "\n");
  if (input.mode === "after-commit") pause();
} catch {
  // Bounded worker diagnostic, no raw patch/Git/SQLite values retained.
  signal("rejected");
  process.exitCode = 1;
} finally {
  store.close();
  persistedPlans.close();
}
