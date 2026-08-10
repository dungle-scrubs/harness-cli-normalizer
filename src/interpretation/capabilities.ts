/**
 * Capability resolution: capabilitiesOf(h, model, mode) answers what this
 * harness/model/mode combination can actually do, always with a source.
 * This layer serves the CURATED baseline (or degrades to unknown for a
 * model outside the vocabulary); runtime verification against a live
 * harness/registry happens at attach time in the consumer, which upgrades
 * source to runtime-verified. An LLM self-asserting capability is neither.
 */
import type {
  HarnessDescriptor,
  HarnessMode,
  StreamingGranularity,
} from "../knowledge/descriptor.js";

export interface CapabilityResult {
  readonly vision: boolean;
  readonly images: boolean;
  readonly streaming: StreamingGranularity;
  readonly session: boolean;
  readonly source: "runtime-verified" | "curated" | "unknown";
  readonly confidence: "high" | "medium" | "none";
}

export const capabilitiesOf = (
  h: HarnessDescriptor,
  model: string,
  mode: HarnessMode,
): CapabilityResult => {
  const resolved = h.vocabulary.aliases[model] ?? model;
  if (!h.vocabulary.models.includes(resolved)) {
    // Curated claims cover curated models only - an extensible registry's
    // unknown model still degrades here until runtime verification.
    // Degrade: no raw-image claims, no streaming claims - transcribe/hold.
    return {
      vision: false,
      images: false,
      streaming: "none",
      session: false,
      source: "unknown",
      confidence: "none",
    };
  }
  return {
    vision: h.capabilities.vision,
    images: h.capabilities.images,
    streaming: h.capabilities.streamingByMode[mode],
    session: h.capabilities.session,
    source: "curated",
    confidence: "medium",
  };
};
