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
import { defaultDescriptors } from "../knowledge/overrides.js";
import { DEFAULT_TURN_PROFILE, type ProfileKey } from "../knowledge/profile.js";
import type { TurnOptions } from "./argv.js";
import { ArgvRefusalError } from "./refusal.js";
import type { ToolMap } from "./tool-vocabulary.js";
import { allCanonicalNames, mergeToolMaps, validateCanonicalList } from "./tool-vocabulary.js";
import { validateAccess } from "./vocabulary.js";

export type ProvenanceTier = "arg" | "project-config" | "user-config" | "profile" | "harness";

export interface ProvenanceEntry {
  readonly key: string;
  readonly value: unknown;
  readonly tier: ProvenanceTier;
}

/** D5: the project floor caps arg grants; exceeding it refuses naming both
 * sets. Structured-first: fields, not prose parsing. */
export class FloorExceededError extends Error {
  readonly harness: string;
  readonly excess: readonly string[];
  readonly floor: readonly string[];
  constructor(harness: string, excess: readonly string[], floor: readonly string[]) {
    super(
      `tool grant exceeds the project floor: ${JSON.stringify(excess)} not in floor ${JSON.stringify(floor)} - request a grant within the floor or raise the floor in the project config`,
    );
    this.name = "FloorExceededError";
    this.harness = harness;
    this.excess = excess;
    this.floor = floor;
  }
}

export interface ResolvedOptions {
  readonly options: TurnOptions;
  readonly provenance: readonly ProvenanceEntry[];
  /** Profile dimensions this harness cannot express (skip-and-report,
   * never refuse): rendered as divergence, not failure. */
  readonly unrenderable: readonly string[];
}

/** Expressibility per profile dimension. Dimensions whose "on" state is
 * the harness's own default (discovery all-on) or whose "off" state emits
 * nothing (autonomy false) are expressible EVERYWHERE - the profile value
 * resolves to "emit nothing," which every harness can do. Divergence is
 * reserved for dimensions that would emit a flag the harness lacks. */
const EXPRESSIBLE: Readonly<Record<ProfileKey, (h: HarnessDescriptor) => boolean>> = {
  effort: (h) => h.turnOptions.effort !== undefined,
  sandbox: (h) => h.turnOptions.sandbox !== undefined,
  discovery: () => true,
  autonomy: () => true,
  write: () => true,
  shell: () => true,
  tools: (h) => h.tools.includeFlag !== null || h.tools.excludeFlag !== null,
};

export interface ConfigTiers {
  /** ~/.config/hcn/config.json (XDG) - machine-wide defaults. */
  readonly user?: Readonly<Partial<TurnOptions>>;
  /** <git-root>/.hcn/config.json - auto-discovered (ratified A), the ALL-
   * OFF tier; its `tools` key is both the default grant and the FLOOR: an
   * arg grant exceeding it refuses, naming both sets (D5). */
  readonly project?: Readonly<Partial<TurnOptions>>;
}

/** Merge semantics (gap 1, resolved): config keys are scalars and lists in
 * schema v1 - there is nothing to deep-merge INTO - so precedence is whole-
 * key replacement: arg > project > user > profile. A future nested key
 * (per-harness sections) ships with schema v2 and its own merge rule. */
const effectiveConfig = (tiers: ConfigTiers): Readonly<Partial<TurnOptions>> => ({
  ...(tiers.user ?? {}),
  ...(tiers.project ?? {}),
});

/** Resolve the effective options for a LAUNCH. `args` is what the caller
 * passed explicitly (highest tier); `userConfig` the parsed config file;
 * the profile is the floor. Keys absent everywhere defer to the harness
 * and are reported with tier "harness" only when something (config or
 * profile) attempted them - a truly untouched dimension is nobody's
 * business and appears in provenance as tier "harness" with no value. */
/** A discovery value emits nothing when every facet is true (on). */
const emitsNothing = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value as Record<string, unknown>).every((v) => v === true);

