/**
 * Identity decoding: pure recognition of a harness's identity announcement
 * inside its output stream. D-022: claude re-emits `system/init` with the
 * same session_id at every turn start, so announcements are deduped against
 * the last seen id - an identity is only "news" on first sight or change.
 * Under caller-assigned authority an announcement that differs from the
 * REQUESTED id is a rotation anomaly (v1 HSI005): binding it would silently
 * attach the conversation to a context that never saw it, so the outcome is
 * surfaced for the runner to refuse, never papered over.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { isUsableSessionId } from "./session-id.js";
import { asRecord } from "./shape.js";

export type IdentityOutcome =
  /** Not an identity announcement at all. */
  | "none"
  /** First sight (or a changed id under harness-minted authority). */
  | "announced"
  /** Same id as last seen - turn-start metadata, not news. */
  | "duplicate"
  /** Caller-assigned authority, but the harness announced a DIFFERENT id
   * than the one requested - refuse to bind, do not paper over. */
  | "rotated"
  /** Announcement present but the id fails the shape rule - not believed. */
  | "malformed";

export interface DecodedIdentity {
  /** The id this raw event announces, whether or not it is news. */
  readonly sessionId: string | null;
  /** The id to surface as an identity HarnessEvent, or null when not news. */
  readonly identity: string | null;
  readonly outcome: IdentityOutcome;
}

const NOT_ANNOUNCED: DecodedIdentity = { sessionId: null, identity: null, outcome: "none" };

export const decodeIdentity = (
  h: HarnessDescriptor,
  raw: unknown,
  lastSeenId: string | null,
  requestedId: string | null = null,
): DecodedIdentity => {
  const record = asRecord(raw);
  if (record === null) return NOT_ANNOUNCED;
  const spec = h.identity.announce;
  for (const [key, expected] of Object.entries(spec.match)) {
    if (record[key] !== expected) return NOT_ANNOUNCED;
  }
  // idField is a dot-path: muse nests its id at stream.id.
  let cursor: unknown = record;
  for (const segment of spec.idField.split(".")) {
    const inner = asRecord(cursor);
    if (inner === null) return NOT_ANNOUNCED;
    cursor = inner[segment];
  }
  const announced = cursor;
  if (typeof announced !== "string" || !isUsableSessionId(announced)) {
    return typeof announced === "string" && announced !== ""
      ? { sessionId: null, identity: null, outcome: "malformed" }
      : NOT_ANNOUNCED;
  }
  if (
    h.identity.authority === "caller-assigned" &&
    requestedId !== null &&
    announced !== requestedId
  ) {
    return { sessionId: announced, identity: null, outcome: "rotated" };
  }
  if (announced === lastSeenId) {
    return { sessionId: announced, identity: null, outcome: "duplicate" };
  }
  return { sessionId: announced, identity: announced, outcome: "announced" };
};
