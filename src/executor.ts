import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { verifyCapabilityToken } from "./capability-token.js";
import { digestCanonical } from "./digest.js";
import type { DownstreamConnector } from "./downstream.js";
import { envelopeDigest, verifyActionEnvelope } from "./envelope.js";
import type { SqliteExecutionStore } from "./execution-store.js";
import { signExecutionReceipt, type ExecutionReceiptV1 } from "./receipt.js";
import type { ActionEnvelopeV1, Digest } from "./types.js";

export interface EffectObserver {
  snapshot(envelope: ActionEnvelopeV1): Promise<unknown>;
}

export interface ExecuteInput {
  actionId: string;
  arguments: Record<string, unknown>;
  capabilityToken: string;
  now?: Date;
}

export interface ExecuteResult {
  receipt: ExecutionReceiptV1;
  downstreamResult: unknown;
}

export class ExecutionIndeterminateError extends Error {
  constructor(
    readonly executionId: string,
    options?: ErrorOptions,
  ) {
    super(`Execution ${executionId} is indeterminate`, options);
    this.name = "ExecutionIndeterminateError";
  }
}

export class ReproGateExecutor {
  readonly #validator = new Ajv2020({
    allErrors: true,
    strict: true,
    addUsedSchema: false,
  });
  readonly #validators = new Map<Digest, ValidateFunction>();

  constructor(
    readonly store: SqliteExecutionStore,
    readonly connector: DownstreamConnector,
    readonly observer: EffectObserver,
    readonly capabilitySecret: string | Uint8Array,
    readonly receiptSecret: string | Uint8Array,
    readonly receiptKeyId: string,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    input: ExecuteInput,
    checkAdmission?: (at: Date) => void,
  ): Promise<ExecuteResult> {
    const plan = this.store.get(input.actionId);
    if (plan === undefined) {
      throw new Error(`Unknown actionId: ${input.actionId}`);
    }
    if (plan.policy.decision === "deny") {
      throw new Error("Denied actions cannot be executed");
    }
    if (!verifyActionEnvelope(plan.envelope)) {
      throw new Error("Stored action envelope failed integrity verification");
    }
    if (envelopeDigest(plan.envelope) !== plan.envelopeDigest) {
      throw new Error("Stored envelope digest does not match the action plan");
    }

    const entryClock = this.clock().getTime();
    const now = input.now ?? new Date(entryClock);
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Execution time is invalid");
    }
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime()) {
      throw new Error("Action plan has expired");
    }
    const callArguments = structuredClone(input.arguments);
    if (
      digestCanonical(callArguments) !== plan.envelope.input.argumentsDigest
    ) {
      throw new Error("Execution arguments do not match the approved action");
    }

    const claims = verifyCapabilityToken(
      input.capabilityToken,
      {
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        requiredScopes: plan.envelope.authority.scopes,
      },
      this.capabilitySecret,
      now,
    );

    const session = await this.connector.connect(
      plan.envelope.tool.serverRef,
      plan.envelope.tool.artifactDigest,
    );
    try {
      const liveTool = await session.getTool(plan.envelope.tool.toolName);
      if (liveTool === undefined) {
        throw new Error(
          `Downstream tool disappeared: ${plan.envelope.tool.toolName}`,
        );
      }
      if (
        digestCanonical(liveTool.inputSchema) !==
        plan.envelope.tool.schemaDigest
      ) {
        throw new Error("Downstream tool schema changed after approval");
      }

      let validate = this.#validators.get(plan.envelope.tool.schemaDigest);
      if (validate === undefined) {
        // Sessions return fresh JSON objects. Cache by the verified digest and
        // bound both this map and Ajv's internal object-identity cache.
        if (this.#validators.size >= 256) {
          this.#validators.clear();
          this.#validator.removeSchema();
        }
        validate = this.#validator.compile(
          liveTool.inputSchema as object | boolean,
        );
        this.#validators.set(plan.envelope.tool.schemaDigest, validate);
      }
      if (!validate(callArguments)) {
        throw new Error(
          `Execution arguments fail the pinned schema: ${this.#validator.errorsText(
            validate.errors,
          )}`,
        );
      }

      const beforeDigest = digestCanonical(
        await this.observer.snapshot(plan.envelope),
      );
      const prepared = this.store.beginExecution({
        actionId: plan.envelope.actionId,
        envelopeDigest: plan.envelopeDigest,
        capabilityId: claims.jti,
        startedAt: () => {
          // An explicit time anchors a replay or injected mediator clock. Still
          // charge time spent waiting on the connector, observer and writer.
          const clock = this.clock().getTime();
          const at = new Date(
            input.now === undefined
              ? clock
              : now.getTime() + clock - entryClock,
          );
          if (!Number.isFinite(at.getTime()))
            throw new Error("Execution time is invalid");
          if (at.getTime() >= Date.parse(plan.envelope.expiresAt))
            throw new Error("Action plan has expired");
          if (at.getTime() >= Date.parse(claims.expiresAt))
            throw new Error("Capability token has expired");
          if (at.getTime() < Date.parse(claims.issuedAt))
            throw new Error("Capability token was issued in the future");
          checkAdmission?.(at);
          return at.toISOString();
        },
      });

      try {
        const downstreamResult = await session.callTool(
          plan.envelope.tool.toolName,
          callArguments,
        );
        const afterDigest = digestCanonical(
          await this.observer.snapshot(plan.envelope),
        );
        const completedAt = this.clock().toISOString();
        const failed =
          downstreamResult !== null &&
          typeof downstreamResult === "object" &&
          "isError" in downstreamResult &&
          downstreamResult.isError === true;
        const resultDigest = digestCanonical(downstreamResult);
        const receipt = signExecutionReceipt(
          {
            receiptVersion: 1,
            executionId: prepared.executionId,
            actionId: plan.envelope.actionId,
            envelopeDigest: plan.envelopeDigest,
            capabilityId: claims.jti,
            startedAt: prepared.startedAt,
            completedAt,
            outcome: failed ? "failed" : "succeeded",
            resultDigest,
            observedEffects: { beforeDigest, afterDigest },
            ...(failed ? { errorDigest: resultDigest } : {}),
            signingKeyId: this.receiptKeyId,
          },
          this.receiptSecret,
        );
        this.store.completeExecution(receipt);
        return { receipt, downstreamResult };
      } catch (error) {
        // Completion may have committed before its readback threw. The store
        // changes only a prepared row, preserving every durable outcome.
        try {
          this.store.markIndeterminate(
            prepared.executionId,
            this.clock().toISOString(),
          );
        } catch {
          // Already resolved or unavailable. Startup can settle a prepared row.
        }
        throw new ExecutionIndeterminateError(prepared.executionId, {
          cause: error,
        });
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}
