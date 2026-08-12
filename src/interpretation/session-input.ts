/**
 * Pure validation and encoding for descriptor-declared persistent-session
 * input. This module owns supported wire records, not process I/O.
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
  }
};
