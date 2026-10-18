import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import type { TokenUseStore } from "./capability-token.js";
import { digestCanonical, sha256 } from "./digest.js";
import {
  HandoffError,
  MAX_HANDOFF_BYTES,
  parseHandoffRecord,
  parseHandoffUpdate,
  renderHandoffRecord,
  type HandoffRecordV1,
} from "./handoff-contract.js";
import {
  canonicalHandoffPath,
  type HandoffDatabaseBinding,
} from "./handoff-filesystem.js";
import { envelopeDigest, verifyActionEnvelope } from "./envelope.js";
import type { PlanStore, PlannedAction } from "./kernel.js";
import { parseHeldApproval, type HeldApprovalV1 } from "./held-approval.js";
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

// SQLite names WAL/SHM sidecars after the spelling it opens; on Windows an
// alias spelling would get a separate namespace. Open absolute paths through
// their physical location, including a new leaf below a physical parent.
// A physical name that is not valid UTF-8 cannot be passed on losslessly;
// keep the caller's spelling rather than open a Unicode-replacement twin.
function losslessPath(bytes: Buffer, fallback: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fallback;
  }
}
function retryBusy(operation: () => void): void {
  const deadline = Date.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      operation();
      return;
    } catch (error) {
      const code =
        error instanceof Error && "errcode" in error ? error.errcode : 0;
      if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
      if (Date.now() > deadline) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
function physicalOpenPath(path: string): string {
  if (!isAbsolute(path)) return path;
  try {
    return losslessPath(
      realpathSync.native(path, { encoding: "buffer" }),
      path,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  try {
    lstatSync(path);
    return path;
  } catch {
    try {
      return join(
        losslessPath(
          realpathSync.native(dirname(path), { encoding: "buffer" }),
          dirname(path),
        ),
        basename(path),
      );
    } catch {
      return path;
    }
  }
}

export class SqliteExecutionStore implements PlanStore, TokenUseStore {
  readonly #database: DatabaseSync;
  readonly #openedPath: string;
  #handoffBinding: HandoffDatabaseBinding | undefined;

  constructor(path: string) {
    this.#openedPath = physicalOpenPath(path);
    this.#database = new DatabaseSync(this.#openedPath);
    // Wait out another process's lock (including WAL recovery) before the
    // first statement that touches the database file.
    this.#database.exec("PRAGMA busy_timeout = 5000");
    // A new database starts in rollback mode, where SQLite answers a
    // read-to-write upgrade race with SQLITE_BUSY at once instead of
    // invoking the busy handler. Switch to WAL and create the schema with
    // a bounded retry.
    retryBusy(() => {
      this.#database.exec("PRAGMA journal_mode = WAL");
    });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#writeSchema(`
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

      CREATE TABLE IF NOT EXISTS held_approvals (
        action_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        approval_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (action_id) REFERENCES plans(action_id)
      ) STRICT;
    `);
  }

  // Every schema statement is idempotent, so a deadlock-avoidance BUSY
  // from a concurrent first start is safe to retry as a whole.
  #writeSchema(sql: string, after?: () => void): void {
    retryBusy(() => {
      this.#database.exec(sql);
      after?.();
    });
  }

  /** Actual SQLite filename, used only for opt-in host binding. */
  get databasePath(): string {
    const row = this.#database
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main");
    if (row === undefined || typeof row.file !== "string")
      throw new HandoffError("unavailable");
    return row.file;
  }

  initializeHandoff(binding: HandoffDatabaseBinding): void {
    binding.verify();
    if (
      this.#openedPath !== binding.path ||
      canonicalHandoffPath(this.databasePath) !== binding.path
    )
      throw new HandoffError("unavailable");
    if (this.#handoffBinding !== undefined) {
      if (this.#handoffBinding.path !== binding.path)
        throw new HandoffError("unavailable");
      this.#handoffBinding.verify();
      return;
    }
    this.#database.function(
      "reprogate_handoff_digest",
      { deterministic: true },
      (value) => {
        if (
          typeof value !== "string" ||
          Buffer.byteLength(value) > MAX_HANDOFF_BYTES
        )
          return null;
        try {
          return digestCanonical({
            domain: "ReproGate/Handoff/v1",
            record: parseHandoffRecord(JSON.parse(value)),
          });
        } catch {
          return null;
        }
      },
    );
    this.#writeSchema(
      `
      CREATE TABLE IF NOT EXISTS handoff_snapshots (
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0 AND revision < 9007199254740991),
        update_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        projected_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB)) <= 65536),
        PRIMARY KEY(workspace_id, revision),
        UNIQUE(workspace_id, update_id),
        CHECK(json_valid(snapshot_json)),
        CHECK(json_extract(snapshot_json, '$.handoffVersion') IS 1),
        CHECK(json_extract(snapshot_json, '$.workspaceId') IS workspace_id),
        CHECK(json_extract(snapshot_json, '$.revision') IS revision),
        CHECK(json_extract(snapshot_json, '$.updateId') IS update_id),
        CHECK(json_extract(snapshot_json, '$.requestDigest') IS request_digest),
        CHECK(snapshot_digest IS reprogate_handoff_digest(snapshot_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS handoff_projection_events (
        event_id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('projected', 'drifted', 'unavailable')),
        FOREIGN KEY(workspace_id, revision) REFERENCES handoff_snapshots(workspace_id, revision)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS handoff_snapshots_no_update BEFORE UPDATE ON handoff_snapshots
        BEGIN SELECT RAISE(ABORT, 'Immutable handoff snapshot'); END;
      CREATE TRIGGER IF NOT EXISTS handoff_snapshots_no_delete BEFORE DELETE ON handoff_snapshots
        BEGIN SELECT RAISE(ABORT, 'Immutable handoff snapshot'); END;
      CREATE TRIGGER IF NOT EXISTS handoff_events_no_update BEFORE UPDATE ON handoff_projection_events
        BEGIN SELECT RAISE(ABORT, 'Immutable handoff event'); END;
      CREATE TRIGGER IF NOT EXISTS handoff_events_no_delete BEFORE DELETE ON handoff_projection_events
        BEGIN SELECT RAISE(ABORT, 'Immutable handoff event'); END;
      CREATE TABLE IF NOT EXISTS handoff_instance (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        instance_id TEXT NOT NULL CHECK(instance_id GLOB '[0-9a-f]*' AND length(instance_id) = 32)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS handoff_instance_no_update BEFORE UPDATE ON handoff_instance
        BEGIN SELECT RAISE(ABORT, 'Immutable handoff instance'); END;
      CREATE TRIGGER IF NOT EXISTS handoff_instance_no_delete BEFORE DELETE ON handoff_instance
        BEGIN SELECT RAISE(ABORT, 'Immutable handoff instance'); END;
    `,
      () => {
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO handoff_instance(singleton, instance_id) VALUES(1, ?)",
          )
          .run(randomUUID().replaceAll("-", ""));
      },
    );
    binding.verify();
    this.#handoffBinding = binding;
  }

  /** Random per-database identifier; it scopes history pruning. */
  handoffInstance(): string {
    this.#verifyHandoff();
    const row = this.#database
      .prepare("SELECT instance_id FROM handoff_instance WHERE singleton = 1")
      .get();
    if (
      typeof row?.instance_id !== "string" ||
      !/^[0-9a-f]{32}$/u.test(row.instance_id)
    )
      throw new HandoffError("unavailable");
    return row.instance_id;
  }

  #verifyHandoff(): void {
    if (this.#handoffBinding === undefined)
      throw new HandoffError("unavailable");
    this.#handoffBinding.verify();
    if (
      this.#openedPath !== this.#handoffBinding.path ||
      canonicalHandoffPath(this.databasePath) !== this.#handoffBinding.path
    )
      throw new HandoffError("unavailable");
  }

  #handoffRow(
    workspaceId: string,
    updateId?: string,
  ):
    | {
        record: HandoffRecordV1;
        snapshotDigest: string;
        projectedDigest: string;
        projected: boolean;
      }
    | undefined {
    const row = this.#database
      .prepare(
        `SELECT revision, update_id, snapshot_digest, projected_digest,
      CASE WHEN length(CAST(snapshot_json AS BLOB)) <= 65536 THEN snapshot_json ELSE NULL END AS snapshot_json,
      EXISTS(SELECT 1 FROM handoff_projection_events e WHERE e.workspace_id = s.workspace_id AND e.revision = s.revision AND e.state = 'projected') AS projected
      FROM handoff_snapshots s WHERE workspace_id = ? ${updateId === undefined ? "ORDER BY revision DESC LIMIT 1" : "AND update_id = ?"}`,
      )
      .get(
        ...(updateId === undefined ? [workspaceId] : [workspaceId, updateId]),
      );
    if (row === undefined) return undefined;
    if (
      typeof row.snapshot_json !== "string" ||
      typeof row.snapshot_digest !== "string" ||
      typeof row.projected_digest !== "string"
    )
      throw new HandoffError("unavailable");
    const record = parseHandoffRecord(JSON.parse(row.snapshot_json));
    if (
      record.workspaceId !== workspaceId ||
      record.revision !== row.revision ||
      record.updateId !== row.update_id ||
      canonicalJson(record) !== row.snapshot_json ||
      digestCanonical({ domain: "ReproGate/Handoff/v1", record }) !==
        row.snapshot_digest ||
      sha256(renderHandoffRecord(record)) !== row.projected_digest
    )
      throw new HandoffError("unavailable");
    return {
      record,
      snapshotDigest: row.snapshot_digest,
      projectedDigest: row.projected_digest,
      projected: row.projected === 1,
    };
  }

  // Reference only a plan whose persisted envelope still verifies; a column
  // digest alone could be rewritten without the envelope it names.
  #verifiedPlanDigest(actionId: string): string {
    const row = this.#database
      .prepare(
        "SELECT envelope_digest, plan_json FROM plans WHERE action_id = ?",
      )
      .get(actionId);
    if (
      typeof row?.envelope_digest !== "string" ||
      typeof row.plan_json !== "string"
    )
      throw new HandoffError("unknown_plan");
    let verified: boolean;
    try {
      const plan = JSON.parse(row.plan_json) as PlannedAction;
      verified =
        canonicalJson(plan) === row.plan_json &&
        plan.envelope.actionId === actionId &&
        plan.envelopeDigest === row.envelope_digest &&
        verifyActionEnvelope(plan.envelope) &&
        envelopeDigest(plan.envelope) === row.envelope_digest;
    } catch {
      verified = false;
    }
    if (!verified) throw new HandoffError("unknown_plan");
    return row.envelope_digest;
  }

  latestHandoff(workspaceId: string):
    | {
        record: HandoffRecordV1;
        snapshotDigest: string;
        projectedDigest: string;
        projected: boolean;
      }
    | undefined {
    this.#verifyHandoff();
    return this.#handoffRow(workspaceId);
  }

  reserveHandoff(
    workspaceId: string,
    value: unknown,
    observeDocument: () => string | null,
    now: Date = new Date(),
  ): HandoffRecordV1 {
    const input = parseHandoffUpdate(value);
    this.#verifyHandoff();
    const requestDigest = digestCanonical({
      domain: "ReproGate/HandoffRequest/v1",
      request: input,
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#verifyHandoff();
      const previous = this.#handoffRow(workspaceId);
      const retry = this.#handoffRow(workspaceId, input.updateId);
      if (retry !== undefined) {
        if (retry.record.requestDigest !== requestDigest)
          throw new HandoffError("update_conflict");
        if (previous?.record.updateId !== input.updateId)
          throw new HandoffError("revision_conflict");
        for (const reference of retry.record.references)
          if (
            this.#verifiedPlanDigest(reference.actionId) !==
            reference.envelopeDigest
          )
            throw new HandoffError("unknown_plan");
        this.#database.exec("COMMIT");
        return retry.record;
      }
      if ((previous?.record.revision ?? 0) !== input.expectedRevision)
        throw new HandoffError("revision_conflict");
      // Observe the document under the writer lock, so a cooperating
      // projection cannot change it between observation and reservation.
      if (observeDocument() !== input.expectedDocumentDigest)
        throw new HandoffError("document_conflict");
      const references = input.actionIds.map((actionId) => {
        const planDigest = this.#verifiedPlanDigest(actionId);
        const executionCounts = {
          prepared: 0,
          succeeded: 0,
          failed: 0,
          indeterminate: 0,
        };
        for (const row of this.#database
          .prepare(
            "SELECT state, count(*) AS count FROM executions WHERE action_id = ? GROUP BY state",
          )
          .all(actionId)) {
          if (
            typeof row.state !== "string" ||
            !(row.state in executionCounts) ||
            typeof row.count !== "number" ||
            !Number.isSafeInteger(row.count)
          )
            throw new HandoffError("unavailable");
          executionCounts[row.state as keyof typeof executionCounts] =
            row.count;
        }
        return { actionId, envelopeDigest: planDigest, executionCounts };
      });
      const record = parseHandoffRecord({
        handoffVersion: 1,
        workspaceId,
        revision: input.expectedRevision + 1,
        updateId: input.updateId,
        createdAt: now.toISOString(),
        provenance: "caller_asserted",
        expectedDocumentDigest: input.expectedDocumentDigest,
        requestDigest,
        context: input.context,
        references,
      });
      this.#database
        .prepare(
          `INSERT INTO handoff_snapshots(workspace_id, revision, update_id, request_digest, snapshot_digest, projected_digest, snapshot_json) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          record.revision,
          record.updateId,
          requestDigest,
          digestCanonical({ domain: "ReproGate/Handoff/v1", record }),
          sha256(renderHandoffRecord(record)),
          canonicalJson(record),
        );
      this.#verifyHandoff();
      this.#database.exec("COMMIT");
      return record;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  // SQLite may already have rolled back (for example after SQLITE_FULL);
  // never let that replace the original error.
  #rollback(): void {
    try {
      this.#database.exec("ROLLBACK");
    } catch {
      // No transaction remained to roll back.
    }
  }

  projectHandoff(
    workspaceId: string,
    updateId: string,
    project: (record: HandoffRecordV1) => void,
  ): void {
    this.#verifyHandoff();
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      this.#verifyHandoff();
      const current = this.#handoffRow(workspaceId);
      if (current?.record.updateId !== updateId)
        throw new HandoffError("revision_conflict");
      let failure: HandoffError | undefined;
      try {
        project(current.record);
        this.#verifyHandoff();
      } catch (error) {
        failure =
          error instanceof HandoffError && error.code === "drifted"
            ? error
            : new HandoffError("unavailable");
      }
      this.#database
        .prepare(
          "INSERT INTO handoff_projection_events(workspace_id, revision, state) VALUES(?, ?, ?)",
        )
        .run(
          workspaceId,
          current.record.revision,
          failure?.code ?? "projected",
        );
      this.#database.exec("COMMIT");
      committed = true;
      if (failure !== undefined) throw failure;
    } catch (error) {
      if (!committed) this.#rollback();
      throw error;
    }
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

  /** Record a signed host-side approval; one per action. */
  holdApproval(record: HeldApprovalV1): void {
    try {
      this.#database
        .prepare(
          "INSERT INTO held_approvals (action_id, approval_id, approval_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          record.actionId,
          record.approvalId,
          canonicalJson(record),
          record.issuedAt,
        );
    } catch (error) {
      if (this.#isConstraintError(error))
        throw new Error("This action already has a held approval", {
          cause: error,
        });
      throw error;
    }
  }

  /**
   * The stored held approval, parsed but not yet verified. The row's ID
   * column must agree with the signed record, whose ID is authoritative.
   */
  getHeldApproval(actionId: string): HeldApprovalV1 | undefined {
    const row = this.#database
      .prepare(
        "SELECT approval_id, approval_json FROM held_approvals WHERE action_id = ?",
      )
      .get(actionId) as
      { approval_id: string; approval_json: string } | undefined;
    if (row === undefined) return undefined;
    const record = parseHeldApproval(row.approval_json);
    if (record.approvalId !== row.approval_id)
      throw new Error("Held approval row does not match its record");
    return record;
  }

  /**
   * Revoke an unused held approval by consuming its single-use capability
   * ID as a tombstone, then removing the row, in one transaction. A run that
   * already verified the approval then fails at its own atomic consume, and
   * re-inserting the row cannot revive it. Returns "revoked", "consumed" or
   * "missing".
   */
  revokeHeldApproval(actionId: string): "revoked" | "consumed" | "missing" {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const record = this.getHeldApproval(actionId);
      let outcome: "revoked" | "consumed" | "missing" = "missing";
      if (record !== undefined) {
        outcome = this.consume(`host-held:${record.approvalId}`)
          ? "revoked"
          : "consumed";
        if (outcome === "revoked")
          this.#database
            .prepare("DELETE FROM held_approvals WHERE action_id = ?")
            .run(actionId);
      }
      this.#database.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /** Consumed capabilities whose ID starts with this non-empty prefix. */
  countCapabilityUses(prefix: string): number {
    // A key range keeps the lookup on the primary-key index.
    const upper =
      prefix.slice(0, -1) +
      String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const row = this.#database
      .prepare(
        "SELECT count(*) AS n FROM token_uses WHERE capability_id >= ? AND capability_id < ?",
      )
      .get(prefix, upper);
    return Number(row?.n ?? 0);
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
