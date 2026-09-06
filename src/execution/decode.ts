/**
 * Stream-line decoding: one claude stream-json line in, zero or more
 * HarnessEvents out. Stateful only through the explicit DecodeState the
 * caller threads (identity dedupe per D-022). Unparseable lines on a
 * structured stream are tolerated - scanned for walls, never fatal.
 */
import { type CapabilityResult, capabilitiesOf } from "../interpretation/capabilities.js";
import { contentEventsOf } from "../interpretation/content.js";
import { decodeIdentity } from "../interpretation/identity.js";
import { detectLimitInLine } from "../interpretation/limits.js";
import type { HarnessDescriptor, StreamingGranularity } from "../knowledge/descriptor.js";
import type { HarnessEvent } from "./events.js";
import { failureFromBudget, failureFromLimit } from "./failure.js";

export interface DecodeState {
  lastSeenId: string | null;
  limitSeen: boolean;
  /** The id this turn expects (resume paths); rotation is classified
   * against it. Null for fresh launches. */
  requestedId: string | null;
}

export const freshDecodeState = (requestedId: string | null = null): DecodeState => ({
  lastSeenId: null,
  limitSeen: false,
  requestedId,
});

export const decodeLine = (
  h: HarnessDescriptor,
  line: string,
  state: DecodeState,
  model: string,
  streaming?: StreamingGranularity,
): HarnessEvent[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // Not structured output: the only signal a plain line can carry is a wall.
    const code = detectLimitInLine(h, line);
    if (code !== null) {
      state.limitSeen = true;
      return [{ kind: "limit", code, message: `limit wall detected (${code})` }];
    }
    return [];
  }
  return decodeParsed(h, raw, state, model, streaming);
};

/** The parsed-record half of decodeLine, for pumps that already parsed the
 * line once (a session pump inspects `type` before routing) - the hottest
 * path must not JSON.parse every token delta twice. */
export const decodeParsed = (
  h: HarnessDescriptor,
  raw: unknown,
  state: DecodeState,
  model: string,
  streaming?: StreamingGranularity,
): HarnessEvent[] => {
  const events: HarnessEvent[] = [];
  // Streaming is a property of the spawned argv, not of the model, so the
  // runner passes what streamingGranularityOf computed for it; the curated
  // baseline supplies the rest. An unknown model stays unknown throughout.
  const capabilities = (): CapabilityResult => {
    const base = capabilitiesOf(h, model, "headless-turn");
    return streaming !== undefined && base.source !== "unknown" ? { ...base, streaming } : base;
  };
  const decoded = decodeIdentity(h, raw, state.lastSeenId, state.requestedId);
  if (decoded.sessionId !== null) state.lastSeenId = decoded.sessionId;
  if (decoded.identity !== null) {
    const authority = state.requestedId !== null ? "caller-assigned" : "harness-minted";
    events.push({
      kind: "identity",
      sessionId: decoded.identity,
      authority,
      capabilities: capabilities(),
    });
  } else if (decoded.outcome === "malformed" || decoded.outcome === "rotated") {
    if (decoded.outcome === "rotated") {
      const requested = state.requestedId ?? "unknown";
      const announced = decoded.sessionId ?? "unknown";
      events.push({
        kind: "error",
        message: `identity rotated: requested ${requested} but announced ${announced}`,
      });
      // The harness answered under a different id: hand the consumer the
      // id it can actually resume, marked as minted by the harness.
      if (decoded.sessionId !== null) {
        events.push({
          kind: "identity",
          sessionId: decoded.sessionId,
          authority: "harness-minted",
          capabilities: capabilities(),
        });
      }
    } else {
      events.push({ kind: "error", message: `identity ${decoded.outcome}` });
    }
  }

  // Content (message/token/tool/error/budget/limit) is per-harness;
  // identity above is descriptor-driven. contentEventsOf dispatches by
  // harness name inside interpretation. budget and limit are not
  // HarnessEvent kinds of their own here: both become failures.
  for (const content of contentEventsOf(h.name, raw)) {
    if (content.kind === "budget") {
      events.push({ kind: "failure", ...failureFromBudget(content.detail) });
    } else if (content.kind === "limit") {
      events.push({
        kind: "failure",
        ...failureFromLimit(content.code, content.detail, content.resetsAt),
      });
    } else {
      events.push(content);
    }
  }
  return events;
};
