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
import type { FailureSummary } from "../execution/failure.js";
import type {
  SessionHandle,
  SessionInterruptReceipt,
  SessionInterruptResult,
  SessionSendResult,
  SessionStopBackgroundReceipt,
  SessionStopBackgroundResult,
} from "../execution/open-session.js";
import { SessionClosedError } from "../execution/open-session.js";
import type { SessionApprovalDecisionRequest } from "../execution/session-approval-tracker.js";
import type { SessionSettingsRequest } from "../execution/session-settings-sequencer.js";
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
      readonly verbatim?: boolean;
    }
  | { readonly op: "interrupt"; readonly id: string }
  | { readonly op: "stop-background"; readonly id: string; readonly job: string }
  | (SessionApprovalDecisionRequest & { readonly op: "approval" })
  | (SessionSettingsRequest & { readonly op: "settings" })
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
    // Issue #456: verbatim is a send-only boolean - how a host types a
    // slash command with no question preamble around it. `answer` carries
    // no verbatim at all: `false` is as malformed as `true`, because the
    // op has no such field to withhold (review round 1, F7).
    if ("verbatim" in rec && typeof rec.verbatim !== "boolean")
      return { malformed: "verbatim must be a boolean" };
    if (rec.op === "answer" && "verbatim" in rec)
      return { malformed: "answer carries no verbatim; compose the reply yourself" };
    return {
      op: rec.op,
      id: rec.id,
      text: rec.text,
      ...(isSessionDelivery(rec.delivery) ? { delivery: rec.delivery } : {}),
      ...(rec.verbatim === true ? { verbatim: true } : {}),
    };
  }
  if (rec.op === "interrupt") {
    if (typeof rec.id !== "string" || rec.id === "") return { malformed: "missing or empty id" };
    // The caller keeps replacement text and sends it after the receipt.
    if ("text" in rec) return { malformed: "interrupt carries no text; send it after the receipt" };
    return { op: "interrupt", id: rec.id };
  }
  // Stop one background job, named by the id its `background` events
  // carry. A missing id or job is malformed like any other command.
  if (rec.op === "stop-background") {
    if (typeof rec.id !== "string" || rec.id === "") return { malformed: "missing or empty id" };
    if (typeof rec.job !== "string" || rec.job === "") return { malformed: "missing or empty job" };
    return { op: "stop-background", id: rec.id, job: rec.job };
  }
  // Issue #454/#455: one decision on a forwarded permission request.
  // Structural failures are malformed like any other command; semantic
  // ones (unknown request, unknown choice) are answered by the runner
  // with a rejected approval-disposition.
  if (rec.op === "approval") {
    if (rec.v !== 1) return { malformed: "approval requires v:1" };
    if (typeof rec.id !== "string" || rec.id === "") return { malformed: "missing or empty id" };
    if (typeof rec.requestId !== "string" || rec.requestId === "")
      return { malformed: "missing or empty requestId" };
    if (typeof rec.choiceId !== "string" || rec.choiceId === "")
      return { malformed: "missing or empty choiceId" };
    if (rec.message !== undefined && typeof rec.message !== "string")
      return { malformed: "message must be a string" };
    if (rec.answers !== undefined) {
      const answers = rec.answers as unknown;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers))
        return { malformed: "answers must be an object keyed by question text" };
      for (const value of Object.values(answers as Record<string, unknown>)) {
        const valid =
          (typeof value === "string" && value !== "") ||
          (Array.isArray(value) &&
            value.length > 0 &&
            value.every((label) => typeof label === "string" && label !== ""));
        if (!valid)
          return { malformed: "answers values must be a label or a non-empty array of labels" };
      }
    }
    return {
      op: "approval",
      id: rec.id,
      requestId: rec.requestId,
      choiceId: rec.choiceId,
      ...(rec.message === undefined ? {} : { message: rec.message }),
      ...(rec.answers === undefined
        ? {}
        : { answers: rec.answers as Record<string, string | readonly string[]> }),
    };
  }
  // Issue #456: change the model and/or effort of the session. At least
  // one of the two, each a non-empty string; anything else is a malformed
  // command, not a rejected receipt (there is nothing to reject).
  if (rec.op === "settings") {
    if (typeof rec.id !== "string" || rec.id === "") return { malformed: "missing or empty id" };
    if (rec.model !== undefined && (typeof rec.model !== "string" || rec.model === ""))
      return { malformed: "model must be a non-empty string" };
    if (rec.effort !== undefined && (typeof rec.effort !== "string" || rec.effort === ""))
      return { malformed: "effort must be a non-empty string" };
    if (rec.model === undefined && rec.effort === undefined)
      return { malformed: "settings needs model, effort, or both" };
    return {
      op: "settings",
      id: rec.id,
      ...(rec.model === undefined ? {} : { model: rec.model }),
      ...(rec.effort === undefined ? {} : { effort: rec.effort }),
    };
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
      if ("kind" in turn) {
        await emit(turn);
        continue;
      }
      awaitingAnswer = false;
      await emit({
        kind: "turn",
        turnId: turn.turnId,
        ...(turn.inputId !== undefined ? { id: turn.inputId } : {}),
      });
      for await (const ev of turn) {
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
  // Receipts still owed (interrupt settlements, settings ops). Each is
  // removed the moment it settles, so the set holds only outstanding
  // work - never the whole session's history (review round 1, F13; the
  // interrupt receipts were the pre-existing half of that leak).
  const receipts = new Set<Promise<void>>();
  const trackReceipt = (receipt: Promise<void>): void => {
    receipts.add(receipt);
    void receipt.then(() => {
      receipts.delete(receipt);
    });
  };
  const dispositionOf = (id: string, sent: Disposition) => ({
    kind: "disposition",
    id,
    disposition: sent.disposition,
    ...(sent.reason !== undefined ? { reason: sent.reason } : {}),
  });
  /** The two-phase receipt framing an interrupt and a stop-background
   * share (review round 1): the immediate line - `requested` once the
   * request is on the wire, or the refusal with its reason and no
   * `requested` phase - then exactly one terminal receipt, tracked so the
   * close waits for it. Only the event kind and the op call differ; each
   * control's settlement semantics stay in the runner. */
  const twoPhaseReceipt = (
    kind: "interruption" | "background-stop",
    id: string,
    requested: SessionInterruptResult | SessionStopBackgroundResult,
  ): Promise<void> => {
    const line = (state: {
      readonly state:
        | SessionInterruptResult["state"]
        | SessionStopBackgroundResult["state"]
        | SessionInterruptReceipt["state"]
        | SessionStopBackgroundReceipt["state"];
      readonly reason?: SessionInterruptReceipt["reason"] | SessionStopBackgroundReceipt["reason"];
    }) => ({
      kind,
      id,
      state: state.state,
      ...(state.reason !== undefined ? { reason: state.reason } : {}),
    });
    if (requested.state === "rejected") return emit(line(requested));
    const written = emit(line({ state: "requested" }));
    trackReceipt(requested.settled.then((settled) => emit(line(settled))));
    return written;
  };
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
        await twoPhaseReceipt("interruption", cmd.id, a.handle.interrupt({ id: cmd.id }));
        continue;
      }
      if (cmd.op === "stop-background") {
        // Same two-phase shape as an interrupt. `sent` names only acceptance
        // of the stop request - the job's own end arrives as a `background`
        // event, inside a turn or as a bare between-turn line.
        await twoPhaseReceipt(
          "background-stop",
          cmd.id,
          a.handle.stopBackground({ id: cmd.id, job: cmd.job }),
        );
        continue;
      }
      if (cmd.op === "approval") {
        // Issue #454/#455: exactly one disposition per decision, emitted
        // directly like the other command receipts - the request events it
        // answers ride inside the turn stream instead.
        const answered = a.handle.answerApproval(cmd);
        await emit({
          kind: "approval-disposition",
          v: 1,
          id: cmd.id,
          requestId: cmd.requestId,
          status: answered.status,
          ...(answered.status === "rejected" ? { reason: answered.reason } : {}),
        });
        continue;
      }
      if (cmd.op === "settings") {
        // Issue #456: exactly one receipt per well-formed op, emitted as it
        // settles; the command stream keeps flowing while the harness
        // answers, so an interrupt behind a settings op is not blocked.
        // A readback the op could not confirm (review round 3, H2) carries
        // its diagnostic here on the control output immediately - never
        // parked for a turn that may never come. The diagnostic is
        // scheduled WITH its receipt (both joins the write chain before
        // either is awaited): a later op that settles inside this
        // receipt's drain cannot slip its own writes between them
        // (review round 4, J3).
        const receipt = a.handle.settings(cmd);
        trackReceipt(
          receipt.then(async (settled) => {
            const receiptWrite = emit({ kind: "settings", id: cmd.id, ...settled });
            const diagnosticWrite =
              settled.unconfirmed !== undefined && settled.unconfirmed.length > 0
                ? emit({
                    kind: "error",
                    message: `settings op ${JSON.stringify(cmd.id)}: state readback failed; unconfirmed: ${settled.unconfirmed.join(", ")}`,
                  })
                : undefined;
            await receiptWrite;
            await diagnosticWrite;
          }),
        );
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
          ...(cmd.verbatim === undefined ? {} : { verbatim: cmd.verbatim }),
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
