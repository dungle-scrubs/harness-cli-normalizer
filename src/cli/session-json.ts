/**
 * The machine session surface: `hcn session <h> --json`. Two pumps over one
 * persistent session - stdin NDJSON commands in, stdout NDJSON events out -
 * with the control events (`session`, `turn`, `disposition`, `closed`) that
 * a program needs to drive a session it does not own the timing of. RFC-01.
 *
 * This owns the wire framing only. The turn lifecycle and the id
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
import { composeAnswer, type QuestionMode } from "../interpretation/question.js";
import { SESSION_DELIVERIES, type SessionDelivery } from "../knowledge/descriptor.js";

/** Captured from `session_close`: a refused session open (#345) or a crash
 * with no open turn (#347) leaves a session failure for `closed` to carry. */
export interface CloseInfo {
  exitCode: number | null;
  cause: string;
  failure?: FailureSummary;
}

export type SessionOrigin = "fresh" | "resumed";

export interface JsonSessionArgs {
  readonly handle: SessionHandle;
  readonly sessionId: string;
  readonly harness: string;
  readonly hcnVersion: string;
  readonly questions?: QuestionMode;
  readonly origin: SessionOrigin;
  /** Read after close - the runner's final exitCode and cause. */
  readonly getCloseInfo: () => CloseInfo;
  /** Read after close - ids the runner accepted and never
   * delivered. Each owes the consumer a rejection (RFC S003). */
  readonly getDroppedIds?: () => readonly string[];
  /** Injected for tests; defaults to process.stdin / process.stdout. */
  readonly input?: NodeJS.ReadableStream;
  readonly write?: (line: string) => boolean;
  readonly onDrain?: (fn: () => void) => void;
}

type ParsedCommand =
  | {
      readonly op: "send" | "answer";
      readonly id: string;
      readonly text: string;
      readonly delivery?: SessionDelivery;
    }
  | { readonly op: "interrupt"; readonly id: string }
  | { readonly op: "close" }
  | { readonly malformed: string };

/** One send/answer's answer on the wire: the runner's disposition, or the
 * CLI's own refusal of an answer with no open question. */
type Disposition = {
  readonly disposition: SessionSendResult["disposition"];
  readonly reason?: SessionSendResult["reason"] | "no-open-question";
};

