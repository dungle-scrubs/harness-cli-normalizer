/**
 * Option resolution: the precedence chain args > user config > built-in
 * profile, plus provenance. Pure - the config FILE is read by the CLI layer
 * and passed in as data; this layer only decides what wins.
 *
 * Launch-only: callers apply resolved options on launch, never resume (a
 * resumed session keeps its session's settings - same rule the codex
 * sandbox default already follows).
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { DEFAULT_TURN_PROFILE, type ProfileKey } from "../knowledge/profile.js";
import type { TurnOptions } from "./argv.js";

export type ProvenanceTier = "arg" | "user-config" | "profile" | "harness";

export interface ProvenanceEntry {
  readonly key: string;
  readonly value: unknown;
  readonly tier: ProvenanceTier;
}

export interface ResolvedOptions {
  readonly options: TurnOptions;
  readonly provenance: readonly ProvenanceEntry[];
  /** Profile dimensions this harness cannot express (skip-and-report,
   * never refuse): rendered as divergence, not failure. */
  readonly unrenderable: readonly string[];
}

const EXPRESSIBLE: Readonly<Record<ProfileKey, (h: HarnessDescriptor) => boolean>> = {
  effort: (h) => h.turnOptions.effort !== undefined,
};

/** Resolve the effective options for a LAUNCH. `args` is what the caller
 * passed explicitly (highest tier); `userConfig` the parsed config file;
 * the profile is the floor. Keys absent everywhere defer to the harness
 * and are reported with tier "harness" only when something (config or
 * profile) attempted them - a truly untouched dimension is nobody's
 * business and appears in provenance as tier "harness" with no value. */
export const resolveEffectiveOptions = (
  h: HarnessDescriptor,
  args: TurnOptions,
  userConfig: Readonly<Partial<TurnOptions>> | undefined,
): ResolvedOptions => {
  const provenance: ProvenanceEntry[] = [];
  const unrenderable: string[] = [];
  const resolved: Record<string, unknown> = { ...args };

  // Profile is the floor: apply only where nothing above it set the key.
  for (const [key, value] of Object.entries(DEFAULT_TURN_PROFILE)) {
    const argsSet = args[key as keyof TurnOptions] !== undefined;
    const configSet = userConfig?.[key as keyof TurnOptions] !== undefined;
    if (argsSet) {
      provenance.push({ key, value: args[key as keyof TurnOptions], tier: "arg" });
      continue;
    }
    if (configSet) {
      provenance.push({ key, value: userConfig?.[key as keyof TurnOptions], tier: "user-config" });
      resolved[key] = userConfig?.[key as keyof TurnOptions];
      continue;
    }
    const expressible = EXPRESSIBLE[key as ProfileKey]?.(h) ?? false;
    if (!expressible) {
      // Skip-and-report: a profile default this harness cannot express is
      // reported divergence, never a refusal and never silence.
      unrenderable.push(key);
      provenance.push({ key, value, tier: "harness" });
      continue;
    }
    resolved[key] = value;
    provenance.push({ key, value, tier: "profile" });
  }

  // Config keys outside the profile surface pass through at their own tier
  // (validated later by the same renderers as args).
  if (userConfig !== undefined) {
    for (const [key, value] of Object.entries(userConfig)) {
      if (key in DEFAULT_TURN_PROFILE) continue;
      if (args[key as keyof TurnOptions] !== undefined) {
        provenance.push({ key, value: args[key as keyof TurnOptions], tier: "arg" });
        continue;
      }
      resolved[key] = value;
      provenance.push({ key, value, tier: "user-config" });
    }
  }

  return {
    options: resolved as unknown as TurnOptions,
    provenance,
    unrenderable,
  };
};
