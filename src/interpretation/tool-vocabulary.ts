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

export type ToolMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type ToolMapTier = "user-config" | "project-config";

export type MergedToolMap = Readonly<
  Record<string, Readonly<Record<string, { native: string; tier: ToolMapTier }>>>
>;

/** Pure merge per harness per canonical: project > user. */
export const mergeToolMaps = (tiers: {
  readonly user?: ToolMap;
  readonly project?: ToolMap;
}): MergedToolMap => {
  const merged: Record<string, Record<string, { native: string; tier: ToolMapTier }>> = {};
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
    const perHarness: Record<string, { native: string; tier: ToolMapTier }> = {};
    for (const c of canonicals) {
      if (projectEntries[c] !== undefined) {
        perHarness[c] = { native: projectEntries[c] as string, tier: "project-config" };
      } else if (userEntries[c] !== undefined) {
        perHarness[c] = { native: userEntries[c] as string, tier: "user-config" };
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

// Backwards compat alias
export const canonicalToolTable = canonicalTable;

export const canonicalNames = (set: DescriptorSet): readonly string[] => {
  const table = canonicalTable(set);
  return Object.keys(table).sort();
};

export const allCanonicalNames = (
  set: DescriptorSet,
  toolMap?: ToolMap | MergedToolMap,
): readonly string[] => {
  const base = canonicalNames(set);
  const extra = toolMap
    ? Object.values(toolMap).flatMap((m) => Object.keys(m as Record<string, unknown>))
    : [];
  return [...new Set([...base, ...extra])].sort();
};

export const hasCounterpart = (
  table: CanonicalTable,
  canonical: string,
  harnessName: string,
  toolMap?: MergedToolMap | ToolMap,
): boolean => {
  if (toolMap) {
    const hm = (toolMap as MergedToolMap)[harnessName];
    if (hm && (hm as Record<string, unknown>)[canonical] !== undefined) {
      const v = (hm as Record<string, unknown>)[canonical] as unknown;
      if (typeof v === "object" && v !== null && "native" in (v as Record<string, unknown>))
        return true;
      if (typeof v === "string") return true;
    }
  }
  const entry = table[canonical];
  if (!entry) return false;
  return entry[harnessName] !== undefined;
};

export const nativeFor = (
  table: CanonicalTable,
  canonical: string,
  harnessName: string,
  toolMap?: MergedToolMap | ToolMap,
): string | null => {
  if (toolMap) {
    const hm = (toolMap as Record<string, Record<string, unknown>>)[harnessName];
    const val = hm?.[canonical];
    if (val !== undefined) {
      if (typeof val === "object" && val !== null && "native" in (val as Record<string, unknown>)) {
        return (val as { native: string }).native;
      }
      if (typeof val === "string") return val as string;
    }
  }
  const entry = table[canonical];
  const v = entry?.[harnessName];
  if (v?.kind === "builtin") return v.native;
  return null;
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
