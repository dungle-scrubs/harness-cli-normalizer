import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { CapabilityMap } from "../knowledge/transcript/schema.js";
import { TRANSCRIPT_CAPABILITIES } from "../knowledge/transcript/schema.js";
import type { CapabilityDocument } from "../knowledge/transcript/wire.js";
export function unknownTranscriptCapabilities(reason: string): CapabilityMap {
  return Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence: [],
        prerequisiteRuleIds: [],
        reason,
        status: "unknown",
      },
    ]),
  ) as unknown as CapabilityMap;
}

export function transcriptCapabilities(
  harness: HarnessDescriptor,
  hcnVersion: string,
): CapabilityDocument {
  return {
    ...(harness.transcript ?? {
      capabilities: unknownTranscriptCapabilities(
        "No passive transcript read method has completed conformance for this harness.",
      ),
      methods: [],
      rules: [],
      sourceFormats: [],
    }),
    harness: harness.name,
    hcnVersion,
    kind: "transcript-capabilities",
    schemaVersion: 1,
    verifiedAgainst: harness.verifiedAgainst,
  };
}
