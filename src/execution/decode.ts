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
import { failureFromBudget } from "./failure.js";

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
    events.push({
      kind: "identity",
      sessionId: decoded.identity,
      authority: h.identity.authority,
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

  // Content (message/token/tool/error/budget) is per-harness; identity
  // above is descriptor-driven. contentEventsOf dispatches by harness
  // name. budget is not a HarnessEvent kind and must not leak out.
  for (const content of contentEventsOf(h.name, raw)) {
    if (content.kind === "budget") {
      events.push({ kind: "failure", ...failureFromBudget(content.detail) });
    } else {
      events.push(content);
    }
  }

  // claude's rate_limit_event: only non-"allowed" statuses are failures.
  // overageStatus is deliberately not classified - it is a separate
  // billing signal, not a rate limit.
  if (h.name === "claude" && typeof (raw as Record<string, unknown>).type === "string") {
    const rec = raw as Record<string, unknown>;
    if (rec.type === "rate_limit_event") {
      const info = rec.rate_limit_info as Record<string, unknown> | undefined;
      const status = info?.status as string | undefined;
      if (status !== undefined && status !== "allowed") {
        const rawResets = info?.resetsAt;
        let resetsAt: number | undefined;
        if (typeof rawResets === "number" && Number.isFinite(rawResets) && rawResets > 0) {
          // Arithmetic conversion: resetsAt is seconds, we need milliseconds. No wall clock read.
          resetsAt = rawResets * 1000;
          if (!Number.isFinite(resetsAt) || resetsAt <= 0) resetsAt = undefined;
        }
        // Push a failure event directly - this is a structured record, not a wall scan
        const failure: import("./failure.js").FailureSummary = {
          class: "rate-limit",
          retryable: true,
          message: `Rate limit hit (rate_limit_event status=${status}) - retry after backoff or route to another provider`,
          code: "rate-limit" as const,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        };
        events.push({
          kind: "failure",
          ...failure,
        } as unknown as import("./events.js").HarnessEvent);
      }
    }
  }
  return events;
};
