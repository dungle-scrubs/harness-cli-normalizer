/**
 * Stream-line decoding: one claude stream-json line in, zero or more
 * HarnessEvents out. Stateful only through the explicit DecodeState the
 * caller threads (identity dedupe per D-022). Unparseable lines on a
 * structured stream are tolerated - scanned for walls, never fatal.
 */
import { capabilitiesOf } from "../interpretation/capabilities.js";
import { decodeIdentity } from "../interpretation/identity.js";
import { detectLimitInLine } from "../interpretation/limits.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { HarnessEvent } from "./events.js";

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

const textOfContent = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("")
    : "";

const toolsOfContent = (content: unknown): HarnessEvent[] =>
  Array.isArray(content)
    ? content
        .filter(
          (b): b is { type: string; name: string; input?: unknown } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "tool_use" &&
            typeof (b as { name?: unknown }).name === "string",
        )
        .map((b) => ({ kind: "tool", name: b.name, input: b.input }) as HarnessEvent)
    : [];

export const decodeLine = (
  h: HarnessDescriptor,
  line: string,
  state: DecodeState,
  model: string,
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
  return decodeParsed(h, raw, state, model);
};

/** The parsed-record half of decodeLine, for pumps that already parsed the
 * line once (a session pump inspects `type` before routing) - the hottest
 * path must not JSON.parse every token delta twice. */
export const decodeParsed = (
  h: HarnessDescriptor,
  raw: unknown,
  state: DecodeState,
  model: string,
): HarnessEvent[] => {
  const events: HarnessEvent[] = [];
  const decoded = decodeIdentity(h, raw, state.lastSeenId, state.requestedId);
  if (decoded.sessionId !== null) state.lastSeenId = decoded.sessionId;
  if (decoded.identity !== null) {
    events.push({
      kind: "identity",
      sessionId: decoded.identity,
      authority: h.identity.authority,
      capabilities: capabilitiesOf(h, model, "headless-turn"),
    });
  } else if (decoded.outcome === "malformed" || decoded.outcome === "rotated") {
    // The interpretation layer classified an identity anomaly; swallowing
    // it would leave the runner waiting for an identity that already
    // failed to arrive (or bind a rotated one).
    events.push({ kind: "error", message: `identity ${decoded.outcome}` });
  }

  const record = raw as Record<string, unknown>;
  const type = record["type"];
  if (type === "assistant") {
    const message = record["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    const text = textOfContent(content);
    events.push(...toolsOfContent(content));
    if (text !== "") {
      events.push({
        kind: "message",
        role: typeof message?.["role"] === "string" ? (message["role"] as string) : "assistant",
        text,
      });
    }
  } else if (type === "stream_event") {
    const event = record["event"] as Record<string, unknown> | undefined;
    const delta = event?.["delta"] as Record<string, unknown> | undefined;
    if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
      events.push({ kind: "token", text: delta["text"] });
    }
  } else if (type === "system" && decoded.identity === null && decoded.outcome === "none") {
    const subtype = record["subtype"];
    if (typeof subtype === "string") events.push({ kind: "progress", label: subtype });
  }
  return events;
};
