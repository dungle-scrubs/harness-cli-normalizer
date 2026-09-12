import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import type { TranscriptKnowledge } from "./wire.js";

export function unknownTranscriptCapabilities(
  reason: string,
  evidence: readonly Evidence[] = [],
): CapabilityMap {
  return Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      { evidence, prerequisiteRuleIds: [], reason, status: "unknown" },
    ]),
  ) as unknown as CapabilityMap;
}

export function unverifiedTranscriptKnowledge(
  reason: string,
  evidence: readonly Evidence[] = [],
): TranscriptKnowledge {
  return {
    capabilities: unknownTranscriptCapabilities(reason, evidence),
    methods: [],
    rules: [],
    sourceFormats: [],
  };
}
