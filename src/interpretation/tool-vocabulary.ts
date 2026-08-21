import type { DescriptorSet } from "../knowledge/overrides.js";

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

/** Pure merge per harness per canonical: project > user. */
export const mergeToolMaps = (tiers: {
  readonly user?: ToolMap;
  readonly project?: ToolMap;
}): { merged: ToolMap; tiers: Readonly<Record<string, Readonly<Record<string, ToolMapTier>>>> } => {
  const merged: Record<string, Record<string, string>> = {};
  const tierMap: Record<string, Record<string, ToolMapTier>> = {};
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
    const perHarness: Record<string, string> = {};
    const perTier: Record<string, ToolMapTier> = {};
    for (const c of canonicals) {
      if (projectEntries[c] !== undefined) {
        perHarness[c] = projectEntries[c] as string;
        perTier[c] = "project-config";
      } else if (userEntries[c] !== undefined) {
        perHarness[c] = userEntries[c] as string;
        perTier[c] = "user-config";
      }
    }
    if (Object.keys(perHarness).length > 0) {
      merged[h] = perHarness;
      tierMap[h] = perTier;
    }
  }
  return { merged, tiers: tierMap };
};

export type CanonicalTable = Readonly<
  Record<string, Readonly<Partial<Record<string, VocabularyEntry>>>>
>;

export const canonicalToolTable = (set: DescriptorSet): CanonicalTable => {
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
      const cat = h.tools.categories.find((c) => c.canonical.includes(canonical));
      if (cat) {
        perHarness[h.name] = { kind: "category", key: cat.key };
      }
    }
    table[canonical] = perHarness;
  }
  return table;
};

export const canonicalNames = (set: DescriptorSet): readonly string[] => {
  const table = canonicalToolTable(set);
  return Object.keys(table).sort();
};