export const resolveEffectiveOptions = (
  h: HarnessDescriptor,
  args: TurnOptions,
  tiers: ConfigTiers = {},
): ResolvedOptions => {
  const provenance: ProvenanceEntry[] = [];
  const unrenderable: string[] = [];
  const config = effectiveConfig(tiers);
  const sourceTier = (key: string): ProvenanceTier | undefined => {
    if (tiers.project?.[key as keyof TurnOptions] !== undefined) return "project-config";
    if (tiers.user?.[key as keyof TurnOptions] !== undefined) return "user-config";
    return undefined;
  };

  // D5 toolset expansion: a bare --tools name matching a configured
  // toolset resolves to its list BEFORE the floor check, so a named set
  // within the floor passes and one exceeding it refuses naming the set's
  // members. Project toolsets win name collisions over user toolsets.
  const toolsets = {
    ...((tiers.user as { toolsets?: Record<string, string[]> } | undefined)?.toolsets ?? {}),
    ...((tiers.project as { toolsets?: Record<string, string[]> } | undefined)?.toolsets ?? {}),
  };
  let effectiveArgs = args;
  if (
    args.tools !== undefined &&
    args.tools.length === 1 &&
    toolsets[args.tools[0] as string] !== undefined
  ) {
    effectiveArgs = { ...args, tools: toolsets[args.tools[0] as string] };
    provenance.push({
      key: "tools",
      value: effectiveArgs.tools,
      tier: "arg",
    });
  }
  const resolved: Record<string, unknown> = { ...effectiveArgs };

  // Validate access value before exclusivity so invalid reports invalid-option-value, not mutual exclusion.
  if (resolved.access !== undefined) {
    const v = validateAccess(String(resolved.access));
    if (!v.ok) {
      throw new ArgvRefusalError({
        issue: "invalid-option-value",
        harness: h.name,
        option: "access",
        supported: ["read", "write"],
        detail: String(resolved.access),
      });
    }
  }
  // Access exclusivity on codex: explicit --sandbox together with --access refuses.
  // Profile sandbox yields to access - only explicit sandbox counts.
  if (h.name === "codex" && resolved.access !== undefined) {
    const hasExplicitSandbox =
      effectiveArgs.sandbox !== undefined || sourceTier("sandbox") !== undefined;
    if (hasExplicitSandbox) {
      throw new ArgvRefusalError({
        issue: "mutually-exclusive-options",
        harness: h.name,
        option: "access",
        supported: ["--access or --sandbox, not both on codex"],
        detail: "mutual exclusion",
      });
    }
  }
  // Access vs tools exclusivity: only explicit tools/excludeTools from args or config, never profile-derived.
  if (resolved.access !== undefined) {
    const explicitTools = effectiveArgs.tools !== undefined || sourceTier("tools") !== undefined;
    const explicitExclude =
      (effectiveArgs as unknown as Record<string, unknown>).excludeTools !== undefined ||
      sourceTier("excludeTools") !== undefined;
    if (explicitTools || explicitExclude) {
      throw new ArgvRefusalError({
        issue: "mutually-exclusive-options",
        harness: h.name,
        option: "access",
        supported: ["--access is a preset allowlist, not a filter over --tools/--exclude-tools"],
        detail: "mutual exclusion",
      });
    }
  }

  // toolMap merge per harness per canonical (project > user)
  const rawToolMapUser = (tiers.user as { toolMap?: ToolMap } | undefined)?.toolMap;
  const rawToolMapProject = (tiers.project as { toolMap?: ToolMap } | undefined)?.toolMap;
  const mergedToolMap = mergeToolMaps({ user: rawToolMapUser, project: rawToolMapProject });
  if (Object.keys(mergedToolMap).length > 0) {
    // Convert mergedToolMap to legacy shape for resolved.toolMap consumers
    const legacy: Record<string, Record<string, string>> = {};
    for (const [harness, per] of Object.entries(mergedToolMap)) {
      legacy[harness] = {};
      for (const [canon, entry] of Object.entries(per as Record<string, { native: string }>)) {
        legacy[harness]![canon] = entry.native;
      }
    }
    resolved.toolMap = legacy as unknown as typeof resolved.toolMap;
    const harnessMap = mergedToolMap[h.name];
    if (harnessMap) {
      for (const [canonical, entry] of Object.entries(harnessMap)) {
        provenance.push({
          key: `tools.${canonical}`,
          value: entry.native,
          tier: entry.tier as ProvenanceTier,
        });
      }
    }
  }

  // Lazy allCanonical build only when tools context present
  const needsCanonical =
    tiers.project?.tools !== undefined ||
    tiers.user?.tools !== undefined ||
    effectiveArgs.tools !== undefined ||
    (effectiveArgs as unknown as Record<string, unknown>).excludeTools !== undefined ||
    Object.keys(toolsets).length > 0 ||
    tiers.project?.toolMap !== undefined ||
    tiers.user?.toolMap !== undefined;
  let allCanonical: readonly string[] | undefined;
  const getAllCanonical = (): readonly string[] => {
    if (allCanonical) return allCanonical;
    allCanonical = allCanonicalNames(defaultDescriptors(), mergedToolMap as unknown as ToolMap);
    return allCanonical;
  };
  if (needsCanonical) {
    const ac = getAllCanonical();
    validateCanonicalList(tiers.project?.tools as readonly string[] | undefined, ac, h.name);
    validateCanonicalList(tiers.user?.tools as readonly string[] | undefined, ac, h.name);
    for (const set of Object.values(toolsets)) {
      validateCanonicalList(set as readonly string[], ac, h.name);
    }
  }
  const floor = tiers.project?.tools;
  if (floor !== undefined && effectiveArgs.tools !== undefined) {
    const floorSet = new Set(floor);
    const excess = effectiveArgs.tools.filter((t) => !floorSet.has(t));
    if (excess.length > 0) {
      throw new FloorExceededError(h.name, excess, [...floor]);
    }
  }

  // Profile is the floor: apply only where nothing above it set the key.
  for (const [key, value] of Object.entries(DEFAULT_TURN_PROFILE)) {
    const argsSet = effectiveArgs[key as keyof TurnOptions] !== undefined;
    const tier = sourceTier(key);
    if (argsSet) {
      provenance.push({ key, value: effectiveArgs[key as keyof TurnOptions], tier: "arg" });
      continue;
    }
    if (tier !== undefined) {
      provenance.push({ key, value: config[key as keyof TurnOptions], tier });
      resolved[key] = config[key as keyof TurnOptions];
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
    // When access is set, skip the all-known expansion (access is a preset allowlist, not a filter).
    // Same shape as --no-tools skip; provenance owned by tier that set access.
    if (key === "tools" && value === "all-known" && resolved.access !== undefined) {
      const accessTier: ProvenanceTier =
        effectiveArgs.access !== undefined ? "arg" : (sourceTier("access") ?? "user-config");
      provenance.push({ key, value: "none (access preset)", tier: accessTier });
      continue;
    }
    // Profile sandbox yields to access - when access is set, drop profile sandbox.
    if (key === "sandbox" && resolved.access !== undefined) {
      provenance.push({ key, value: `${String(value)} (access)`, tier: "harness" });
      continue;
    }
    // D13: the tools marker expands per descriptor. On a harness whose
    // default is already everything (claude), expansion emits nothing -
    // the emit-nothing rule, recorded in provenance. On a harness with
    // dormant built-ins (pi), it becomes the enabling include list.
    if (key === "tools" && value === "all-known") {
      // --no-tools containment: a tier that switched discovery.tools off
      // must not have the profile grant switch them back on (pi reads
      // --tools as an enabling allowlist). The tier that turned tools off
      // owns the skip.
      const toolsOff = (o: Partial<TurnOptions> | undefined): boolean =>
        o?.discovery?.tools === false;
      const offTier: ProvenanceTier | undefined = toolsOff(effectiveArgs)
        ? "arg"
        : toolsOff(tiers.project)
          ? "project-config"
          : toolsOff(tiers.user)
            ? "user-config"
            : undefined;
      if (offTier !== undefined) {
        provenance.push({ key, value: "none (discovery.tools off)", tier: offTier });
        continue;
      }
      const enabled = h.tools.builtins.filter((t) => t.defaultEnabled).length;
      const all = h.tools.builtins.length;
      if (enabled === all) {
        provenance.push({ key, value: "all known (already default)", tier: "profile" });
        continue;
      }
      const expanded = h.tools.builtins
        .filter((t) => t.canonical !== null)
        .map((t) => t.canonical as string);
      resolved[key] = expanded;
      provenance.push({ key, value: expanded, tier: "profile" });
      continue;
    }
    // Dimensions whose value reduces to "emit nothing" (autonomy false,
    // discovery all-on, write/shell true) stay ABSENT from the resolved
    // options - the harness's default already satisfies the profile, and
    // emitting explicit on-flags would change resume grammar and add
    // breakage surface for no semantic gain. Provenance still records
    // the tier.
    if (
      (key === "autonomy" && value === false) ||
      (key === "discovery" && emitsNothing(value)) ||
      ((key === "write" || key === "shell") && value === true)
    ) {
      provenance.push({ key, value, tier: "profile" });
      continue;
    }
    resolved[key] = value;
    provenance.push({ key, value, tier: "profile" });
  }

  // Config keys outside the profile surface pass through at their own tier
  // (validated later by the same renderers as args).
  for (const [key, value] of Object.entries(config)) {
    if (key === "toolsets") continue; // expanded into args above, never a turn option
    if (key === "toolMap") continue; // per-canonical provenance already emitted
    if (key in DEFAULT_TURN_PROFILE) continue;
    if (effectiveArgs[key as keyof TurnOptions] !== undefined) {
      provenance.push({ key, value: effectiveArgs[key as keyof TurnOptions], tier: "arg" });
      continue;
    }
    resolved[key] = value;
    const tier = sourceTier(key) ?? "user-config";
    provenance.push({ key, value, tier });
  }

  // Access divergence / fixup
  if (resolved.access !== undefined && h.turnOptions.access === undefined) {
    unrenderable.push("access");
    for (let i = provenance.length - 1; i >= 0; i--)
      if (provenance[i]?.key === "access") provenance.splice(i, 1);
    provenance.push({ key: "access", value: resolved.access as string, tier: "harness" });
    delete (resolved as Record<string, unknown>).access;
  } else if (resolved.access !== undefined && !provenance.some((p) => p.key === "access")) {
    const tier: ProvenanceTier =
      effectiveArgs.access !== undefined ? "arg" : (sourceTier("access") ?? "user-config");
    provenance.push({ key: "access", value: resolved.access as string, tier });
  }

  return {
    options: resolved as unknown as TurnOptions,
    provenance,
    unrenderable,
  };
};
