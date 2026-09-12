import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { TurnOptions } from "./argv.js";
import { ArgvRefusalError } from "./refusal.js";

/** Isolation owns these dimensions for the whole invocation. Config defaults
 * yield to it; explicit competing selections refuse before registry reads. */
export const ISOLATION_OVERRIDES = [
  "tools",
  "excludeTools",
  "skills",
  "access",
  "autonomy",
  "discovery",
] as const;
export const assertIsolationCombination = (
  h: HarnessDescriptor,
  opts: Partial<TurnOptions> & {
    readonly skillNames?: readonly string[];
    readonly passthrough?: readonly string[];
  },
): void => {
  if (opts.isolation === undefined) return;
  const conflict =
    ISOLATION_OVERRIDES.find((key) =>
      key === "autonomy" ? opts[key] === true : opts[key] !== undefined,
    ) ??
    (opts.skillNames !== undefined ? "skills" : undefined) ??
    (opts.passthrough?.length ? "native passthrough" : undefined);
  if (conflict === undefined) return;
  throw new ArgvRefusalError({
    issue: "mutually-exclusive-options",
    harness: h.name,
    option: "isolation",
    detail: conflict,
    supported: [
      "tool-free without explicit tools, skills, access, autonomy, discovery, or native passthrough",
    ],
  });
};
