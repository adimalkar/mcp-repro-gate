import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import type { TokenUseStore } from "./capability-token.js";
import { envelopeDigest, verifyActionEnvelope } from "./envelope.js";
import type { PlanStore, PlannedAction } from "./kernel.js";
import type { ExecutionReceiptV1 } from "./receipt.js";
import type { Digest } from "./types.js";

export type ExecutionState =
  "prepared" | "succeeded" | "failed" | "indeterminate";

export interface ExecutionRecord {
  executionId: string;
  actionId: Digest;
  envelopeDigest: Digest;
  capabilityId: string;
  state: ExecutionState;
  startedAt: string;
  completedAt?: string;
  receipt?: ExecutionReceiptV1;
}

interface ExecutionRow {
  execution_id: string;
  action_id: string;
  envelope_digest: string;
  capability_id: string;
  state: ExecutionState;
  started_at: string;
  completed_at: string | null;
  receipt_json: string | null;
}

export class SqliteExecutionStore implements PlanStore, TokenUseStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS plans (
        action_id TEXT PRIMARY KEY,
        envelope_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS token_uses (
        capability_id TEXT PRIMARY KEY,
        consumed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        envelope_digest TEXT NOT NULL,
        capability_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN ('prepared', 'succeeded', 'failed', 'indeterminate')
        ),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        receipt_json TEXT,
        FOREIGN KEY (action_id) REFERENCES plans(action_id),
        FOREIGN KEY (capability_id) REFERENCES token_uses(capability_id)
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  save(plan: PlannedAction): void {
    if (
      !verifyActionEnvelope(plan.envelope) ||
      envelopeDigest(plan.envelope) !== plan.envelopeDigest
    ) {
      throw new Error("Cannot persist an invalid action plan");
    }
    this.#database
      .prepare(
        `INSERT INTO plans (
          action_id, envelope_digest, plan_json, created_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        plan.envelope.actionId,
        plan.envelopeDigest,
        canonicalJson(plan),
        plan.envelope.plannedAt,
      );
  }

  get(actionId: string): PlannedAction | undefined {
    const row = this.#database
      .prepare("SELECT plan_json FROM plans WHERE action_id = ?")
      .get(actionId) as { plan_json: string } | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.plan_json) as PlannedAction);
  }

  consume(capabilityId: string): boolean {
    try {
      this.#database
        .prepare(
          "INSERT INTO token_uses (capability_id, consumed_at) VALUES (?, ?)",
        )
        .run(capabilityId, new Date().toISOString());
      return true;
    } catch (error) {
      if (this.#isConstraintError(error)) return false;
      throw error;
    }
  }

  beginExecution(input: {
    actionId: Digest;
    envelopeDigest: Digest;
    capabilityId: string;
    startedAt: string;
    executionId?: string;
  }): ExecutionRecord {
    if (!Number.isFinite(Date.parse(input.startedAt))) {
      throw new Error("Execution start time is invalid");
    }
    const executionId = input.executionId ?? randomUUID();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      try {
        this.#database
          .prepare(
            "INSERT INTO token_uses (capability_id, consumed_at) VALUES (?, ?)",
          )
          .run(input.capabilityId, input.startedAt);
      } catch (error) {
        if (this.#isConstraintError(error)) {
          throw new Error("Capability token has already been consumed", {
            cause: error,
          });
        }
        throw error;
      }
      const inserted = this.#database
        .prepare(
          `INSERT INTO executions (
            execution_id, action_id, envelope_digest, capability_id, state,
            started_at
          )
          SELECT ?, action_id, envelope_digest, ?, 'prepared', ?
          FROM plans
          WHERE action_id = ? AND envelope_digest = ?`,
        )
        .run(
          executionId,
          input.capabilityId,
          input.startedAt,
          input.actionId,
          input.envelopeDigest,
        );
      if (Number(inserted.changes) !== 1) {
        throw new Error("Action plan or envelope digest is not persisted");
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    return {
      executionId,
      actionId: input.actionId,
      envelopeDigest: input.envelopeDigest,
      capabilityId: input.capabilityId,
      state: "prepared",
      startedAt: input.startedAt,
    };
  }

  completeExecution(receipt: ExecutionReceiptV1): ExecutionRecord {
    const state = receipt.outcome;
    const changed = this.#database
      .prepare(
        `UPDATE executions
         SET state = ?, completed_at = ?, receipt_json = ?
         WHERE execution_id = ?
           AND action_id = ?
           AND envelope_digest = ?
           AND capability_id = ?
           AND state = 'prepared'`,
      )
      .run(
        state,
        receipt.completedAt,
        canonicalJson(receipt),
        receipt.executionId,
        receipt.actionId,
        receipt.envelopeDigest,
        receipt.capabilityId,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error("Execution is missing or is no longer prepared");
    }
    const record = this.getExecution(receipt.executionId);
    if (record === undefined)
      throw new Error("Completed execution disappeared");
    return record;
  }

  recoverIncomplete(completedAt = new Date().toISOString()): number {
    const changed = this.#database
      .prepare(
        `UPDATE executions
         SET state = 'indeterminate', completed_at = ?
         WHERE state = 'prepared'`,
      )
      .run(completedAt);
    return Number(changed.changes);
  }

  markIndeterminate(executionId: string, completedAt: string): void {
    const changed = this.#database
      .prepare(
        `UPDATE executions
         SET state = 'indeterminate', completed_at = ?
         WHERE execution_id = ? AND state = 'prepared'`,
      )
      .run(completedAt, executionId);
    if (Number(changed.changes) !== 1) {
      throw new Error("Execution is missing or is no longer prepared");
    }
  }

  getExecution(executionId: string): ExecutionRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM executions WHERE execution_id = ?")
      .get(executionId) as unknown as ExecutionRow | undefined;
    if (row === undefined) return undefined;
    return {
      executionId: row.execution_id,
      actionId: row.action_id as Digest,
      envelopeDigest: row.envelope_digest as Digest,
      capabilityId: row.capability_id,
      state: row.state,
      startedAt: row.started_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.receipt_json === null
        ? {}
        : { receipt: JSON.parse(row.receipt_json) as ExecutionReceiptV1 }),
    };
  }

  #isConstraintError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "errstr" in error &&
      error.errstr === "constraint failed"
    );
  }
}
