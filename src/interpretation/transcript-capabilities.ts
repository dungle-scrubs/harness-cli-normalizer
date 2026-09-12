import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { unverifiedTranscriptKnowledge } from "../knowledge/transcript/unverified.js";
import type { CapabilityDocument } from "../knowledge/transcript/wire.js";

export function transcriptCapabilities(
  harness: HarnessDescriptor,
  hcnVersion: string,
): CapabilityDocument {
  const knowledge =
    harness.transcript ??
    unverifiedTranscriptKnowledge(
      "No passive transcript read method has completed conformance for this harness.",
    );
  return {
    capabilities: knowledge.capabilities,
    methods: knowledge.methods,
    rules: knowledge.rules,
    sourceFormats: knowledge.sourceFormats,
    harness: harness.name,
    hcnVersion,
    kind: "transcript-capabilities",
    schemaVersion: 1,
    verifiedAgainst: harness.verifiedAgainst,
  };
}
