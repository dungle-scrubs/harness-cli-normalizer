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
import { assertIsolationCombination, ISOLATION_OVERRIDES } from "./isolation.js";
import type { QuestionMode } from "./question.js";
import { ArgvRefusalError } from "./refusal.js";
import type { ToolMapConfig } from "./tool-vocabulary.js";
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

export function assertAccessExclusivity(
  harness: HarnessDescriptor,
  options: Partial<TurnOptions>,
  explicit: (key: keyof TurnOptions) => boolean = (key) => options[key] !== undefined,
): void {
  if (options.access === undefined) return;
  const spec = harness.turnOptions.access;
  const claimed = spec?.kind === "access" ? spec.claims : undefined;
  const claimedConflict = claimed !== undefined && explicit(claimed as keyof TurnOptions);
  const conflict = explicit("tools") || explicit("excludeTools") || claimedConflict;
  if (conflict)
    throw new ArgvRefusalError({
      issue: "mutually-exclusive-options",
      harness: harness.name,
      option: "access",
      supported: [
        claimedConflict
          ? `--access or --${claimed}, not both on ${harness.name}`
          : "--access is a preset allowlist, not a filter over --tools/--exclude-tools",
      ],
      detail: "mutual exclusion",
    });
}

/** Expressibility per profile dimension. Dimensions whose "on" state is
 * the harness's own default (discovery all-on) or whose "off" state emits
 * nothing (autonomy false) are expressible EVERYWHERE - the profile value
 * resolves to "emit nothing," which every harness can do. Divergence is
 * reserved for dimensions that would emit a flag the harness lacks. */
const EXPRESSIBLE: Readonly<Record<ProfileKey, (h: HarnessDescriptor) => boolean>> = {
  contextWindow: (h) => h.turnOptions.contextWindow !== undefined,
  effort: (h) => h.turnOptions.effort !== undefined,
  sandbox: (h) => h.turnOptions.sandbox !== undefined,
  discovery: () => true,
  autonomy: () => true,
  write: () => true,
  shell: () => true,
  tools: (h) => h.tools.includeFlag !== null || h.tools.excludeFlag !== null,
};

/** What one parsed config file carries: the turn options it may set, plus
 * the keys that are not turn options - named toolsets, the raw toolMap
 * (harness -> canonical -> native, merged into the one ToolMap shape
 * here), and the wall-clock timeout. */
export type ConfigTier = Readonly<Omit<Partial<TurnOptions>, "toolMap">> & {
  readonly toolMap?: ToolMapConfig;
  readonly toolsets?: Readonly<Record<string, readonly string[]>>;
  readonly timeout?: number;
};

export interface ConfigTiers {
  /** ~/.config/hcn/config.json (XDG) - machine-wide defaults. */
  readonly user?: ConfigTier;
  /** <git-root>/.hcn/config.json - auto-discovered (ratified A), the ALL-
   * OFF tier; its `tools` key is both the default grant and the FLOOR: an
   * arg grant exceeding it refuses, naming both sets (D5). */
  readonly project?: ConfigTier;
}

/** Where a resolved behaviour value came from; `default` is hcn's own. */
export type BehaviorTier = "arg" | "project-config" | "user-config" | "default";

/** The hcn-owned behaviour instructions a run resolves on every path,
 * launch, resume, and session alike (RFC-02 change 6): question mode,
 * which rides the prompt rather than the argv, and the wall-clock
 * timeout hcn enforces itself. Neither is a turn option, so the
 * launch-only turn-option resolver never sees them. */
export interface ResolvedBehavior {
  readonly questions: { readonly value: QuestionMode; readonly tier: BehaviorTier };
  readonly timeoutSeconds: { readonly value: number | undefined; readonly tier: BehaviorTier };
}

/** Precedence arg > project > user > default, with the tier the
 * provenance line prints. Timeout 0 is an explicit disable. */
export const resolveBehavior = (
  args: { readonly questions?: QuestionMode; readonly timeoutSeconds?: number },
  tiers: ConfigTiers,
): ResolvedBehavior => {
  const pick = <T>(
    arg: T | undefined,
    project: T | undefined,
    user: T | undefined,
    fallback: T,
  ): { readonly value: T; readonly tier: BehaviorTier } => {
    if (arg !== undefined) return { value: arg, tier: "arg" };
    if (project !== undefined) return { value: project, tier: "project-config" };
    if (user !== undefined) return { value: user, tier: "user-config" };
    return { value: fallback, tier: "default" };
  };
  return {
    questions: pick(args.questions, tiers.project?.questions, tiers.user?.questions, "ask"),
    timeoutSeconds: pick(
      args.timeoutSeconds,
      tiers.project?.timeout,
      tiers.user?.timeout,
      undefined,
    ),
  };
};

