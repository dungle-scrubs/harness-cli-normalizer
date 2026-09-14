/**
 * Identity decoding: pure recognition of a harness's identity announcement
 * inside its output stream. D-022: claude re-emits `system/init` with the
 * same session_id at every turn start, so announcements are deduped against
 * the last seen id - an identity is only "news" on first sight or change.
 * Under caller-assigned authority an announcement that differs from the
 * REQUESTED id is a rotation anomaly (v1 HSI005): binding it would silently
 * attach the conversation to a context that never saw it, so the outcome is
 * surfaced for the runner to refuse, never papered over.
 *
 * A harness may also self-attest the model it runs (pi streams assistant
 * `message` records carrying `provider`/`model` on every turn - observed on
 * pi --mode json against pi 0.85.1, where the transcript-only `model_change`
 * record never appears on stdout). decodeModelObservation reads that
 * attestation: it records WHAT the harness says it runs (an observed model
 * id plus provider) and NOTHING ELSE. The observed value must never widen
 * authority - it feeds display/capability fields only, never validation
 * (validateModel ignores it), refusal paths, or capability claims anywhere.
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

export interface ModelObservation {
  /** The exact model id the harness announced (message.message.model). */
  readonly model: string;
  /** The provider the harness announced alongside it, if any. */
  readonly provider?: string;
}

export interface DecodedIdentity {
  /** The id this raw event announces, whether or not it is news. */
  readonly sessionId: string | null;
  /** The id to surface as an identity HarnessEvent, or null when not news. */
  readonly identity: string | null;
  readonly outcome: IdentityOutcome;
  /** The harness's own model self-attestation on this record, if any. */
  readonly observedModel: ModelObservation | null;
}

const NOT_ANNOUNCED: DecodedIdentity = {
  sessionId: null,
  identity: null,
  outcome: "none",
  observedModel: null,
};

/**
 * Read a harness's model self-attestation off one parsed record. pi
 * carries `message: { provider, model }` on assistant records (verified on
 * pi 0.85.1 stdout: `message_start`/`message_end`/`turn_end`/`agent_end`
 * all carry it from the first assistant message on). Anything else - no
 * message object, an error stopReason, non-string fields - is no
 * observation, never a refusal. A failed turn says nothing about what
 * runs the next one.
 */
export const decodeModelObservation = (raw: unknown): ModelObservation | null => {
  const record = asRecord(raw);
  if (record === null) return null;
  if (record.type === "model_change") {
    // The transcript-only shape (pi session files); stdout never carries
    // it, but a harness that does announce it this way is read the same.
    const provider = record.provider;
    const model = record.modelId;
    if (typeof model !== "string" || model === "") return null;
    return typeof provider === "string" && provider !== "" ? { model, provider } : { model };
  }
  const message = asRecord(record.message);
  if (message === null) return null;
  if (message.role !== "assistant") return null;
  // The CLEAN_SELECTOR stance: a model id is an opaque selector, not a
  // trusted path - blank or non-string attestation is dropped, never
  // surfaced. No regExp import here keeps interpretation's dependency
  // rule (relative imports only); the shape check is the gate.
  const model = message.model;
  if (typeof model !== "string" || model === "") return null;
  const provider = message.provider;
  return typeof provider === "string" && provider !== "" ? { model, provider } : { model };
};

export const decodeIdentity = (
  h: HarnessDescriptor,
  raw: unknown,
  lastSeenId: string | null,
  requestedId: string | null = null,
): DecodedIdentity => {
  // The model attestation is orthogonal to the session-id announcement:
  // it rides every assistant record, not only the announce record, so
  // read it first and carry it on every outcome below.
  const observedModel = h.name === "pi" ? decodeModelObservation(raw) : null;
  const withModel = (base: Omit<DecodedIdentity, "observedModel">): DecodedIdentity => ({
    ...base,
    observedModel,
  });
  const record = asRecord(raw);
  if (record === null) return withModel(NOT_ANNOUNCED);
  const spec = h.identity.announce;
  for (const [key, expected] of Object.entries(spec.match)) {
    if (record[key] !== expected) return withModel(NOT_ANNOUNCED);
  }
  // idField is a dot-path: muse nests its id at stream.id.
  let cursor: unknown = record;
  for (const segment of spec.idField.split(".")) {
    const inner = asRecord(cursor);
    if (inner === null) return withModel(NOT_ANNOUNCED);
    cursor = inner[segment];
  }
  const announced = cursor;
  if (typeof announced !== "string" || !isUsableSessionId(announced)) {
    // A record that matched a real discriminator (claude system/init) but
    // carries a null/missing/garbage id is a MALFORMED announcement the
    // runner must see - treating it as unrelated output leaves the runner
    // waiting for an identity that already failed to arrive. Descriptors
    // with an empty match (muse: any record) have no discriminator, so a
    // record without the id path is ordinary output, not malformed.
    const discriminated = Object.keys(spec.match).length > 0;
    return withModel(
      discriminated ? { sessionId: null, identity: null, outcome: "malformed" } : NOT_ANNOUNCED,
    );
  }
  if (
    h.identity.authority === "caller-assigned" &&
    requestedId !== null &&
    announced !== requestedId
  ) {
    return withModel({ sessionId: announced, identity: null, outcome: "rotated" });
  }
  if (announced === lastSeenId) {
    return withModel({ sessionId: announced, identity: null, outcome: "duplicate" });
  }
  return withModel({ sessionId: announced, identity: announced, outcome: "announced" });
};
