import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { HARNESS_NAMES } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";

export const resolveHarness = (name: string): HarnessDescriptor => {
  if (!(HARNESS_NAMES as readonly string[]).includes(name)) {
    // Use ArgvRefusalError shape for consistency but throw generic with supported list
    // Caller will map to exit 2 with supported list
    const err = new ArgvRefusalError({
      issue: "unsupported-option",
      harness: "claude",
      supported: [...HARNESS_NAMES],
      detail: `unknown harness ${JSON.stringify(name)}`,
    });
    // Overwrite message to be harness-specific
    err.message = `unknown harness ${JSON.stringify(name)}; supported: ${[...HARNESS_NAMES].join(", ")}`;
    throw err;
  }
  const map = defaultDescriptors();
  const h = map[name as keyof typeof map];
  if (!h) {
    throw new ArgvRefusalError({
      issue: "unsupported-option",
      harness: name as "claude",
      supported: [...HARNESS_NAMES],
      detail: `harness ${name} not found`,
    });
  }
  return h;
};

export const SUPPORTED_HARNESSES = [...HARNESS_NAMES] as const;
