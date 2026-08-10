/**
 * The shape a harness session id must have before it is believed. Ported
 * from lucid v1 core/session-id.ts: a discovered id comes from the harness's
 * own stdout - the least trusted input in the flow - and is later substituted
 * into resume argv and filesystem paths. Bounding length and stripping
 * control characters is not enough: an id of `--dangerously-skip-permissions`
 * is printable and short, and would be handed to the CLI as a FLAG; an id of
 * `../../etc/passwd` is a path traversal. An id is an opaque token: letters,
 * digits, and the few separators real harnesses use, never leading with a
 * dash or a dot.
 */

export const SESSION_ID_MAX = 128;

const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/** True when this id may be believed, placed into resume argv, or used as a
 * path segment. */
export const isUsableSessionId = (value: string): boolean =>
  value.length > 0 && value.length <= SESSION_ID_MAX && SESSION_ID_SHAPE.test(value);

/** Raised when a session id fails the shape rule at a boundary that cannot
 * return null (argv building, store-path resolution). */
export class SessionIdRefusalError extends Error {
  constructor(value: string) {
    super(
      `session id ${JSON.stringify(value.slice(0, 64))} is not a usable id: must match ${String(SESSION_ID_SHAPE)} and be at most ${SESSION_ID_MAX} chars`,
    );
    this.name = "SessionIdRefusalError";
  }
}

export const assertUsableSessionId = (value: string): void => {
  if (!isUsableSessionId(value)) throw new SessionIdRefusalError(value);
};
