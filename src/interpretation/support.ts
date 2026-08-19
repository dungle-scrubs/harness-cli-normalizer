/**
 * Cross-harness support derivation: pure functions that answer "which
 * harnesses express this option, and under what native spelling" from the
 * descriptor set. Phase 3 (D7): refusal diagnostics derive support lists at
 * runtime instead of hardcoding them, so a descriptor edit can never leave
 * a refusal message stale. The autonomy refusal in argv.ts was the
 * counter-pattern - a hardcoded flag array that drifts on descriptor
 * change.
 *
 * Interpretation-layer pure function; takes the descriptor set as an
 * argument rather than importing the defaults, so override sets work.
 */

import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { DescriptorSet } from "../knowledge/overrides.js";
import type { RefusalOption } from "./refusal.js";

export interface SupportEntry {
  readonly harness: string;
  /** The native spelling a caller would use directly on that harness. */
  readonly spelling: string;
}

const spellingOf = (h: HarnessDescriptor, option: RefusalOption): string | null => {
  switch (option) {
    case "tools":
      return h.tools.includeFlag;
    case "excludeTools":
      return h.tools.excludeFlag;
    case "autonomy":
      return h.autonomy?.flag ?? null;
    case "effort":
    case "sandbox":
    case "provider":
    case "write":
    case "shell":
    case "maxSteps":
    case "discovery": {
      const spec = h.turnOptions[option];
      if (spec === undefined) return null;
      const rawRender =
        spec.kind === "discovery"
          ? (
              Object.values(spec.facets)[0] as
                | { render?: { flag?: string; flags?: string[] } }
                | undefined
            )?.render
          : (spec as { render?: { flag?: string; flags?: string[] } }).render;
      if (rawRender === undefined) return null;
      // flag-value/config-kv carry `flag`; flag-list carries `flags` - the
      // first entry is the spelling a caller would type.
      return rawRender.flag ?? rawRender.flags?.[0] ?? null;
    }
    default:
      return null;
  }
};

/** Every harness in the set that can express `option`, with its native
 * spelling. Ordered by the set's insertion order (defaults: claude, codex,
 * pi, muse) so output is stable across calls. */
export const supportedBy = (set: DescriptorSet, option: RefusalOption): readonly SupportEntry[] => {
  const out: SupportEntry[] = [];
  for (const h of Object.values(set)) {
    if (h === undefined) continue;
    const spelling = spellingOf(h, option);
    if (spelling !== null) out.push({ harness: h.name, spelling });
  }
  return out;
};

/** Reverse lookup for native-spelling recognition (D7 part B): given a raw
 * flag token a caller typed, find the option it belongs to and which
 * harnesses spell it that way. Returns null for tokens no descriptor
 * knows - those keep the plain unknown-flag error. */
export const recognizeNativeSpelling = (
  set: DescriptorSet,
  flag: string,
): { readonly option: RefusalOption; readonly entries: readonly SupportEntry[] } | null => {
  const normalized = flag.toLowerCase();
  const candidates: RefusalOption[] = [
    "tools",
    "excludeTools",
    "autonomy",
    "effort",
    "sandbox",
    "provider",
    "write",
    "shell",
    "maxSteps",
  ];
  for (const option of candidates) {
    const entries = supportedBy(set, option).filter((e) => e.spelling.toLowerCase() === normalized);
    if (entries.length > 0) return { option, entries };
  }
  // Discovery facets: single-dash spellings (pi -nt/-nc/-ne/-ns) and
  // claude's --setting-sources. Facet spellings map to the facet name so
  // the redirect can name the normalized spelling.
  const FACET_KEYS = ["tools", "instructionFiles", "extensions", "skills"] as const;
  for (const facet of FACET_KEYS) {
    const entries: SupportEntry[] = [];
    for (const h of Object.values(set)) {
      if (h === undefined) continue;
      const spec = h.turnOptions.discovery;
      if (spec === undefined || spec.kind !== "discovery") continue;
      const facetSpec = spec.facets[facet];
      if (facetSpec === undefined) continue;
      const render = facetSpec.render as { flag?: string; flags?: string[] };
      const spelling = render.flag ?? render.flags?.[0];
      if (spelling !== undefined && spelling.toLowerCase() === normalized) {
        entries.push({ harness: h.name, spelling });
      }
    }
    if (entries.length > 0) {
      return { option: `discovery.${facet}` as RefusalOption, entries };
    }
  }
  return null;
};
