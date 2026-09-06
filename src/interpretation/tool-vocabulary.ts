/**
 * The canonical tool vocabulary and the toolMap that extends it.
 *
 * One toolMap shape (RFC-02 change 8): a config file carries the raw
 * shape, harness -> canonical -> native, and `mergeToolMaps` folds the
 * tiers into the one shape everything downstream reads, harness ->
 * canonical -> the native name plus the tier that set it. Tool selection
 * and the access preset call `hasCounterpart` and `nativeFor` instead of
 * restating them.
 */
import type { DescriptorSet } from "../knowledge/overrides.js";
import { ArgvRefusalError } from "./refusal.js";

export const NATIVE_PREFIX = "native:" as const;

export type VocabularyEntry =
  | { kind: "builtin"; native: string }
  | { kind: "category"; key: string };

export const READ_PRESET = ["read", "grep", "glob", "list", "web-fetch", "web-search"] as const;

export type ParsedSelector = { kind: "canonical"; name: string } | { kind: "native"; name: string };

export const parseToolSelector = (raw: string): ParsedSelector =>
  raw.startsWith(NATIVE_PREFIX)
    ? { kind: "native", name: raw.slice(NATIVE_PREFIX.length) }
    : { kind: "canonical", name: raw };

/** The raw shape a config file carries: harness -> canonical -> native. */
export type ToolMapConfig = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type ToolMapTier = "user-config" | "project-config";

export interface ToolMapEntry {
  readonly native: string;
  readonly tier: ToolMapTier;
}

/** The one shape past the merge: harness -> canonical -> native plus the
 * tier that set it. Carried on the turn options and read by every
 * consumer. */
export type ToolMap = Readonly<Record<string, Readonly<Record<string, ToolMapEntry>>>>;

/** Pure merge per harness per canonical: project > user. */
export const mergeToolMaps = (tiers: {
  readonly user?: ToolMapConfig;
  readonly project?: ToolMapConfig;
}): ToolMap => {
  const merged: Record<string, Record<string, ToolMapEntry>> = {};
  const harnesses = new Set<string>([
    ...Object.keys(tiers.user ?? {}),
    ...Object.keys(tiers.project ?? {}),
  ]);
  for (const h of harnesses) {
    const userEntries = tiers.user?.[h] ?? {};
    const projectEntries = tiers.project?.[h] ?? {};
    const canonicals = new Set<string>([
      ...Object.keys(userEntries),
      ...Object.keys(projectEntries),
    ]);
    const perHarness: Record<string, ToolMapEntry> = {};
    for (const c of canonicals) {
      const project = projectEntries[c];
      const user = userEntries[c];
      if (project !== undefined) {
        perHarness[c] = { native: project, tier: "project-config" };
      } else if (user !== undefined) {
        perHarness[c] = { native: user, tier: "user-config" };
      }
    }
    if (Object.keys(perHarness).length > 0) {
      merged[h] = perHarness;
    }
  }
  return merged;
};

export type CanonicalTable = Readonly<
  Record<string, Readonly<Partial<Record<string, VocabularyEntry>>>>
>;

const tableCache = new WeakMap<DescriptorSet, CanonicalTable>();

export const canonicalTable = (set: DescriptorSet): CanonicalTable => {
  const cached = tableCache.get(set);
  if (cached) return cached;
  const allCanonical = new Set<string>();
  for (const h of Object.values(set)) {
    if (!h) continue;
    for (const b of h.tools.builtins) {
      if (b.canonical !== null) allCanonical.add(b.canonical);
    }
    for (const c of h.tools.categories) {
      for (const n of c.canonical) allCanonical.add(n);
    }
  }
  const table: Record<string, Record<string, VocabularyEntry>> = {};
  for (const canonical of allCanonical) {
    const perHarness: Record<string, VocabularyEntry> = {};
    for (const h of Object.values(set)) {
      if (!h) continue;
      const builtin = h.tools.builtins.find((b) => b.canonical === canonical);
      if (builtin) {
        perHarness[h.name] = { kind: "builtin", native: builtin.name };
        continue;
      }
      const cat = h.tools.categories.find((c) =>
        (c.canonical as readonly string[]).includes(canonical),
      );
      if (cat) {
        perHarness[h.name] = { kind: "category", key: cat.key };
      }
    }
    table[canonical] = perHarness;
  }
  const frozen = table as CanonicalTable;
  tableCache.set(set, frozen);
  return frozen;
};

export const canonicalNames = (set: DescriptorSet): readonly string[] => {
  const table = canonicalTable(set);
  return Object.keys(table).sort();
};

/** Every canonical name: the descriptors' plus every name a toolMap adds. */
export const allCanonicalNames = (set: DescriptorSet, toolMap?: ToolMap): readonly string[] => {
  const base = canonicalNames(set);
  const extra = toolMap ? Object.values(toolMap).flatMap((m) => Object.keys(m)) : [];
  return [...new Set([...base, ...extra])].sort();
};

/** Whether `harnessName` can express `canonical`: through its toolMap
 * entry, a built-in, or a category. */
export const hasCounterpart = (
  table: CanonicalTable,
  canonical: string,
  harnessName: string,
  toolMap?: ToolMap,
): boolean =>
  toolMap?.[harnessName]?.[canonical] !== undefined ||
  table[canonical]?.[harnessName] !== undefined;

/** The native name `harnessName` lists `canonical` under: the toolMap
 * entry wins, then the built-in; a category has no name-list spelling. */
export const nativeFor = (
  table: CanonicalTable,
  canonical: string,
  harnessName: string,
  toolMap?: ToolMap,
): string | null => {
  const mapped = toolMap?.[harnessName]?.[canonical];
  if (mapped !== undefined) return mapped.native;
  const entry = table[canonical]?.[harnessName];
  return entry?.kind === "builtin" ? entry.native : null;
};

export const validateCanonicalList = (
  names: readonly string[] | undefined,
  allCanonical: readonly string[],
  harness: string,
): void => {
  if (!names) return;
  const set = new Set(allCanonical);
  for (const name of names) {
    if (name.startsWith(NATIVE_PREFIX)) continue;
    if (!set.has(name)) {
      throw new ArgvRefusalError({
        issue: "unknown-tool-name",
        harness: harness as import("../knowledge/descriptor.js").HarnessName,
        option: "tools",
        supported: allCanonical as unknown as string[],
        hint: "use native:<name> for an extension or MCP tool",
        detail: `unknown tool name ${JSON.stringify(name)}`,
      });
    }
  }
};