/** Merge semantics (gap 1, resolved): config keys are scalars and lists in
 * schema v1 - there is nothing to deep-merge INTO - so precedence is whole-
 * key replacement: arg > project > user > profile. A future nested key
 * (per-harness sections) ships with schema v2 and its own merge rule. */
const effectiveConfig = (tiers: ConfigTiers): ConfigTier => ({
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
  assertIsolationCombination(h, args);
  const provenance: ProvenanceEntry[] = [];
  if (args.isolation !== undefined)
    provenance.push({ key: "isolation", value: args.isolation, tier: "arg" });
  const unrenderable: string[] = [];
  const config = { ...effectiveConfig(tiers) };
  if (args.isolation !== undefined) {
    for (const key of ISOLATION_OVERRIDES) delete config[key];
  }
  const sourceTier = (key: string): ProvenanceTier | undefined => {
    if (config[key as keyof TurnOptions] === undefined) return undefined;
    if (tiers.project?.[key as keyof TurnOptions] !== undefined) return "project-config";
    if (tiers.user?.[key as keyof TurnOptions] !== undefined) return "user-config";
    return undefined;
  };

  // D5 toolset expansion: a bare --tools name matching a configured
  // toolset resolves to its list BEFORE the floor check, so a named set
  // within the floor passes and one exceeding it refuses naming the set's
  // members. Project toolsets win name collisions over user toolsets.
  const toolsets: Record<string, readonly string[]> = {
    ...(tiers.user?.toolsets ?? {}),
    ...(tiers.project?.toolsets ?? {}),
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
  // The access preset displaces the turn option its spec claims (codex:
  // sandbox). An explicit value of that option alongside access refuses;
  // the profile default yields silently in the profile loop below. Read
  // from the descriptor, so no harness name appears here.
  const accessSpec = h.turnOptions.access;
  const claimed = accessSpec?.kind === "access" ? accessSpec.claims : undefined;
  assertAccessExclusivity(
    h,
    resolved,
    (key) => effectiveArgs[key] !== undefined || sourceTier(key) !== undefined,
  );

  // toolMap merge per harness per canonical (project > user). The merged
  // shape is the one shape past this point (RFC-02 change 8).
  const mergedToolMap = mergeToolMaps({
    user: tiers.user?.toolMap,
    project: tiers.project?.toolMap,
  });
  if (Object.keys(mergedToolMap).length > 0) {
    resolved.toolMap = mergedToolMap;
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
    allCanonical = allCanonicalNames(defaultDescriptors(), mergedToolMap);
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
    if (args.isolation !== undefined && ISOLATION_OVERRIDES.some((owned) => owned === key)) {
      provenance.push({ key, value: "disabled (tool-free isolation)", tier: "arg" });
      continue;
    }
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
    // The claimed option's profile default yields to a set access preset.
    if (key === claimed && resolved.access !== undefined) {
      provenance.push({ key, value: `${String(value)} (access)`, tier: "harness" });
      continue;
    }
    // D13: the tools marker expands per descriptor. On a harness whose
    // default is already everything (claude), expansion emits nothing -
    // the emit-nothing rule, recorded in provenance. On a harness whose
    // include flag is a strict allowlist (pi), a rendered list would drop
    // every extension and MCP tool the harness registered at run time, so
    // the marker emits nothing there too: the dormant built-ins stay off
    // unless a caller grants them, and a worker keeps its extensions.
    if (key === "tools" && value === "all-known") {
      // --no-tools containment: a tier that switched discovery.tools off
      // must not have the profile grant switch them back on (pi reads
      // --tools as an enabling allowlist). The tier that turned tools off
      // owns the skip.
      const toolsOff = (
        o: { readonly discovery?: TurnOptions["discovery"] } | undefined,
      ): boolean => o?.discovery?.tools === false;
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
      if (h.tools.includeIsStrictAllowlist) {
        provenance.push({
          key,
          value: "none (a tools list would drop extension and MCP tools; harness default applies)",
          tier: "profile",
        });
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
