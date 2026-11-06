import { SqliteExecutionStore } from "./execution-store.js";
import { createHeldApproval } from "./held-approval.js";
import { loadRuntimeConfig } from "./runtime-config.js";

export interface CliIo {
  stdout(text: string): void;
}

const USAGE =
  "Usage: reprogate approve --config <absolute-path> <action-id> (--hold [--expires-in <seconds>]|--revoke-held)";
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Host-side: hold or revoke an approval for one exact plan. A held approval
 * is stored signed and is never printed as a token.
 */
export function runHeldApproval(
  args: readonly string[],
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): void {
  const [flag, configPath, actionId, mode, expiresFlag, expiresValue] = args;
  const holdWithExpiry =
    mode === "--hold" &&
    args.length === 6 &&
    expiresFlag === "--expires-in" &&
    expiresValue !== undefined &&
    /^[1-9][0-9]{0,6}$/u.test(expiresValue) &&
    Number(expiresValue) <= MAX_EXPIRES_IN_SECONDS;
  if (
    flag !== "--config" ||
    configPath === undefined ||
    actionId === undefined ||
    !(
      ((mode === "--hold" || mode === "--revoke-held") && args.length === 4) ||
      holdWithExpiry
    )
  )
    throw new Error(USAGE);
  const config = loadRuntimeConfig(configPath);
  if (config.mediation?.heldApprovals !== true)
    throw new Error(
      "Held approvals are disabled; set mediation.heldApprovals to true",
    );
  const store = new SqliteExecutionStore(config.databasePath);
  try {
    if (mode === "--revoke-held") {
      const outcome = store.revokeHeldApproval(actionId);
      if (outcome === "missing")
        throw new Error("This action has no held approval");
      if (outcome === "consumed")
        throw new Error("The held approval was already used");
      io.stdout(`${JSON.stringify({ revoked: true, actionId })}\n`);
      return;
    }
    const plan = store.get(actionId);
    if (plan === undefined) throw new Error(`Unknown actionId: ${actionId}`);
    if (plan.policy.decision === "deny")
      throw new Error("Denied action plans cannot be approved");
    if (Date.parse(plan.envelope.expiresAt) <= now.getTime())
      throw new Error("Cannot approve an expired action plan");
    const secret = environment[config.secrets.capabilitySecretEnv];
    if (secret === undefined || Buffer.byteLength(secret) < 32)
      throw new Error(
        `${config.secrets.capabilitySecretEnv} must contain at least 32 bytes`,
      );
    // A shorter expiry bounds how long the approval is usable at all,
    // including by anyone able to tamper with the store.
    const record = createHeldApproval(
      plan,
      secret,
      now,
      holdWithExpiry
        ? new Date(now.getTime() + Number(expiresValue) * 1000)
        : undefined,
    );
    store.holdApproval(record);
    io.stdout(
      `${JSON.stringify({
        held: true,
        approvalId: record.approvalId,
        actionId: record.actionId,
        expiresAt: record.expiresAt,
      })}\n`,
    );
  } finally {
    store.close();
  }
}
