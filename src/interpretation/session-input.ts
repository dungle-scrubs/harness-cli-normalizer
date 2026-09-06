/**
 * Pure validation and encoding for descriptor-declared persistent-session
 * input, and the decoding of the session records the runner cannot read
 * without harness knowledge. This module owns the wire records and their
 * field names (ADR 0005, RFC-02 change 4); the execution layer branches
 * on the closed kinds it returns and holds no field name of its own.
 */
import type {
  HarnessDescriptor,
  SessionInputContract,
  SessionInputKind,
} from "../knowledge/descriptor.js";
import { SESSION_INPUT_KINDS } from "../knowledge/descriptor.js";
import { asRecord } from "./shape.js";

export type SessionInputIssue = "missing-session-input-contract" | "unsupported-session-input-kind";

export class SessionInputRefusalError extends Error {
  constructor(readonly issue: SessionInputIssue) {
    super(`session input refused: ${issue}`);
    this.name = "SessionInputRefusalError";
  }
}

/** The marker ids hcn stamps on the rpc commands it writes, so their
 * responses cannot be confused with anything user-visible. */
export const IDENTITY_PROBE_ID = "hcn-identity";
export const SEND_ID = "hcn-send";

const isSessionInputKind = (value: unknown): value is SessionInputKind =>
  SESSION_INPUT_KINDS.some((kind) => kind === value);

export const resolveSessionInput = (harness: HarnessDescriptor): SessionInputContract => {
  const sessionMode = asRecord(harness.sessionMode);
  const input = asRecord(sessionMode?.input);
  if (input === null || !("kind" in input)) {
    throw new SessionInputRefusalError("missing-session-input-contract");
  }
  if (!isSessionInputKind(input.kind)) {
    throw new SessionInputRefusalError("unsupported-session-input-kind");
  }
  return { kind: input.kind };
};

export const encodeSessionInput = (input: SessionInputContract, text: string): string => {
  switch (input.kind) {
    case "claude-sdk-user-message":
      return `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;
    case "pi-rpc-prompt":
      // Verified against pi 0.84.2 rpc (spike fixtures): a prompt command
      // while idle. hcn keeps no queue (ADR 0007) and writes a send when it
      // arrives; pi refuses a bare prompt mid-run with success:false (spike
      // fixture 05), so a mid-turn send would need streamingBehavior - a
      // pending change, not expressed here yet.
      return `${JSON.stringify({ id: SEND_ID, type: "prompt", message: text })}\n`;
  }
};

/** The record the runner writes at spawn to learn the session id, or null
 * when the harness announces identity on its stream unprompted. pi rpc is
 * identity-silent at startup (spike fixtures); the response echoes the
 * marker id. */
export const encodeIdentityProbe = (h: HarnessDescriptor): string | null => {
  const mode = h.sessionMode;
  if (mode === null || mode.identityProbe === null) return null;
  switch (mode.input.kind) {
    case "pi-rpc-prompt":
      return `${JSON.stringify({ id: IDENTITY_PROBE_ID, type: mode.identityProbe.command })}\n`;
    case "claude-sdk-user-message":
      return null;
  }
};

/** What one parsed stdout record means to a session, as a closed kind. */
export type SessionRecord =
  /** The identity probe answered with the session id. */
  | { readonly kind: "identity"; readonly sessionId: string }
  /** The identity probe answered without an id - surfaced, never silent. */
  | { readonly kind: "probe-failed"; readonly message: string }
  /** An rpc command hcn wrote was refused by the harness. */
  | { readonly kind: "command-failed"; readonly message: string }
  /** Protocol bookkeeping with nothing to surface. */
  | { readonly kind: "ignored" }
  /** The record that delimits a turn, with the harness's own error flag. */
  | { readonly kind: "turn-end"; readonly isError: boolean }
  /** Anything else: content for the stream decoder. */
  | { readonly kind: "content" };

const readPath = (record: Record<string, unknown>, path: string): unknown => {
  let cursor: unknown = record;
  for (const segment of path.split(".")) {
    const inner = asRecord(cursor);
    if (inner === null) return undefined;
    cursor = inner[segment];
  }
  return cursor;
};

const matchesTurnEnd = (
  record: Record<string, unknown>,
  spec: Readonly<Record<string, string>>,
): boolean => Object.entries(spec).every(([key, expected]) => record[key] === expected);

export const decodeSessionRecord = (
  h: HarnessDescriptor,
  parsed: Record<string, unknown>,
): SessionRecord => {
  const mode = h.sessionMode;
  if (mode === null) return { kind: "content" };
  if (mode.input.kind === "pi-rpc-prompt" && parsed.type === "response") {
    const probe = mode.identityProbe;
    if (
      probe !== null &&
      parsed.id === IDENTITY_PROBE_ID &&
      parsed.command === probe.command &&
      parsed.success === true
    ) {
      const announced = readPath(parsed, probe.responseIdField);
      return typeof announced === "string"
        ? { kind: "identity", sessionId: announced }
        : { kind: "probe-failed", message: "identity probe response carried no sessionId" };
    }
    // A failed command is a surfaced error, never a silent drop (spike:
    // mid-stream prompts fail with success:false naming the remedy).
    if (parsed.success === false) {
      return {
        kind: "command-failed",
        message: `rpc command failed: ${JSON.stringify(parsed.command)} - ${JSON.stringify(parsed.error ?? "unknown error")}`,
      };
    }
    return { kind: "ignored" };
  }
  if (matchesTurnEnd(parsed, mode.turnEnd)) {
    // claude's result record carries is_error; pi's agent_settled has no
    // error flag of its own.
    const isError = mode.input.kind === "claude-sdk-user-message" && parsed.is_error === true;
    return { kind: "turn-end", isError };
  }
  return { kind: "content" };
};
