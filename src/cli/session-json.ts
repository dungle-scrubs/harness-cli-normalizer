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
import type { QuestionMode } from "../interpretation/question.js";

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
  readonly questions?: QuestionMode;
  /** Read after close - the runner's final exitCode and cause. */
  readonly getCloseInfo: () => CloseInfo;
  /** Read after close - ids the runner accepted as queued and never
   * delivered. Each owes the consumer a rejection (RFC S003). */
  readonly getDroppedIds?: () => readonly string[];
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

  // The consumer's read end can close mid-session (it died, or it stopped
  // reading). The process-wide EPIPE guard in index.ts exits 0 immediately,
  // which would strand the harness child with nobody to end it. For a
  // machine session the right answer is to close the session - grace, then
  // signal - and exit 1. Replacing the listener is deliberate: the global
  // one runs first otherwise and the process is gone before we act.
  let consumerGone = false;
  if (a.write === undefined) {
    process.stdout.removeAllListeners("error");
    process.stdout.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") return;
      consumerGone = true;
      void a.handle.close();
    });
  }

  // One serialized, drain-aware writer for both pumps: stdout never
  // interleaves two events and never buffers past the OS pipe.
  let chain: Promise<void> = Promise.resolve();
  const emit = (event: unknown): Promise<void> => {
    chain = chain.then(
      () =>
        new Promise<void>((resolve) => {
          // A broken stdout never drains. Writing into it would park this
          // chain forever and the session would hang instead of closing.
          if (consumerGone) {
            resolve();
            return;
          }
          try {
            if (rawWrite(`${JSON.stringify(event)}\n`)) resolve();
            else onDrain(resolve);
          } catch {
            consumerGone = true;
            resolve();
          }
        }),
    );
    return chain;
  };

  const qMode: QuestionMode = a.questions ?? "ask";
  await emit({
    kind: "session",
    sessionId: a.sessionId,
    harness: a.harness,
    hcn: a.hcnVersion,
    questions: qMode,
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
        // Update the answer state BEFORE the event reaches the consumer. A
        // consumer answers the moment it reads `done`, so setting this after
        // the emit leaves a window where a valid answer is refused.
        if (ev.kind === "question") lastQuestion = ev.question;
        if (ev.kind === "done") {
          awaitingAnswer = ev.cause === "awaiting-input";
          if (ev.failure !== undefined) lastFailure = ev.failure;
        }
        if (ev.kind === "failure") lastFailure = ev;
        await emit(ev);
      }
    }
  })();

  const rl = createInterface({ input: a.input ?? process.stdin });
  // Ids accepted from stdin but not yet answered with a disposition. If the
  // command stream itself fails, each is owed one: silence would leave the
  // consumer waiting on an answer that can no longer arrive.
  const unanswered = new Set<string>();
  let stdinError: string | null = null;
  const commandStream = (a.input ?? process.stdin) as {
    on?: (event: string, listener: (err: NodeJS.ErrnoException) => void) => unknown;
  };
  commandStream.on?.("error", (err) => {
    stdinError = err.code ?? err.message;
  });
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
      unanswered.add(cmd.id);
      try {
        sent = a.handle.send({ id: cmd.id, text });
      } catch (err) {
        // A session the caller already closed, or one already dead: a
        // different remedy from a broken pipe, so a different reason.
        if (err instanceof SessionClosedError) {
          unanswered.delete(cmd.id);
          await emit({
            kind: "disposition",
            id: cmd.id,
            disposition: "rejected",
            reason: "closed",
          });
          continue;
        }
        unanswered.delete(cmd.id);
        throw err;
      }
      unanswered.delete(cmd.id);
      await emit({
        kind: "disposition",
        id: cmd.id,
        disposition: sent.disposition,
        ...(sent.reason !== undefined ? { reason: sent.reason } : {}),
      });
    }
  })();
  // A command stream that breaks is not a clean end of input, but it is also
  // not a crash of this process: record it and close the session in order.
  // The caught form is what the race waits on - the raw pump would reject
  // straight out of runJsonSession.
  const stdinDone = stdinPump.catch((err: unknown) => {
    stdinError = err instanceof Error ? err.message : String(err);
  });

  // Whichever ends first drives the close: a close/EOF from stdin, or the
  // session dying (the turns iterable ends). close() is idempotent; closing
  // the readline unblocks the stdin pump if the session died first.
  await Promise.race([stdinDone, stdoutPump]);
  await a.handle.close();
  rl.close();
  await Promise.allSettled([stdinDone, stdoutPump]);

  // A broken command stream is a fact the consumer needs, and every send it
  // swallowed is owed its answer.
  if (stdinError !== null) {
    await emit({ kind: "error", message: `command stream failed: ${stdinError}` });
  }
  for (const id of unanswered) {
    await emit({ kind: "disposition", id, disposition: "rejected", reason: "closed" });
  }
  unanswered.clear();

  // Every input the runner accepted as queued and then lost gets its own
  // rejection, before the terminal line (RFC S003).
  for (const id of a.getDroppedIds?.() ?? []) {
    await emit({ kind: "disposition", id, disposition: "rejected", reason: "closed" });
  }

  const info = a.getCloseInfo();
  await emit({
    kind: "closed",
    exitCode: info.exitCode,
    cause: info.cause,
    ...(info.cause !== "clean" && lastFailure !== undefined ? { failure: lastFailure } : {}),
  });
  // A consumer that stopped reading gets exit 1 even on a clean harness exit:
  // the session did not end the way the consumer asked for.
  if (consumerGone) return 1;
  return info.cause === "clean" ? 0 : 1;
};
