import type { DescriptorSet } from "../knowledge/overrides.js";

export type VocabularyEntry = string | { category: string };

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
        perHarness[h.name] = builtin.name;
        continue;
      }
      const cat = h.tools.categories.find((c) => c.canonical.includes(canonical));
      if (cat) {
        perHarness[h.name] = { category: cat.key };
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
