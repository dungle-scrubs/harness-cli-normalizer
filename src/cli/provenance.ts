import type { ProvenanceEntry, UnrenderableEntry } from "../interpretation/resolve-options.js";

export const writeProvenance = (
  harnessName: string,
  provenance: readonly ProvenanceEntry[],
  unrenderable: readonly UnrenderableEntry[],
): void => {
  if (provenance.length === 0 && unrenderable.length === 0) return;
  for (const entry of provenance) {
    process.stderr.write(
      `provenance: ${entry.key} = ${JSON.stringify(entry.value)} (${entry.tier})\n`,
    );
  }
  // Phase 3 prints the recorded entry tier; until then the profile-tier
  // lines keep printing profile and the output stays unchanged.
  for (const { key } of unrenderable) {
    process.stderr.write(
      `divergence: profile ${JSON.stringify(key)} not expressible on ${harnessName}; harness default applies\n`,
    );
  }
};
