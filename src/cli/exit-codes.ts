import type { ExitCause } from "../execution/events.js";

export const EXIT_CLEAN = 0;
export const EXIT_REFUSAL = 2;
export const EXIT_FAILURE = 1;

export const exitCodeForCause = (cause: ExitCause): number => {
  if (cause === "clean") return EXIT_CLEAN;
  // All non-clean causes are failures that should be exit 1, except refusal is already handled separately
  return EXIT_FAILURE;
};

export const exitCodeForRefusal = (): number => EXIT_REFUSAL;
