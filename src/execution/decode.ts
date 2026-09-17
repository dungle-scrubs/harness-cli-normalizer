/**
 * Stream-line decoding: one claude stream-json line in, zero or more
 * HarnessEvents out. Stateful only through the explicit DecodeState the
 * caller threads (identity dedupe per D-022). Unparseable lines on a
 * structured stream are tolerated - scanned for walls, never fatal.
 */
import { type CapabilityResult, capabilitiesOf } from "../interpretation/capabilities.js";
import {
  contentEventsWithState,
  freshReaderState,
  type ReaderState,
} from "../interpretation/content.js";
import { decodeIdentity } from "../interpretation/identity.js";
import { detectLimitInLine } from "../interpretation/limits.js";
import type {
  HarnessDescriptor,
  HarnessName,
  StreamingGranularity,
} from "../knowledge/descriptor.js";
import type { HarnessEvent } from "./events.js";
import { failureFromBudget, failureFromLimit } from "./failure.js";

export interface DecodeState {
  lastSeenId: string | null;
  limitSeen: boolean;
  /** The id this turn expects (resume paths); rotation is classified
   * against it. Null for fresh launches. */
  requestedId: string | null;
  /** RFC-06: this turn rendered through the resume-last builder. The
   * runner sets it alongside the null requested id; every identity event
   * built from this state carries it. */
  resumeLast?: true;
  /** The harness's latest model self-attestation (pi assistant message
   * records). Null until one is observed; used to fill observedOn.model
   * on a re-emitted identity when the harness announces identity before
   * it announces its model. Never feeds validation or refusal paths. */
  observedModel: string | null;
  /** The provider announced alongside the observed model, if any. */
  observedProvider: string | null;
  /** An identity event already went out on this state - the re-emit gate
   * for fresh launches, where requestedId is null and only an emitted
   * first-sight identity proves context. */
  identityEmitted: boolean;
  /** The observedModel value the last emitted identity carried (null when
   * it carried the static record). A re-emit fires only on change, so one
   * attestation means one re-emit, not one per assistant record. */
  emittedModel: string | null;
  /** A terminal error the harness may still supersede (pi retries a
   * stopReason-error assistant attempt inside one run). The error is
   * already emitted as NON-terminal evidence when stashed; a later
   * successful assistant message revokes the claim, and the pump settles
   * what remains at stream/turn end through `settleProvisionalError`. */
  provisionalError: string | null;
  /** Opaque per-reader decoder state (cursor call ids and query args in
   * v1), owned by interpretation and held here without inspection (ADR
   * 0005). Threaded across the lines of one turn; reset per turn by
   * constructing fresh state beside every freshDecodeState call. */
  readerState: ReaderState;
}

