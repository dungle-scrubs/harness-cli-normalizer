import type { ExitCause } from "../execution/events.js";

export const EXIT_CLEAN = 0;
export const EXIT_REFUSAL = 2;
export const EXIT_FAILURE = 1;
/** Crash tier: an uncaught exception, rejection, or main-loop failure inside
 * hcn itself. Distinct from every ordinary class so a crash can never alias
 * a failed turn (1) or a usage refusal (2). The child harness's own crash
 * cause stays EXIT_FAILURE - it is a harness outcome, not an hcn bug. */
export const EXIT_CRASH = 4;

export const exitCodeForCause = (cause: ExitCause): number => {
  if (cause === "clean" || cause === "awaiting-input") return EXIT_CLEAN;
  // All non-clean causes are failures that should be exit 1, except refusal is already handled separately
  return EXIT_FAILURE;
};
