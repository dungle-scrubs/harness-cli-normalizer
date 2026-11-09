/**
 * The interactive REPL both entry points share (`hcn session` without
 * --json, and `bun run demo --chat`). One consumer renders every item of
 * handle.turns - bare events, turns a send opened, turns no send opened -
 * and the prompt logic never waits for "the turn this send opened": after a
 * send, the REPL waits until the next turn that ENDS after the send was
 * written finishes (tagged or not) - a send Claude merges into a running
 * turn ends with that turn - then shows the prompt again. Output that
 * arrives while the prompt shows clears the line, renders and redraws the
 * prompt. A turn that ends awaiting input (tagged or not) shows the answer
 * prompt; the choice (or a custom answer) is the next send on the same
 * live session.
 */
import { clearLine, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { HarnessEvent } from "../execution/events.js";
import type { SessionHandle, SessionTurn } from "../execution/open-session.js";
import { CLOSE_GRACE_MS, isSessionTurn } from "../execution/open-session.js";
import { composeAnswer } from "../interpretation/question.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { createRenderState, renderEvent } from "./render.js";

type QuestionEvent = Extract<HarnessEvent, { kind: "question" }>;

export const runInteractiveSession = async (
  h: HarnessDescriptor,
  sessionId: string,
  handle: SessionHandle,
): Promise<void> => {
  process.stdout.write(
    `interactive ${h.name} session ${sessionId}\n(empty line or "exit" to quit)\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // One line source for BOTH the you-prompt and the answer menu. A
  // readline interface buffers at most one pending line per question()
  // call site; the answer line typically arrives while the interface sits
  // BETWEEN calls (the turn is still streaming), and those bytes were
  // dropped (verified live: menu rendered, buffered "2" never delivered).
  // An explicit async-iterator pull never drops: the iterator parks on the
  // stream until the next line exists, whenever the caller asks for it.
  const lines = rl[Symbol.asyncIterator]();
  let awaitingLine = false;
  const nextLine = async (prompt: string): Promise<string | null> => {
    rl.setPrompt(prompt);
    awaitingLine = true;
    rl.prompt();
    try {
      const res = await lines.next();
      return res.done ? null : (res.value as string);
    } finally {
      awaitingLine = false;
    }
  };
  const startIdleOutput = (): void => {
    if (process.stdout.isTTY) {
      cursorTo(process.stdout, 0);
      clearLine(process.stdout, 0);
    } else {
      process.stdout.write("\n");
    }
  };
  const redrawPrompt = (): void => {
    if (awaitingLine) {
      process.stdout.write("\n");
      rl.prompt(true);
    }
  };

  // The question whose menu is on screen, awaiting its answer line, and
  // the ones that arrived mid-answer (a question never preempts a question
  // already being answered; it queues and is offered next). Both mutate
  // across awaits (the pump writes them), so the main loop reads them
  // through accessors, not narrowed locals.
  let onScreen: QuestionEvent | null = null;
  const queued: QuestionEvent[] = [];
  const questionOnScreen = (): QuestionEvent | null => onScreen;
  const presentQuestion = (q: QuestionEvent): void => {
    onScreen = q;
    process.stdout.write(`\nanswer › pick a number, or type your own answer:\n`);
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i] as string;
      const mark = opt === q.recommended ? " (recommended)" : "";
      process.stdout.write(`  ${i + 1}. ${opt}${mark}\n`);
    }
    // The user's parked line pull stays the one source; only the prompt
    // it renders switches to the answer.
    if (awaitingLine) {
      rl.setPrompt("> ");
      rl.prompt(true);
    }
  };

  /** One drain for every turn, whatever opened it: renders the events and
   * returns the question the turn ended asking, if any. */
  const renderTurn = async (turn: SessionTurn): Promise<QuestionEvent | null> => {
    const state = createRenderState();
    let asked: QuestionEvent | null = null;
    for await (const event of turn) {
      renderEvent(event, state, h);
      if (event.kind === "question") asked = event;
    }
    return asked;
  };

  // The reply wait: released by the next turn that ends after the send
  // was written - a turn that opened before the send and ends after it
  // releases it too, which is what a send Claude merges into a running
  // turn needs - with the question that turn ended asking (or null);
  // undefined once the stream closed. Arming the waiter and writing the
  // send are one synchronous block, so no turn end can land between them.
  let replyWaiter: ((asked: QuestionEvent | null | undefined) => void) | null = null;
  const pendingReply = (): ((asked: QuestionEvent | null | undefined) => void) | null =>
    replyWaiter;
  let sendCount = 0;
  const sendAndWait = (text: string): Promise<QuestionEvent | null | undefined> => {
    let settle!: (asked: QuestionEvent | null | undefined) => void;
    const settled = new Promise<QuestionEvent | null | undefined>((resolve) => {
      settle = resolve;
    });
    replyWaiter = settle;
    handle.send({ id: `you-${++sendCount}`, text });
    return settled;
  };

  // The one consumer of handle.turns. Bare events render at once; turns
  // render as they stream, whatever opened them; and the first turn that
  // ends after a send unblocks that send's wait.
  let streamEnded = false;
  let pumpError: unknown = null;
  const pump = (async () => {
    try {
      for await (const item of handle.turns) {
        if (isSessionTurn(item)) {
          startIdleOutput();
          const asked = await renderTurn(item);
          const settle = pendingReply();
          if (settle !== null) {
            replyWaiter = null;
            settle(asked);
          } else if (asked !== null) {
            if (onScreen === null) presentQuestion(asked);
            else queued.push(asked);
          } else {
            redrawPrompt();
          }
        } else {
          startIdleOutput();
          renderEvent(item, createRenderState(), h);
          redrawPrompt();
        }
      }
    } catch (err) {
      pumpError = err;
    } finally {
      streamEnded = true;
      const settle = pendingReply();
      replyWaiter = null;
      settle?.(undefined);
      // The stream is gone: release a parked user prompt too.
      rl.close();
    }
  })();
  void pump;

  // Handle SIGINT to close session cleanly
  let closing = false;
  const doClose = async () => {
    if (closing) return;
    closing = true;
    try {
      // race with CLOSE_GRACE_MS ? openSession's close does escalation internally, but we add outer guard
      const timeout = setTimeout(() => {
        process.stderr.write(`close timed out after ${CLOSE_GRACE_MS}ms\n`);
      }, CLOSE_GRACE_MS + 1000);
      await handle.close();
      clearTimeout(timeout);
    } catch (err) {
      process.stderr.write(`close failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.close();
  };
  process.on("SIGINT", doClose);
  process.on("SIGTERM", doClose);

  try {
    outer: for (;;) {
      // A line already typed can be the first answer to a question the
      // pump presented while the you-prompt was parked.
      let typed: string | null = null;
      if (questionOnScreen() === null && queued.length > 0)
        presentQuestion(queued.shift() as QuestionEvent);
      if (questionOnScreen() === null) {
        let line: string | null;
        try {
          line = await nextLine("you › ");
        } catch {
          // stdin closed (Ctrl-D)
          break;
        }
        if (line === null) break;
        if (questionOnScreen() !== null) {
          const trimmed = line.trim();
          typed = trimmed === "" ? null : trimmed;
        } else {
          const trimmed = line.trim();
          if (trimmed === "" || trimmed === "exit") break;
          const asked = await sendAndWait(line);
          if (asked === undefined) break;
          if (asked !== null) presentQuestion(asked);
        }
      }
      // Answer every presented question: the answer (or a custom reply) is
      // sent on the same live session, and its reply is waited out before
      // anything else renders a prompt. A question that reply itself asks
      // is presented next; the ones queued mid-answer follow, oldest first.
      while (questionOnScreen() !== null) {
        const q = questionOnScreen();
        if (q === null) break;
        let answer: string | undefined;
        while (answer === undefined) {
          let raw = typed;
          typed = null;
          if (raw === null) {
            try {
              raw = await nextLine("> ");
            } catch {
              break outer;
            }
            if (raw === null || streamEnded) break outer;
          }
          const a = raw.trim();
          if (a === "") continue;
          const n = Number(a);
          answer =
            Number.isInteger(n) && n >= 1 && n <= q.options.length
              ? (q.options[n - 1] as string)
              : a;
        }
        onScreen = null;
        const asked = await sendAndWait(composeAnswer(q.question, answer as string));
        if (asked === undefined) break outer;
        if (asked !== null) presentQuestion(asked);
        else if (queued.length > 0) presentQuestion(queued.shift() as QuestionEvent);
      }
    }
  } catch (err) {
    process.stderr.write(`session error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", doClose);
    process.off("SIGTERM", doClose);
    try {
      await doClose();
    } catch {}
    rl.close();
    if (pumpError !== null) {
      process.stderr.write(
        `session error: ${pumpError instanceof Error ? pumpError.message : String(pumpError)}\n`,
      );
      process.exitCode = 1;
    }
  }
};