export const freshDecodeState = (
  requestedId: string | null = null,
  harness?: HarnessName,
): DecodeState => ({
  lastSeenId: null,
  limitSeen: false,
  requestedId,
  observedModel: null,
  observedProvider: null,
  identityEmitted: false,
  emittedModel: null,
  provisionalError: null,
  readerState: harness === undefined ? null : freshReaderState(harness),
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
 * path must not JSON.parse every token delta twice.
 *
 * Model attestation (pi): the harness announces identity (the session
 * record) before it announces its model (the first assistant message
 * record), so the first identity event leaves with observedOn.model empty
 * and the decoder re-emits identity with the observed model once the
 * attestation arrives. The re-emit carries the same sessionId -
 * decodeIdentity dedupes on lastSeenId, so consumers that dedupe see one
 * identity; consumers that take the last (the settings projection that
 * reads observedOn.model) see the model. The observed model is
 * self-attestation, marked runtime-verified through the normal provenance
 * path, and it must never widen authority: validateModel, refusal paths,
 * and capability claims never read it. */
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
  // The identity event's escalation.observedOn is where the downstream
  // settings projection reads the model. Fill the descriptor's observed
  // record with the harness's own attestation once seen; the static
  // observedOn stays the escalation probe provenance it always was.
  const capabilitiesWithObserved = (): CapabilityResult => {
    const caps = capabilities();
    if (state.observedModel === null) return caps;
    return {
      ...caps,
      escalation: {
        ...caps.escalation,
        observedOn: {
          harness: caps.escalation.observedOn?.harness ?? h.name,
          model: state.observedModel,
          version: caps.escalation.observedOn?.version ?? h.verifiedAgainst,
          date: caps.escalation.observedOn?.date ?? "",
        },
      },
    };
  };
  const identityOf = (sessionId: string, authority: "caller-assigned" | "harness-minted") => ({
    kind: "identity" as const,
    sessionId,
    authority,
    capabilities: capabilitiesWithObserved(),
    ...(state.resumeLast === true ? { resumeLast: true as const } : {}),
  });
  const emitIdentity = (
    sessionId: string,
    authority: "caller-assigned" | "harness-minted",
  ): void => {
    events.push(identityOf(sessionId, authority));
    state.identityEmitted = true;
    state.emittedModel = state.observedModel;
  };
  const decoded = decodeIdentity(h, raw, state.lastSeenId, state.requestedId);
  if (decoded.sessionId !== null) state.lastSeenId = decoded.sessionId;
  // The attestation is orthogonal to the session-id announcement: thread
  // it into state on every record, whether or not this record is news.
  if (decoded.observedModel !== null) {
    state.observedModel = decoded.observedModel.model;
    state.observedProvider = decoded.observedModel.provider ?? null;
  }
  if (decoded.identity !== null) {
    const authority = state.requestedId !== null ? "caller-assigned" : "harness-minted";
    emitIdentity(decoded.identity, authority);
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
        emitIdentity(decoded.sessionId, "harness-minted");
      }
    } else {
      events.push({ kind: "error", message: `identity ${decoded.outcome}` });
    }
  } else if (
    decoded.observedModel !== null &&
    state.lastSeenId !== null &&
    state.observedModel !== null &&
    state.observedModel !== state.emittedModel &&
    (state.requestedId !== null || state.identityEmitted)
  ) {
    // Model attestation arrived after identity did: re-emit identity with
    // the same sessionId so the observed model reaches the consumer.
    // Gated on an emitted identity (fresh launches announce first sight
    // on the session record; resumes carry a requestedId) so an
    // attestation with no identity context emits nothing on its own, and
    // on model change so one attestation means one re-emit, not one per
    // assistant record.
    const authority = state.requestedId !== null ? "caller-assigned" : "harness-minted";
    emitIdentity(state.lastSeenId, authority);
  }

  // Content (message/token/tool/error/budget/limit) is per-harness;
  // identity above is descriptor-driven. The stateful entry point
  // threads the opaque per-reader state across the lines of one turn
  // (cursor call ids and query args); the other four readers ignore the
  // state and pass it through. budget and limit are not HarnessEvent
  // kinds of their own here: both become failures.
  const withState = contentEventsWithState(h.name, raw, state.readerState);
  state.readerState = withState.state;
  for (const content of withState.events) {
    if (content.kind === "budget") {
      events.push({ kind: "failure", ...failureFromBudget(content.detail) });
    } else if (content.kind === "limit") {
      events.push({
        kind: "failure",
        ...failureFromLimit(content.code, content.detail, content.resetsAt),
      });
    } else if (content.kind === "error" && content.provisional === true) {
      // A provisional terminal error (pi stopReason error) is evidence
      // now, verdict later: the harness may retry into a successful
      // assistant message, so the terminal claim waits in state and the
      // pump settles it at stream/turn end. Only the verdict is deferred -
      // the error itself streams immediately, non-terminal.
      state.provisionalError = content.message;
      events.push({ kind: "error", message: content.message });
    } else if (content.kind === "message" && content.role === "assistant") {
      // A successful assistant message supersedes any provisional error:
      // the harness recovered, so the earlier stopReason-error attempt
      // must not poison the verdict (its evidence already streamed).
      state.provisionalError = null;
      events.push(content);
    } else {
      events.push(content);
    }
  }
  return events;
};

/** Settle the provisional terminal error where the harness can no longer
 * supersede it: the end of a one-shot stream, or the end of a session
 * turn. What survived is the turn's terminal error (the silent-empty-turn
 * shape); a superseded claim was already emitted as non-terminal evidence
 * and settles to nothing. Clearing on settle keeps the next turn starting
 * from no inherited claim. */
export const settleProvisionalError = (
  state: DecodeState,
): Extract<HarnessEvent, { kind: "error" }>[] => {
  const message = state.provisionalError;
  if (message === null) return [];
  state.provisionalError = null;
  return [{ kind: "error", message, terminal: true }];
};
