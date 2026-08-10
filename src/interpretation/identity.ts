/**
 * Identity decoding: pure recognition of a harness's identity announcement
 * inside its output stream. D-022: claude re-emits `system/init` with the
 * same session_id at every turn start, so announcements are deduped against
 * the last seen id - an identity is only "news" on first sight or change.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface DecodedIdentity {
  /** The id this raw event announces, whether or not it is news. */
  readonly sessionId: string | null;
  /** The id to surface as an identity HarnessEvent, or null when duplicate. */
  readonly identity: string | null;
}

export const decodeIdentity = (
  h: HarnessDescriptor,
  raw: unknown,
  lastSeenId: string | null,
): DecodedIdentity => {
  if (typeof raw !== "object" || raw === null) return { sessionId: null, identity: null };
  const record = raw as Record<string, unknown>;
  const spec = h.identity.announce;
  if (record["type"] !== spec.type) return { sessionId: null, identity: null };
  if (spec.subtype !== undefined && record["subtype"] !== spec.subtype) {
    return { sessionId: null, identity: null };
  }
  const announced = record[spec.idField];
  if (typeof announced !== "string" || announced === "") {
    return { sessionId: null, identity: null };
  }
  return { sessionId: announced, identity: announced === lastSeenId ? null : announced };
};
