/**
 * openSession: the persistent headless session runner - ONE process, many
 * turns (A-001). `send` during idle writes a stream-json user line to
 * stdin and starts a turn; `send` during a live turn is QUEUED to the next
 * boundary (mid-turn stdin writes would interleave into the model's
 * context unpredictably - the harness itself queues, so we mirror its
 * disposition). `result` lines delimit turns; identity dedupe (D-022)
 * spans the whole session. Structured lifecycle events (session open/
 * close, turn start/end, send dispositions) are always-on evidence with
 * sessionId + turnId correlation.
 */
import { buildSessionArgv } from "../interpretation/argv.js";
import { stdinPolicyOf } from "../interpretation/dimensions.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, freshDecodeState } from "./decode.js";
import type { RunnerDeps } from "./deps.js";
import type { ExitCause, HarnessEvent } from "./events.js";
import { LineBuffer } from "./lines.js";
import { redactArgv } from "./stream-turn.js";

export interface SessionSendResult {
  readonly disposition: "started" | "queued";
}

export interface SessionHandle {
  /** One inner iterable per turn, each ending in a turn-scoped `done`. */
  readonly turns: AsyncIterable<AsyncIterable<HarnessEvent>>;
  send(text: string): SessionSendResult;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  readonly sessionId: string;
  readonly model?: string;
}

export class SessionClosedError extends Error {
  constructor() {
    super("session is closed; sends have nowhere to go");
    this.name = "SessionClosedError";
  }
}

export const openSession = (
  h: HarnessDescriptor,
  opts: OpenSessionOptions,
  deps: RunnerDeps,
): SessionHandle => {
  const log = deps.log ?? (() => {});
  const argv = buildSessionArgv(h, { sessionId: opts.sessionId });
  const proc = deps.spawn(argv, {
    stdin: stdinPolicyOf(h) === "close-required" ? "close" : "inherit",
  });
  if (proc.stdin === undefined) {
    throw new Error(`spawner opened no stdin for ${h.bin}; a session cannot send`);
  }
  const stdin = proc.stdin;

  log({
    event: "session_open",
    sessionId: opts.sessionId,
    harness: h.name,
    argv: redactArgv(argv),
  });

  const turns = new AsyncChannel<AsyncIterable<HarnessEvent>>();
  const state = freshDecodeState(opts.sessionId);
  let turnCounter = 0;
  let activeTurn: AsyncChannel<HarnessEvent> | null = null;
  let activeTurnId = "";
  const pendingSends: string[] = [];
  const preTurnEvents: HarnessEvent[] = [];
  let ended = false;

  const writeUser = (text: string): void => {
    stdin.write(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`,
    );
  };

  const startTurn = (): void => {
    activeTurn = new AsyncChannel<HarnessEvent>();
    activeTurnId = `${opts.sessionId}:turn-${++turnCounter}`;
    log({ event: "turn_start", sessionId: opts.sessionId, turnId: activeTurnId });
    for (const held of preTurnEvents.splice(0)) activeTurn.push(held);
    turns.push(activeTurn);
  };

  const endTurn = (done: HarnessEvent & { kind: "done" }): void => {
    if (activeTurn === null) return;
    activeTurn.push(done);
    activeTurn.close();
    log({
      event: "turn_end",
      sessionId: opts.sessionId,
      turnId: activeTurnId,
      cause: done.cause,
    });
    activeTurn = null;
    // The boundary is the only legal delivery point for queued input.
    const next = pendingSends.shift();
    if (next !== undefined && !ended) {
      writeUser(next);
      startTurn();
    }
  };

  const pump = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stdout) {
      for (const line of lines.push(chunk)) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        if (parsed?.["type"] === "result") {
          endTurn({ kind: "done", exitCode: null, cause: "clean" });
          continue;
        }
        for (const event of decodeLine(h, line, state, opts.model ?? "")) {
          if (event.kind === "limit") state.limitSeen = true;
          if (activeTurn !== null) activeTurn.push(event);
          else preTurnEvents.push(event);
        }
      }
    }
  };
  const pumping = pump();

  void proc.exited.then(async (exitCode) => {
    await pumping.catch(() => {});
    ended = true;
    const cause: ExitCause = state.limitSeen
      ? "limit"
      : exitCode === 0
        ? "clean"
        : exitCode === null
          ? "killed"
          : "crash";
    endTurn({ kind: "done", exitCode, cause });
    turns.close();
    log({ event: "session_close", sessionId: opts.sessionId, exitCode, cause });
  });

  return {
    turns,
    send(text: string): SessionSendResult {
      if (ended) throw new SessionClosedError();
      if (activeTurn !== null) {
        pendingSends.push(text);
        log({
          event: "send",
          sessionId: opts.sessionId,
          turnId: activeTurnId,
          disposition: "queued",
        });
        return { disposition: "queued" };
      }
      writeUser(text);
      startTurn();
      log({
        event: "send",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        disposition: "started",
      });
      return { disposition: "started" };
    },
    async close(): Promise<void> {
      stdin.end();
      await proc.exited;
    },
  };
};
