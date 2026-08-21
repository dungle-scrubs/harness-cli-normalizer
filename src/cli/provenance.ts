import type { ProvenanceEntry } from "../interpretation/resolve-options.js";

export const writeProvenance = (
  harnessName: string,
  provenance: readonly ProvenanceEntry[],
  unrenderable: readonly string[],
): void => {
  if (provenance.length === 0 && unrenderable.length === 0) return;
  for (const entry of provenance) {
    process.stderr.write(
      `provenance: ${entry.key} = ${JSON.stringify(entry.value)} (${entry.tier})\n`,
    );
  }
  for (const key of unrenderable) {
    process.stderr.write(
      `divergence: profile ${JSON.stringify(key)} not expressible on ${harnessName}; harness default applies\n`,
    );
  }
};
