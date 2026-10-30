/**
 * Pure validation and encoding for descriptor-declared persistent-session
 * input, and the decoding of the session records the runner cannot read
 * without harness knowledge. This module owns the wire records and their
 * field names (ADR 0005, RFC-02 change 4); the execution layer branches
 * on the closed kinds it returns and holds no field name of its own.
 */
import type {
  HarnessDescriptor,
  SessionDelivery,
  SessionInputContract,
  SessionInputKind,
} from "../knowledge/descriptor.js";
import { SESSION_INPUT_KINDS } from "../knowledge/descriptor.js";
import { asRecord, readPath } from "./shape.js";

export type SessionInputIssue =
  | "missing-session-input-contract"
  | "unsupported-session-input-kind"
  | "unsupported-delivery"
  | "unsupported-interrupt";

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
const SEND_ID_PREFIX = `${SEND_ID}:`;
/** The JSON-RPC request id of the initialize handshake line, written
 * before the identity probe on a codex session. Its response carries
 * nothing hcn needs; the marker keeps it recognizable. */
export const INITIALIZE_ID = "hcn-initialize";
/** Issue #426: the marker prefix of a native interrupt command. The suffix
 * is the runner's internal correlation token, never a caller id. */
const INTERRUPT_ID_PREFIX = "hcn-interrupt:";

