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
  // RFC-05: each entry names the tier that set it (profile default,
  // user config, project config), so the owner can see which file set a
  // diverged dimension. Existing profile-tier lines keep printing
  // profile, so no existing harness output changes.
  for (const { key, tier } of unrenderable) {
    process.stderr.write(
      `divergence: ${tier} ${JSON.stringify(key)} not expressible on ${harnessName}; harness default applies\n`,
    );
  }
};
