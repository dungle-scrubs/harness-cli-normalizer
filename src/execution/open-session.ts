/**
 * openSession: the persistent headless session runner - ONE process, many
 * turns (A-001). `send` during idle writes a descriptor-encoded user record to
 * stdin and starts a turn; `send` during a live turn is QUEUED to the next
 * boundary (mid-turn stdin writes would interleave into the model's
 * context unpredictably - the harness itself queues, so we mirror its
 * disposition). `result` lines delimit turns; identity dedupe (D-022)
 * spans the whole session. Lifecycle is bounded end to end: close() ends
 * stdin, escalates SIGTERM->SIGKILL if the child ignores EOF, and pipes
 * held open past exit close out after grace - a session can always be
 * ended. Queued sends that die with the session are surfaced, never
 * silently dropped. Structured lifecycle events (session open/close, turn
 * start/end, send dispositions, drops) are always-on evidence with
 * sessionId + turnId correlation.
 */
import { buildSessionArgv } from "../interpretation/argv.js";
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import {
  encodeSessionInput,
  resolveSessionInput,
  SessionInputRefusalError,
} from "../interpretation/session-input.js";
import type { HarnessDescriptor, SessionInputContract } from "../knowledge/descriptor.js";
import { AsyncChannel } from "./channel.js";
import { decodeParsed, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import type { ExitCause, HarnessEvent } from "./events.js";
import { LineBuffer } from "./lines.js";
import { KILL_GRACE_MS, PIPE_GRACE_MS, redactArgv, StderrTail } from "./stream-turn.js";

/** Grace after stdin EOF before concluding the child will not exit on its
 * own and escalating signals. */
export const CLOSE_GRACE_MS = 5_000;

const PRETURN_MAX = 256;

export interface SessionSendResult {
  readonly disposition: "started" | "queued";
}

export interface SessionHandle {
  /** One inner iterable per turn, each ending in a turn-scoped `done`.
   * Breaking out of THIS iterable closes the session; breaking out of a
   * single turn's iterable only stops reading that turn. */
  readonly turns: AsyncIterable<AsyncIterable<HarnessEvent>>;
  send(text: string): SessionSendResult;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  readonly sessionId: string;
  readonly model?: string;
  /** Working directory for the spawned harness. */
  readonly cwd?: string;
}

export class SessionClosedError extends Error {
  constructor() {
    super("session is closed; sends have nowhere to go");
    this.name = "SessionClosedError";
  }
}

export class SessionSpawnError extends Error {
  constructor(harness: string, cause: unknown) {
    super(
      `could not spawn a ${harness} session: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "SessionSpawnError";
  }
}

export const openSession = (
  h: HarnessDescriptor,
  opts: OpenSessionOptions,
  deps: RunnerDeps,
): SessionHandle => {
  const log = deps.log ?? (() => {});
  const argv = buildSessionArgv(h, {
    sessionId: opts.sessionId,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  let sessionInput: SessionInputContract;
  try {
    sessionInput = resolveSessionInput(h);
  } catch (cause) {
    if (!(cause instanceof SessionInputRefusalError)) throw cause;
    log({
      event: "session_input_refused",
      harness: h.name,
      issue: cause.issue,
      sessionId: opts.sessionId,
    });
    throw cause;
  }

  let proc: SpawnedProcess;
  try {
    // A session needs a writable stdin regardless of the descriptor's
    // one-shot stdin policy - that policy governs turns, not sessions.
    proc = deps.spawn(argv, {
      stdin: "pipe",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  } catch (cause) {
    log({ event: "session_spawn_failed", sessionId: opts.sessionId, harness: h.name });
    throw new SessionSpawnError(h.name, cause);
  }
  const stdin = proc.stdin;
  if (stdin === undefined) {
    // The child exists but there is no way to ever send to it - end it
    // before throwing, or it runs orphaned forever.
    deps.signal(proc, "SIGTERM");
    log({ event: "session_spawn_failed", sessionId: opts.sessionId, harness: h.name });
    throw new SessionSpawnError(h.name, new Error("spawner opened no stdin pipe"));
  }

  log({
    event: "session_open",
    sessionId: opts.sessionId,
    harness: h.name,
    argv: redactArgv(argv),
  });

  const turnsChannel = new AsyncChannel<AsyncIterable<HarnessEvent>>();
  const state = freshDecodeState(opts.sessionId);
  const stderrTail = new StderrTail();
  let turnCounter = 0;
  let activeTurn: AsyncChannel<HarnessEvent> | null = null;
  let activeTurnId = "";
  const pendingSends: string[] = [];
  const preTurnEvents: HarnessEvent[] = [];
  let dead = false;
  let closing = false;
  let finalized = false;
  let exitCode: number | null = null;
  let resultError = false;
  let turnLimitSeen = false;
  let pumpError: unknown = null;

  const safeSignal = (sig: "SIGTERM" | "SIGKILL"): void => {
    if (!dead) deps.signal(proc, sig);
  };
  const escalate = (): void => {
    safeSignal("SIGTERM");
    deps.clock.setTimeout(() => safeSignal("SIGKILL"), KILL_GRACE_MS);
  };

  const writeUser = (text: string): boolean => {
    try {
      stdin.write(encodeSessionInput(sessionInput, text));
      return true;
    } catch {
      activeTurn?.push({ kind: "error", message: "send failed: session stdin is gone" });
      return false;
    }
  };

  const startTurn = (): void => {
    turnLimitSeen = false;
    activeTurn = new AsyncChannel<HarnessEvent>();
    activeTurnId = `${opts.sessionId}:turn-${++turnCounter}`;
    log({ event: "turn_start", sessionId: opts.sessionId, turnId: activeTurnId });
    for (const held of preTurnEvents.splice(0)) activeTurn.push(held);
    turnsChannel.push(activeTurn);
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
    resultError = false;
    // The boundary is the only legal delivery point for queued input.
    if (dead || closing) return;
    const next = pendingSends.shift();
    if (next !== undefined && writeUser(next)) startTurn();
  };

  const routeEvent = (event: HarnessEvent): Promise<void> => {
    if (event.kind === "limit") {
      state.limitSeen = true;
      turnLimitSeen = true;
    }
    if (activeTurn !== null) {
      // Awaited by the pumps: past the channel's high water mark this
      // blocks the pump, so OS pipe backpressure reaches the child.
      return activeTurn.push(event);
    }
    // Between-turn events wait for the next turn, bounded: past the cap
    // droppable events go first, then oldest.
    preTurnEvents.push(event);
    if (preTurnEvents.length > PRETURN_MAX) {
      const droppableAt = preTurnEvents.findIndex(
        (e) => e.kind === "token" || e.kind === "progress" || e.kind === "context",
      );
      preTurnEvents.splice(droppableAt === -1 ? 0 : droppableAt, 1);
    }
    return Promise.resolve();
  };

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    const handleLine = async (line: string): Promise<void> => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        const code = detectLimitInLine(h, line);
        if (code !== null) {
          await routeEvent({ kind: "limit", code, message: `limit wall detected (${code})` });
        }
        return;
      }
      // The result line still feeds identity dedupe (claude includes
      // session_id on it - a rotation announced there must not be missed).
      const events = decodeParsed(h, parsed, state, opts.model ?? "");
      if (parsed.type === "result") {
        // decodeParsed already surfaces the is_error case as an error event
        // (content.ts claude reader); routing the events is enough - we only
        // still track resultError here to classify the done cause.
        for (const event of events) await routeEvent(event);
        if (parsed.is_error === true) resultError = true;
        endTurn({
          kind: "done",
          exitCode: null,
          cause: turnLimitSeen ? "limit" : resultError ? "crash" : "clean",
        });
        return;
      }
      for (const event of events) await routeEvent(event);
    };
    for await (const chunk of proc.stdout) {
      for (const line of lines.push(chunk)) await handleLine(line);
    }
    const rest = lines.flush();
    if (rest !== null) await handleLine(rest);
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      for (const line of lines.push(chunk)) {
        const limit = detectLimitInLine(h, line);
        if (limit !== null) {
          await routeEvent({
            kind: "limit",
            code: limit,
            message: `limit wall detected (${limit})`,
          });
          continue;
        }
        const auth = detectAuthFailureInLine(h, line);
        if (auth !== null) {
          await routeEvent({ kind: "error", message: `auth wall: ${auth}` });
          continue;
        }
        stderrTail.push(line);
      }
    }
  };

  const pumping = Promise.all([pumpStdout(), pumpStderr()]).catch((cause) => {
    pumpError = cause;
  });

  let shutdownComplete: () => void = () => {};
  const shutdown = new Promise<void>((resolve) => {
    shutdownComplete = resolve;
  });

  let pipesOpenAtExit = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    const cause: ExitCause = state.limitSeen
      ? "limit"
      : exitCode === 0
        ? "clean"
        : exitCode === null
          ? "killed"
          : "crash";
    if (pumpError !== null) {
      void routeEvent({ kind: "error", message: `session pump failed: ${String(pumpError)}` });
    }
    if (pendingSends.length > 0) {
      // "queued" was an accepted disposition - the loss must be visible to
      // both the log and the consumer, never silent.
      void routeEvent({
        kind: "error",
        message: `${pendingSends.length} queued send(s) died with the session`,
      });
      log({
        event: "sends_dropped",
        sessionId: opts.sessionId,
        count: pendingSends.length,
        lengths: pendingSends.map((s) => s.length),
      });
      pendingSends.length = 0;
    }
    endTurn({ kind: "done", exitCode, cause });
    if (preTurnEvents.some((e) => e.kind !== "token" && e.kind !== "progress")) {
      log({
        event: "preturn_events_dropped",
        sessionId: opts.sessionId,
        kinds: preTurnEvents.map((e) => e.kind),
      });
    }
    turnsChannel.close();
    log({
      event: "session_close",
      sessionId: opts.sessionId,
      exitCode,
      cause,
      ...(pipesOpenAtExit ? { pipesOpenAtExit } : {}),
      ...(cause === "crash" || cause === "killed" ? { stderrTail: stderrTail.snapshot() } : {}),
    });
    shutdownComplete();
  };

  void proc.exited.then((code) => {
    dead = true;
    exitCode = code;
    // Pipes held open past exit (a grandchild) must not hang the session.
    const pipeGrace = deps.clock.setTimeout(() => {
      pipesOpenAtExit = true;
      proc.disposeOutput();
      void pumping.then(() => finalize());
    }, PIPE_GRACE_MS);
    void pumping.then(() => {
      deps.clock.clearTimeout(pipeGrace);
      finalize();
    });
  });

  const close = async (): Promise<void> => {
    if (closing) return shutdown;
    closing = true;
    try {
      stdin.end();
    } catch {
      // stdin may already be gone - escalation below still bounds close.
    }
    // A child that does not exit on stdin EOF gets signalled after grace.
    const closeGrace = deps.clock.setTimeout(() => escalate(), CLOSE_GRACE_MS);
    await shutdown;
    deps.clock.clearTimeout(closeGrace);
  };

  return {
    // Breaking out of the turns iterable is abandonment - treat it as
    // close() so the child is never left running undrained (the streamTurn
    // C1 scar, adapted to a handle-shaped API).
    turns: (async function* () {
      try {
        for await (const turn of turnsChannel) yield turn;
      } finally {
        if (!closing && !dead) void close();
      }
    })(),
    send(text: string): SessionSendResult {
      if (dead || closing) throw new SessionClosedError();
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
      if (!writeUser(text)) throw new SessionClosedError();
      startTurn();
      log({
        event: "send",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        disposition: "started",
      });
      return { disposition: "started" };
    },
    close,
  };
};