const isSessionDelivery = (value: unknown): value is SessionDelivery =>
  SESSION_DELIVERIES.some((delivery) => delivery === value);

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
    // Issue #426: an unknown or mistyped mode is a malformed command, never
    // a silent fallback to the native default.
    if ("delivery" in rec && !isSessionDelivery(rec.delivery)) {
      return { malformed: `delivery must be one of ${SESSION_DELIVERIES.join(", ")}` };
    }
    return {
      op: rec.op,
      id: rec.id,
      text: rec.text,
      ...(isSessionDelivery(rec.delivery) ? { delivery: rec.delivery } : {}),
    };
  }
  if (rec.op === "interrupt") {
    if (typeof rec.id !== "string" || rec.id === "") return { malformed: "missing or empty id" };
    // The caller keeps replacement text and sends it after the receipt.
    if ("text" in rec) return { malformed: "interrupt carries no text; send it after the receipt" };
    return { op: "interrupt", id: rec.id };
  }
  return { malformed: `unknown op ${JSON.stringify(rec.op)}` };
};

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
    origin: a.origin,
    // Issue #426: the explicit delivery modes and interrupt support this
    // session accepts, read once before the first command. Issue #429: on
    // claude this is the state before the process advertised anything; later
    // changes ride the identity event's capabilities.sessionControls.
    controls: a.handle.controls,
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
  // Commands accepted from stdin but not yet answered with a disposition,
  // by command position (caller ids may repeat). If the command stream
  // itself fails, each is owed one: silence would leave the consumer
  // waiting on an answer that can no longer arrive.
  const unanswered = new Map<number, string>();
  let commandIndex = 0;
  // Issue #426: a native receipt can take a while, and the command stream
  // keeps being read meanwhile so an interrupt or close still reaches the
  // session. Dispositions still leave in command order: each waits for its
  // own receipt and for every earlier disposition.
  let dispositionChain: Promise<void> = Promise.resolve();
  let dispositionsInFlight = 0;
  const receipts = new Set<Promise<void>>();
  const dispositionOf = (id: string, sent: Disposition) => ({
    kind: "disposition",
    id,
    disposition: sent.disposition,
    ...(sent.reason !== undefined ? { reason: sent.reason } : {}),
  });
  const answerCommand = async (
    id: string,
    outcome: Disposition | Promise<Disposition>,
  ): Promise<void> => {
    if (!(outcome instanceof Promise) && dispositionsInFlight === 0) {
      await emit(dispositionOf(id, outcome));
      return;
    }
    const index = ++commandIndex;
    unanswered.set(index, id);
    dispositionsInFlight++;
    const prior = dispositionChain;
    dispositionChain = (async () => {
      let sent: Disposition;
      try {
        sent = await outcome;
      } catch {
        sent = { disposition: "rejected", reason: "closed" };
      }
      await prior;
      dispositionsInFlight--;
      if (!unanswered.delete(index)) return;
      await emit(dispositionOf(id, sent));
    })();
  };
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
      if (cmd.op === "interrupt") {
        const id = cmd.id;
        const requested = a.handle.interrupt({ id });
        if (requested.state === "rejected") {
          await emit({ kind: "interruption", id, state: "rejected", reason: requested.reason });
          continue;
        }
        // Two phases: the request is on the wire now; the terminal receipt
        // follows the harness's own settlement.
        await emit({ kind: "interruption", id, state: "requested" });
        const receipt = requested.settled.then((settled) =>
          emit({
            kind: "interruption",
            id,
            state: settled.state,
            ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
          }),
        );
        receipts.add(receipt);
        continue;
      }
      let text = cmd.text;
      if (cmd.op === "answer") {
        if (!awaitingAnswer) {
          await answerCommand(cmd.id, { disposition: "rejected", reason: "no-open-question" });
          continue;
        }
        text = composeAnswer(lastQuestion, cmd.text);
      }
      let sent: SessionSendResult;
      try {
        sent = a.handle.send({
          id: cmd.id,
          text,
          ...(cmd.delivery === undefined ? {} : { delivery: cmd.delivery }),
        });
      } catch (err) {
        // A session the caller already closed, or one already dead: a
        // different remedy from a broken pipe, so a different reason.
        if (err instanceof SessionClosedError) {
          await answerCommand(cmd.id, { disposition: "rejected", reason: "closed" });
          continue;
        }
        throw err;
      }
      await answerCommand(cmd.id, sent.settled ?? sent);
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
  // The closed session settled every outstanding receipt; each disposition
  // and interruption receipt leaves before the terminal line.
  await dispositionChain;
  await Promise.allSettled([...receipts]);

  // A broken command stream is a fact the consumer needs, and every send it
  // swallowed is owed its answer.
  if (stdinError !== null) {
    await emit({ kind: "error", message: `command stream failed: ${stdinError}` });
  }
  for (const id of unanswered.values()) {
    await emit({ kind: "disposition", id, disposition: "rejected", reason: "closed" });
  }
  unanswered.clear();

  // Every input the runner accepted and then lost gets its own
  // rejection, before the terminal line (RFC S003).
  for (const id of a.getDroppedIds?.() ?? []) {
    await emit({ kind: "disposition", id, disposition: "rejected", reason: "closed" });
  }

  const info = a.getCloseInfo();
  // The session failure wins over the last turn failure.
  const failure: FailureSummary | undefined = info.failure ?? lastFailure;
  await emit({
    kind: "closed",
    exitCode: info.exitCode,
    cause: info.cause,
    ...(info.cause !== "clean" && failure !== undefined ? { failure } : {}),
  });
  // A consumer that stopped reading gets exit 1 even on a clean harness exit:
  // the session did not end the way the consumer asked for.
  if (consumerGone) return 1;
  return info.cause === "clean" ? 0 : 1;
};
