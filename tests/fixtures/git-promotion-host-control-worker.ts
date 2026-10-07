import { randomUUID } from "node:crypto";
import {
  createGitPromotionHostControl,
  type GitPromotionHostControlConfig,
} from "../../src/git-promotion-host-control.js";
// Compiled, owned test worker only. No arbitrary process execution or PID probing.
const mode = process.argv[3];
if (mode === "silent") {
  // Owned negative fixture: deliberately stay live without sending a message.
  process.on("message", () => {
    // Stay alive while deliberately ignoring all input.
  });
} else if (mode === "exit-before-message") {
  process.exit(17);
} else
  try {
    const argument = process.argv[2];
    if (!argument) throw new Error("Missing fixture config");
    const controller = createGitPromotionHostControl(
      JSON.parse(argument) as GitPromotionHostControlConfig,
    );
    // Node unrefs an IPC channel without a message/disconnect listener. Keep this
    // owned worker alive explicitly until the parent kills it; no commands accepted.
    process.on("message", () => {
      // Intentionally ignore input; this fixture never accepts commands.
    });
    const owner = controller.acquire(randomUUID());
    process.send?.({ status: "acquired", owner });
    // Keep the IPC channel open until the parent kills this exact child.
  } catch (error) {
    // Errors must not masquerade as an observed held latch.
    const held =
      error instanceof Error && error.message.includes("fence is held");
    process.send?.({ status: held ? "held" : "error" }, () => {
      process.disconnect();
    });
  }
