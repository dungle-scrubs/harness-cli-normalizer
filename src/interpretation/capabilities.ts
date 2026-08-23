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
import { compareVersions } from "./versions.js";
import { resolveModel } from "./vocabulary.js";

export interface EscalationObservedOn {
  readonly harness: string;
  readonly model: string;
  readonly version: string;
  readonly date: string;
}

/**
 * Escalation claim: whether this harness and model were observed to emit
 * the structured hcn-question block when instructed, NOT "this harness can
 * ask" - live probes show models ask unprompted, so capability-to-ask would
 * be false.
 */
export interface EscalationClaim {
  /** True when this harness and model were observed to emit the structured block when instructed. */
  readonly supported: boolean;
  readonly source: "runtime-verified" | "curated" | "unknown";
  readonly confidence: "high" | "medium" | "none";
  readonly observedOn?: EscalationObservedOn;
}

export interface CapabilityResult {
  readonly vision: boolean;
  readonly images: boolean;
  readonly streaming: StreamingGranularity;
  readonly session: boolean;
  readonly source: "runtime-verified" | "curated" | "unknown";
  readonly confidence: "high" | "medium" | "none";
  readonly escalation: EscalationClaim;
}

const escalationOf = (h: HarnessDescriptor): EscalationClaim => {
  const obs = h.escalation.observedOn;
  if (obs !== undefined) {
    const cmp = compareVersions(obs.version, h.verifiedAgainst);
    if (cmp < 0) {
      return {
        supported: true,
        source: "runtime-verified",
        confidence: "medium",
        observedOn: obs,
      };
    }
    return {
      supported: true,
      source: "runtime-verified",
      confidence: "high",
      observedOn: obs,
    };
  }
  if (h.escalation.supported) {
    return { supported: true, source: "curated", confidence: "medium" };
  }
  return { supported: false, source: "unknown", confidence: "none" };
};

export const capabilitiesOf = (
  h: HarnessDescriptor,
  model: string,
  mode: HarnessMode,
): CapabilityResult => {
  // F-09: an absent model means the harness default model (curated), not
  // an unknown model. Only degrade when a model was explicitly given and is
  // not curated.
  if (model !== "" && !resolveModel(h, model).curated) {
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
      escalation: { supported: false, source: "unknown", confidence: "none" },
    };
  }
  return {
    vision: h.capabilities.vision,
    images: h.capabilities.images,
    streaming: h.capabilities.streamingByMode[mode],
    session: h.capabilities.session,
    source: "curated",
    confidence: "medium",
    escalation: escalationOf(h),
  };
};
