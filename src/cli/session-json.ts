/**
 * The machine session surface: `hcn session <h> --json`. Two pumps over one
 * persistent session - stdin NDJSON commands in, stdout NDJSON events out -
 * with the control events (`session`, `turn`, `disposition`, `closed`) that
 * a program needs to drive a session it does not own the timing of. RFC-01.
 *
 * This owns the wire framing only. The turn lifecycle, the queue, and the id
 * correlation live in `openSession`; this reads the id off the yielded turn
 * rather than shadowing the runner's delivery order.
 */
import { createInterface } from "node:readline/promises";
import type { HarnessEvent } from "../execution/events.js";
import type { FailureSummary } from "../execution/failure.js";
import {
  SessionClosedError,
  type SessionHandle,
  type SessionSendResult,
} from "../execution/open-session.js";

/** What the CLI reads back after a close, captured from the runner's
 * `session_close` boundary log. */
export interface CloseInfo {
  exitCode: number | null;
  cause: string;
}

export interface JsonSessionArgs {
  readonly handle: SessionHandle;
  readonly sessionId: string;
  readonly harness: string;
  readonly hcnVersion: string;
  readonly escalateQuestions: boolean;
  /** Read after close - the runner's final exitCode and cause. */
  readonly getCloseInfo: () => CloseInfo;
  /** Injected for tests; defaults to process.stdin / process.stdout. */
  readonly input?: NodeJS.ReadableStream;
  readonly write?: (line: string) => boolean;
  readonly onDrain?: (fn: () => void) => void;
}

type ParsedCommand =
  | { readonly op: "send" | "answer"; readonly id: string; readonly text: string }
  | { readonly op: "close" }
  | { readonly malformed: string };

const parseCommand = (line: string): ParsedCommand => {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { malformed: "not JSON" };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { malformed: "not an object" };
  }
  const rec = obj as Record<string, unknown>;
  if (rec.op === "close") return { op: "close" };
  if (rec.op === "send" || rec.op === "answer") {
    if (typeof rec.id !== "string" || rec.id === "") return { malformed: "missing or empty id" };
    if (typeof rec.text !== "string") return { malformed: "text must be a string" };
    return { op: rec.op, id: rec.id, text: rec.text };
  }
  return { malformed: `unknown op ${JSON.stringify(rec.op)}` };
};

/** The answer wrapper hcn composes so a consumer never re-derives it
 * (RFC-01: the preamble is normalizer knowledge). */
const composeAnswer = (question: string, answer: string): string =>
  `The user answered the question: "${question}" with: ${answer}. Continue accordingly.`;

export const runJsonSession = async (a: JsonSessionArgs): Promise<number> => {
  const rawWrite = a.write ?? ((line: string) => process.stdout.write(line));
  const onDrain = a.onDrain ?? ((fn: () => void) => process.stdout.once("drain", fn));

  // One serialized, drain-aware writer for both pumps: stdout never
  // interleaves two events and never buffers past the OS pipe.
  let chain: Promise<void> = Promise.resolve();
  const emit = (event: unknown): Promise<void> => {
    chain = chain.then(
      () =>
        new Promise<void>((resolve) => {
          if (rawWrite(`${JSON.stringify(event)}\n`)) resolve();
          else onDrain(resolve);
        }),
    );
    return chain;
  };

  await emit({
    kind: "session",
    sessionId: a.sessionId,
    harness: a.harness,
    hcn: a.hcnVersion,
    escalateQuestions: a.escalateQuestions,
  });

  // Shared between the pumps: the last question asked, whether the last turn
  // ended awaiting an answer, and the last failure seen (for closed.failure).
  let lastQuestion = "";
  let awaitingAnswer = false;
  let lastFailure: FailureSummary | undefined;

  const stdoutPump = (async () => {
    for await (const turn of a.handle.turns) {
      awaitingAnswer = false;
      await emit({
        kind: "turn",
        turnId: turn.turnId,
        ...(turn.inputId !== undefined ? { id: turn.inputId } : {}),
      });
      for await (const ev of turn as AsyncIterable<HarnessEvent>) {
        if (ev.kind === "question") lastQuestion = ev.question;
        await emit(ev);
        if (ev.kind === "done") {
          awaitingAnswer = ev.cause === "awaiting-input";
          if (ev.failure !== undefined) lastFailure = ev.failure;
        }
        if (ev.kind === "failure") lastFailure = ev;
      }
    }
  })();

  const rl = createInterface({ input: a.input ?? process.stdin });
  const stdinPump = (async () => {
    for await (const line of rl) {
      if (line.trim() === "") continue;
      const cmd = parseCommand(line);
      if ("malformed" in cmd) {
        await emit({ kind: "error", message: `malformed command: ${cmd.malformed}` });
        continue;
      }
      if (cmd.op === "close") return;
      let text = cmd.text;
      if (cmd.op === "answer") {
        if (!awaitingAnswer) {
          await emit({
            kind: "disposition",
            id: cmd.id,
            disposition: "rejected",
            reason: "no-open-question",
          });
          continue;
        }
        text = composeAnswer(lastQuestion, cmd.text);
      }
      let sent: SessionSendResult;
      try {
        sent = a.handle.send({ id: cmd.id, text });
      } catch (err) {
        // A session the caller already closed, or one already dead: a
        // different remedy from a broken pipe, so a different reason.
        if (err instanceof SessionClosedError) {
          await emit({
            kind: "disposition",
            id: cmd.id,
            disposition: "rejected",
            reason: "closed",
          });
          continue;
        }
        throw err;
      }
      await emit({
        kind: "disposition",
        id: cmd.id,
        disposition: sent.disposition,
        ...(sent.reason !== undefined ? { reason: sent.reason } : {}),
      });
    }
  })();

  // Whichever ends first drives the close: a close/EOF from stdin, or the
  // session dying (the turns iterable ends). close() is idempotent; closing
  // the readline unblocks the stdin pump if the session died first.
  await Promise.race([stdinPump, stdoutPump]);
  await a.handle.close();
  rl.close();
  await Promise.allSettled([stdinPump, stdoutPump]);

  const info = a.getCloseInfo();
  await emit({
    kind: "closed",
    exitCode: info.exitCode,
    cause: info.cause,
    ...(info.cause !== "clean" && lastFailure !== undefined ? { failure: lastFailure } : {}),
  });
  return info.cause === "clean" ? 0 : 1;
};