export interface SessionInputEncodingOptions {
  readonly busy: boolean;
  readonly id: string;
  readonly delivery?: SessionDelivery;
  /** Claude: the native message uuid stamped on an explicitly delivered
   * user frame, so turn records naming it correlate back to this input. */
  readonly uuid?: string;
  /** Popeye prompt frames and codex requests carry the minted session id
   * (popeye session, codex thread). */
  readonly sessionId?: string;
  /** Codex steer precondition: the tracked id of the currently running
   * native turn. A mismatch fails the request server-side, which is the
   * rejected disposition. */
  readonly activeTurnId?: string;
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

export const encodeSessionInput = (
  input: SessionInputContract,
  text: string,
  options?: SessionInputEncodingOptions,
): string => {
  switch (input.kind) {
    case "claude-sdk-user-message":
      return `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        ...(options?.delivery === undefined
          ? {}
          : { priority: options.delivery === "queue" ? "later" : "next" }),
        ...(options?.uuid === undefined ? {} : { uuid: options.uuid }),
      })}\n`;
    case "pi-rpc-prompt":
      return `${JSON.stringify({
        id: options === undefined ? SEND_ID : `${SEND_ID_PREFIX}${options.id}`,
        message: text,
        ...(options?.delivery === "queue"
          ? { streamingBehavior: "followUp" }
          : options?.delivery === "steer" || options?.busy === true
            ? { streamingBehavior: "steer" }
            : {}),
        type: "prompt",
      })}\n`;
    case "antigravity-stream-user":
      if (options?.delivery !== undefined)
        throw new SessionInputRefusalError("unsupported-delivery");
      return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
    case "popeye-rpc-prompt":
      if (options?.delivery !== undefined)
        throw new SessionInputRefusalError("unsupported-delivery");
      return `${JSON.stringify({
        _tag: "prompt",
        content: text,
        id: options === undefined ? SEND_ID : `${SEND_ID_PREFIX}${options.id}`,
        ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      })}\n`;
    case "codex-jsonrpc": {
      if (options?.delivery === "queue") throw new SessionInputRefusalError("unsupported-delivery");
      // One JSON-RPC request line per send. Idle: turn/start opens the
      // native turn. Busy: turn/steer injects into the RUNNING turn under
      // the expectedTurnId precondition (verified 0.159.2: accepted with
      // {turnId} on match; -32600 on mismatch). The request id carries the
      // hcn send id so the response settles the disposition.
      const threadId = options?.sessionId ?? "";
      return `${JSON.stringify({
        jsonrpc: "2.0",
        id: options === undefined ? SEND_ID : `${SEND_ID_PREFIX}${options.id}`,
        method: options?.busy === true ? "turn/steer" : "turn/start",
        params:
          options?.busy === true
            ? {
                threadId,
                expectedTurnId: options.activeTurnId ?? "",
                input: [{ text, type: "text" }],
              }
            : {
                threadId,
                input: [{ text, type: "text" }],
              },
      })}\n`;
    }
  }
};

/** Issue #426: the native command that requests cancellation of the active
 * turn, correlated by the runner's internal token. Pi rpc writes `abort`;
 * claude (issue #429) writes an `interrupt` control request without
 * `cancel_queued`, so queued inputs stay with the harness. Every other kind
 * refuses. */
export const encodeSessionInterrupt = (input: SessionInputContract, token: string): string => {
  const id = `${INTERRUPT_ID_PREFIX}${token}`;
  switch (input.kind) {
    case "pi-rpc-prompt":
      return `${JSON.stringify({ id, type: "abort" })}\n`;
    case "claude-sdk-user-message":
      return `${JSON.stringify({
        type: "control_request",
        request_id: id,
        request: { subtype: "interrupt" },
      })}\n`;
    default:
      throw new SessionInputRefusalError("unsupported-interrupt");
  }
};

const isClaudeSessionInput = (
  kind: SessionInputKind | undefined,
): kind is "claude-sdk-user-message" => kind === "claude-sdk-user-message";

/** Issue #429: kinds whose interrupt support is a fact about the running
 * process, not the descriptor alone. Claude advertises it per process
 * (`interrupt_receipt_v1` in system/init `capabilities`), so the runner
 * reports interrupt unsupported until a record says otherwise. */
export const requiresInterruptAdvertisement = (kind: SessionInputKind): boolean =>
  isClaudeSessionInput(kind);

/** Issue #429: what a record says about the process's interrupt support:
 * null when it says nothing (anything but a claude system/init record),
 * else whether its capability list names `interrupt_receipt_v1`. A missing
 * or malformed list grants nothing. */
export const readInterruptAdvertisement = (
  h: HarnessDescriptor,
  parsed: Record<string, unknown>,
): boolean | null => {
  if (h.sessionMode === null || !requiresInterruptAdvertisement(h.sessionMode.input.kind))
    return null;
  if (parsed.type !== "system" || parsed.subtype !== "init") return null;
  const capabilities = parsed.capabilities;
  return (
    Array.isArray(capabilities) &&
    capabilities.every((capability) => typeof capability === "string") &&
    capabilities.includes("interrupt_receipt_v1")
  );
};

/** Issue #426: the native message uuids a claude record names as the
 * inputs it answers (`user_message_uuids`, else `user_message_uuid`).
 * Turn-level records carry them (system init/status, the first
 * message_start and assistant frames, result); inner frames and background
 * task output omit them, which reads as an empty list. */
export const readInputUuids = (
  h: HarnessDescriptor,
  parsed: Record<string, unknown>,
): readonly string[] => {
  if (!isClaudeSessionInput(h.sessionMode?.input.kind)) return [];
  const many = parsed.user_message_uuids;
  if (Array.isArray(many)) return many.filter((u): u is string => typeof u === "string");
  return typeof parsed.user_message_uuid === "string" ? [parsed.user_message_uuid] : [];
};

/** What one spawn must write to learn the session id, or null when the
 * harness announces identity on its stream unprompted. pi rpc is
 * identity-silent at startup (spike fixtures); the response echoes the
 * marker id. Popeye rpc is likewise silent: the probe is a create frame,
 * and the snapshot response mints the session. Codex app-server is
 * silent AND needs a handshake: the probe is two JSON-RPC lines,
 * `initialize` (required before any other request - verified 0.159.2:
 * everything else fails with -32600 "Not initialized") then the thread
 * open named by the descriptor's identityProbe.command - thread/start for
 * a fresh session, thread/resume with the requested id when isResume. */
export const encodeIdentityProbe = (
  h: HarnessDescriptor,
  opts?: {
    readonly sessionId?: string;
    readonly isResume?: boolean;
    readonly model?: string;
    readonly clientVersion?: string;
  },
): string | null => {
  const mode = h.sessionMode;
  if (mode === null || mode.identityProbe === null) return null;
  if (mode.input.kind === "popeye-rpc-prompt")
    return `${JSON.stringify({ _tag: mode.identityProbe.command, id: IDENTITY_PROBE_ID })}\n`;
  if (mode.input.kind === "pi-rpc-prompt")
    return `${JSON.stringify({ id: IDENTITY_PROBE_ID, type: mode.identityProbe.command })}\n`;
  if (mode.input.kind !== "codex-jsonrpc") return null;
  const initialize = `${JSON.stringify({
    jsonrpc: "2.0",
    id: INITIALIZE_ID,
    method: "initialize",
    params: {
      clientInfo: { name: "hcn", version: opts?.clientVersion ?? "0" },
    },
  })}\n`;
  const open =
    opts?.isResume === true
      ? {
          jsonrpc: "2.0",
          id: IDENTITY_PROBE_ID,
          method: "thread/resume",
          params: { threadId: opts?.sessionId ?? "" },
        }
      : {
          jsonrpc: "2.0",
          id: IDENTITY_PROBE_ID,
          method: mode.identityProbe.command,
          params: {},
        };
  return `${initialize}${JSON.stringify(open)}\n`;
};

/** Kinds whose send requests are answered by a native receipt the runner
 * can correlate (pi rpc responses; codex JSON-RPC responses). The runner
 * settles the send's disposition on that receipt. */
export const hasNativeReceipts = (kind: SessionInputKind): boolean =>
  kind === "pi-rpc-prompt" || kind === "codex-jsonrpc";

/** Issue #426: kinds whose turn records name the native message uuids of
 * the inputs they answer (claude `user_message_uuids`). The runner stamps
 * a uuid on every frame and opens a queued input's turn on a record naming
 * it; a turn record naming none is output no input opened. */
export const correlatesByInputUuid = (kind: SessionInputKind): boolean =>
  isClaudeSessionInput(kind);

/** Issue #426: kinds where a written prompt can produce no run at all (pi
 * `handled`: an extension consumed it). The runner publishes such a turn
 * only on run evidence: a started receipt, run output, or a settlement. */
export const publishesTurnOnRunEvidence = (kind: SessionInputKind): boolean =>
  kind === "pi-rpc-prompt";

/** What one parsed stdout record means to a session, as a closed kind. */
export type SessionRecord =
  /** The identity probe answered with the session id. */
  | { readonly kind: "identity"; readonly sessionId: string }
  /** The identity probe answered without an id - surfaced, never silent. */
  | { readonly kind: "probe-failed"; readonly message: string }
  /** A correlated rpc command was accepted by the harness. `inputId` is the
   * correlation id the runner wrote after the send marker (its per-command
   * token), not necessarily a caller id. `nativeTurnId`
   * is present when the response names the turn it started or steered
   * into (codex turn/start {turn.id}, turn/steer {turnId}); the runner
   * tracks it as the steer precondition for the next mid-turn send. */
  | {
      readonly inputId: string;
      readonly kind: "command-accepted";
      readonly nativeTurnId?: string;
      /** pi prompt receipts name what the harness did with the input:
       * `started` a new run, `queued` joined the active run, `handled`
       * consumed it with no run (an extension command). Absent on receipts
       * that carry no disposition. */
      readonly nativeDisposition?: NativeInputDisposition;
    }
  /** Issue #426: the native interrupt command was answered. Acceptance is
   * not confirmation; the settlement record says whether a run aborted. */
  | {
      readonly kind: "interrupt-answered";
      readonly token: string;
      readonly accepted: boolean;
    }
  /** An rpc command hcn wrote was refused by the harness. */
  | { readonly inputId?: string; readonly kind: "command-failed"; readonly message: string }
  /** Protocol bookkeeping with nothing to surface. */
  | { readonly kind: "ignored" }
  /** The record that delimits a turn, with the harness's own error flag.
   * `aborted` is present when the harness reports the run was cancelled
   * (pi agent_settled.aborted true, claude result terminal_reason
   * aborted_streaming or aborted_tools). */
  | { readonly kind: "turn-end"; readonly isError: boolean; readonly aborted?: true }
  /** Anything else: content for the stream decoder. */
  | { readonly kind: "content" };

export type NativeInputDisposition = "started" | "queued" | "handled";

const nativeDispositionOf = (data: unknown): NativeInputDisposition | undefined => {
  const disposition = asRecord(data)?.disposition;
  return disposition === "started" || disposition === "queued" || disposition === "handled"
    ? disposition
    : undefined;
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
  if (mode.input.kind === "codex-jsonrpc") {
    // JSON-RPC responses carry an id; notifications carry a method.
    if (parsed.method !== undefined) {
      if (
        typeof parsed.method === "string" &&
        matchesTurnEnd(parsed, { method: mode.turnEnd.method ?? "" })
      ) {
        // turn/completed delimits the turn; params.turn.status is the
        // harness's own verdict ("completed" | "interrupted" | "failed" |
        // "inProgress").
        const params = asRecord(parsed.params);
        const turn = asRecord(params?.turn);
        const status = turn === null ? undefined : turn.status;
        return {
          kind: "turn-end",
          isError: status === "failed" || status === "interrupted",
        };
      }
      // Every other notification is content (or protocol bookkeeping the
      // content reader drops).
      return { kind: "content" };
    }
    const inputId =
      typeof parsed.id === "string" && parsed.id.startsWith(SEND_ID_PREFIX)
        ? parsed.id.slice(SEND_ID_PREFIX.length)
        : undefined;
    const error = asRecord(parsed.error);
    if (error !== null) {
      const message =
        typeof error.message === "string"
          ? `jsonrpc request failed: ${JSON.stringify(parsed.id)} - ${error.message}`
          : `jsonrpc request failed: ${JSON.stringify(error)}`;
      if (parsed.id === IDENTITY_PROBE_ID) return { kind: "probe-failed", message };
      return {
        ...(inputId === undefined ? {} : { inputId }),
        kind: "command-failed",
        message,
      };
    }
    if (parsed.id === IDENTITY_PROBE_ID) {
      const probe = mode.identityProbe;
      const announced = probe === null ? undefined : readPath(parsed, probe.responseIdField);
      return typeof announced === "string" && announced !== ""
        ? { kind: "identity", sessionId: announced }
        : { kind: "probe-failed", message: "thread open response carried no thread id" };
    }
    if (inputId !== undefined) {
      // turn/start answers {turn:{id,...}}; turn/steer answers {turnId}.
      const result = asRecord(parsed.result);
      const turn = asRecord(result?.turn);
      const nativeTurnId =
        typeof result?.turnId === "string"
          ? result.turnId
          : typeof turn?.id === "string"
            ? turn.id
            : undefined;
      return {
        inputId,
        kind: "command-accepted",
        ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
      };
    }
    // The initialize response (and any other uncorrelated response).
    return { kind: "ignored" };
  }
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
    if (
      typeof parsed.id === "string" &&
      parsed.id.startsWith(INTERRUPT_ID_PREFIX) &&
      parsed.command === "abort"
    ) {
      const token = parsed.id.slice(INTERRUPT_ID_PREFIX.length);
      return parsed.success === true
        ? { kind: "interrupt-answered", token, accepted: true }
        : {
            kind: "interrupt-answered",
            token,
            accepted: false,
          };
    }
    const inputId =
      typeof parsed.id === "string" && parsed.id.startsWith(SEND_ID_PREFIX)
        ? parsed.id.slice(SEND_ID_PREFIX.length)
        : undefined;
    if (parsed.command === "prompt" && parsed.success === true && inputId !== undefined) {
      const nativeDisposition = nativeDispositionOf(parsed.data);
      return {
        inputId,
        kind: "command-accepted",
        ...(nativeDisposition === undefined ? {} : { nativeDisposition }),
      };
    }
    // A failed command is a surfaced error, never a silent drop.
    if (parsed.success === false) {
      return {
        ...(inputId === undefined ? {} : { inputId }),
        kind: "command-failed",
        message: `rpc command failed: ${JSON.stringify(parsed.command)} - ${JSON.stringify(parsed.error ?? "unknown error")}`,
      };
    }
    return { kind: "ignored" };
  }
  if (mode.input.kind === "popeye-rpc-prompt") {
    const result = asRecord(parsed.result);
    const error = asRecord(parsed.error);
    if (error !== null || (result === null && parsed.id !== undefined)) {
      const inputId =
        typeof parsed.id === "string" && parsed.id.startsWith(SEND_ID_PREFIX)
          ? parsed.id.slice(SEND_ID_PREFIX.length)
          : undefined;
      // The identity probe answered with an error: route through
      // probe-failed so the runner's #345 arm can settle buffered sends
      // and set the session-scoped failure, the way it does for codex.
      if (parsed.id === IDENTITY_PROBE_ID) {
        const message =
          error !== null && typeof error.message === "string"
            ? `rpc command failed: ${JSON.stringify(parsed.id)} - ${error.message}`
            : `rpc command failed: ${JSON.stringify(error ?? parsed)}`;
        return { kind: "probe-failed", message };
      }
      return {
        ...(inputId === undefined ? {} : { inputId }),
        kind: "command-failed",
        message: `rpc command failed: ${JSON.stringify(error ?? parsed)}`,
      };
    }
    if (result !== null && result._tag === "snapshot") {
      const probe = mode.identityProbe;
      const announced = probe === null ? undefined : readPath(parsed, probe.responseIdField);
      if (parsed.id === IDENTITY_PROBE_ID) {
        return typeof announced === "string"
          ? { kind: "identity", sessionId: announced }
          : { kind: "probe-failed", message: "create response carried no sessionId" };
      }
      // A prompt response carries the settled snapshot: the turn is over
      // in the same record (no native receipt; the send settled at write).
      // A trailing error/aborted assistant entry marks the turn failed.
      const entries = Array.isArray(result.entries) ? result.entries : [];
      const reasons = entries.flatMap((line) => {
        const entry = asRecord(line);
        const payload = asRecord(entry?.payload);
        return entry?.kind === "message" && payload?.role === "assistant"
          ? [payload.stopReason]
          : [];
      });
      const lastReason = reasons.at(-1);
      return { kind: "turn-end", isError: lastReason === "error" || lastReason === "aborted" };
    }
    return { kind: "content" };
  }
  if (isClaudeSessionInput(mode.input.kind) && parsed.type === "control_response") {
    // Issue #429: only an answer bearing the interrupt marker is one; the
    // receipt's still_queued list is the harness's queue, never read here.
    const response = asRecord(parsed.response);
    const requestId = response?.request_id;
    if (typeof requestId === "string" && requestId.startsWith(INTERRUPT_ID_PREFIX)) {
      const token = requestId.slice(INTERRUPT_ID_PREFIX.length);
      return response?.subtype === "success"
        ? { kind: "interrupt-answered", token, accepted: true }
        : {
            kind: "interrupt-answered",
            token,
            accepted: false,
          };
    }
    return { kind: "ignored" };
  }
  if (matchesTurnEnd(parsed, mode.turnEnd)) {
    // Issue #429: a claude result ended by an interrupt is the native
    // confirmation of cancellation, with no error of its own.
    if (
      isClaudeSessionInput(mode.input.kind) &&
      (parsed.terminal_reason === "aborted_streaming" || parsed.terminal_reason === "aborted_tools")
    ) {
      return { kind: "turn-end", isError: false, aborted: true };
    }
    // claude's result record carries is_error; pi's agent_settled has no
    // error flag of its own.
    const isError =
      (isClaudeSessionInput(mode.input.kind) && parsed.is_error === true) ||
      (mode.input.kind === "antigravity-stream-user" &&
        readPath(parsed, "result.status") !== "SUCCESS");
    return mode.input.kind === "pi-rpc-prompt" && parsed.aborted === true
      ? { kind: "turn-end", isError, aborted: true }
      : { kind: "turn-end", isError };
  }
  return { kind: "content" };
};
