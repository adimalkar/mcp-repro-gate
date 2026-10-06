import { digestCanonical } from "./digest.js";
import { SqliteExecutionStore } from "./execution-store.js";
import {
  HandoffError,
  handoffStatusInputSchema,
  ownHandoffValue,
  parseHandoffConfig,
  parseHandoffUpdate,
  renderHandoffRecord,
  type HandoffConfigV1,
  type HandoffStatusV1,
} from "./handoff-contract.js";
import { HandoffFiles, prepareHandoffDatabase } from "./handoff-filesystem.js";

export interface HandoffService {
  readonly config: HandoffConfigV1;
  readonly store: SqliteExecutionStore;
  status(input: unknown): HandoffStatusV1;
  update(input: unknown): HandoffStatusV1;
  close(): void;
}
export interface HandoffServiceOptions {
  /** Execution store to share; it must be open on the configured database. */
  store?: SqliteExecutionStore;
  /** Clock for snapshot timestamps; tests inject a deterministic one. */
  now?: () => Date;
}
export function createHandoffService(
  value: unknown,
  options: HandoffServiceOptions = {},
): HandoffService {
  const sharedStore = options.store;
  const now = options.now ?? (() => new Date());
  const config = parseHandoffConfig(value);
  let store: SqliteExecutionStore | undefined;
  const ownsStore = sharedStore === undefined;
  try {
    const files = new HandoffFiles(config.workspaceRoot);
    files.assertDatabaseOutsideProjection(config.databasePath);
    const binding = prepareHandoffDatabase(config.databasePath);
    files.assertDatabaseOutsideProjection(binding.path);
    store = sharedStore ?? new SqliteExecutionStore(binding.path);
    store.initializeHandoff(binding);
    const contextStore = store;
    const instanceId = contextStore.handoffInstance();
    const workspaceId = digestCanonical({
      domain: "ReproGate/HandoffWorkspace/v1",
      workspaceRoot: files.workspaceRoot,
    });
    let closed = false;
    const status = (value: unknown): HandoffStatusV1 => {
      const input = handoffStatusInputSchema.safeParse(ownHandoffValue(value));
      if (!input.success) throw new HandoffError("invalid_input");
      if (closed) throw new HandoffError("unavailable");
      let latest: ReturnType<SqliteExecutionStore["latestHandoff"]>;
      let documentDigest: string | null = null;
      let state: HandoffStatusV1["state"];
      try {
        binding.verify();
        latest = contextStore.latestHandoff(workspaceId);
        documentDigest = files.document().digest;
        if (latest === undefined) state = "missing";
        else if (documentDigest === latest.projectedDigest)
          state = latest.projected ? "synchronized" : "pending";
        else if (
          !latest.projected &&
          documentDigest === latest.record.expectedDocumentDigest
        )
          state = "pending";
        else state = "drifted";
      } catch {
        state = "unavailable";
        latest = undefined;
      }
      const record = latest?.record;
      return {
        handoffVersion: 1,
        state,
        revision: record?.revision ?? 0,
        updateId: record?.updateId ?? null,
        snapshotDigest: latest?.snapshotDigest ?? null,
        projectedDigest: latest?.projectedDigest ?? null,
        documentDigest,
        provenance: "caller_asserted",
        counts: {
          completed: record?.context.completed.length ?? 0,
          touchedFiles: record?.context.touchedFiles.length ?? 0,
          blockers: record?.context.blockers.length ?? 0,
          nextSteps: record?.context.nextSteps.length ?? 0,
          references: record?.references.length ?? 0,
        },
        ...(input.data.includeContext === true && record !== undefined
          ? { context: record.context, references: record.references }
          : {}),
      };
    };
    return {
      config,
      store: contextStore,
      status,
      update: (value: unknown) => {
        const input = parseHandoffUpdate(value);
        if (closed) throw new HandoffError("unavailable");
        if (!config.allowUpdates) throw new HandoffError("read_only");
        try {
          binding.verify();
          const record = contextStore.reserveHandoff(
            workspaceId,
            input,
            () => files.document().digest,
            now(),
          );
          contextStore.projectHandoff(workspaceId, record.updateId, (owned) => {
            binding.verify();
            files.project(
              instanceId,
              owned.revision,
              owned.updateId,
              owned.expectedDocumentDigest,
              renderHandoffRecord(owned),
            );
          });
          return status({ handoffVersion: 1 });
        } catch (error) {
          throw error instanceof HandoffError
            ? error
            : new HandoffError("unavailable");
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (ownsStore) contextStore.close();
      },
    };
  } catch (error) {
    if (ownsStore) store?.close();
    throw error instanceof HandoffError
      ? error
      : new HandoffError("unavailable");
  }
}
