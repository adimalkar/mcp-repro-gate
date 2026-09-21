import { Ajv2020 } from "ajv/dist/2020.js";

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
  readonly #validator = new Ajv2020({ allErrors: true, strict: true });

  constructor(
    readonly store: SqliteExecutionStore,
    readonly connector: DownstreamConnector,
    readonly observer: EffectObserver,
    readonly capabilitySecret: string | Uint8Array,
    readonly receiptSecret: string | Uint8Array,
    readonly receiptKeyId: string,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
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

    const now = input.now ?? this.clock();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Execution time is invalid");
    }
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime()) {
      throw new Error("Action plan has expired");
    }
    if (
      digestCanonical(input.arguments) !== plan.envelope.input.argumentsDigest
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

      const validate = this.#validator.compile(
        liveTool.inputSchema as object | boolean,
      );
      if (!validate(input.arguments)) {
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
        startedAt: now.toISOString(),
      });

      let downstreamResult: unknown;
      try {
        downstreamResult = await session.callTool(
          plan.envelope.tool.toolName,
          input.arguments,
        );
      } catch (error) {
        this.store.markIndeterminate(
          prepared.executionId,
          this.clock().toISOString(),
        );
        throw new ExecutionIndeterminateError(prepared.executionId, {
          cause: error,
        });
      }

      let afterDigest: Digest;
      try {
        afterDigest = digestCanonical(
          await this.observer.snapshot(plan.envelope),
        );
      } catch (error) {
        this.store.markIndeterminate(
          prepared.executionId,
          this.clock().toISOString(),
        );
        throw new ExecutionIndeterminateError(prepared.executionId, {
          cause: error,
        });
      }

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
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}
