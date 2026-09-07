/**
 * The turn supervisor: the one owner of the supervising policies
 * CONTEXT.md names (RFC-02 change 5), composed by both runners instead of
 * written into each. It owns the stall clock, the SIGTERM-then-SIGKILL
 * escalation, the classification of every stderr line, the tracking of
 * the last assistant message, and the turn close that turns a detected
 * hcn-question block into events. It emits through the callbacks its
 * runner hands it and knows nothing about channels or turns.
 */
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import {
  type QuestionDetectionKind,
  type QuestionMode,
  questionEventOf,
} from "../interpretation/question.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { Clock, SignalName, TimerHandle } from "./deps.js";
import type { HarnessEvent } from "./events.js";
import {
  type FailureSummary,
  failureFromAuth,
  failureFromLimit,
  failureFromTask,
} from "./failure.js";

/** SIGTERM -> SIGKILL escalation budget for a child that ignores the first
 * signal. */
export const KILL_GRACE_MS = 5_000;

/** Shared process termination policy for turn runners and control probes. */
export function superviseTermination(
  clock: Clock,
  signal: (sig: SignalName) => void,
): { readonly escalate: () => void; readonly settle: () => void } {
  let settled = false;
  let timer: TimerHandle | null = null;
  return {
    escalate(): void {
      if (settled || timer !== null) return;
      signal("SIGTERM");
      timer = clock.setTimeout(() => {
        timer = null;
        if (!settled) signal("SIGKILL");
      }, KILL_GRACE_MS);
    },
    settle(): void {
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

/** Bounded tail of unmatched stderr - the crash context a nonzero exit is
 * explained by (v1 kept the turn's output slice for exactly this). */
export class StderrTail {
  private readonly lines: string[] = [];
  private bytes = 0;
  push(line: string): void {
    this.lines.push(line);
    this.bytes += line.length;
    while (this.lines.length > 20 || (this.bytes > 4096 && this.lines.length > 1)) {
      const dropped = this.lines.shift();
      this.bytes -= dropped?.length ?? 0;
    }
  }
  snapshot(): readonly string[] {
    return [...this.lines];
  }
}

export interface SupervisorIo {
  readonly clock: Clock;
  /** Inactivity budget; undefined means no stall clock at all. */
  readonly stallMs: number | undefined;
  /** Signal the supervised process. The supervisor never signals after
   * `settle()`. */
  readonly signal: (sig: SignalName) => void;
  /** Deliver an event to the turn's consumer. */
  readonly emit: (event: HarnessEvent) => Promise<void>;
  /** Record a failure for the turn's done AND deliver it as an event. */
  readonly fail: (summary: FailureSummary) => Promise<void>;
  /** Where unclassified stderr goes. */
  readonly tail: StderrTail;
  /** The stall clock fired: the runner records its own cause and ends the
   * turn; the supervisor has already begun escalation. */
  readonly onStall: () => void;
  /** A question was detected at close, with its option count (for the
   * runner's boundary log). */
  readonly onQuestion: (optionCount: number) => void;
}

export interface TurnClose {
  readonly detection: QuestionDetectionKind;
  /** True when the turn ended by asking: a successful turn, cause
   * awaiting-input. */
  readonly asked: boolean;
}

export interface TurnSupervisor {
  /** Start a turn: reset per-turn state and arm the stall clock. */
  beginTurn(): void;
  /** Any output chunk arrived: restart the inactivity budget, if a turn is
   * open and a budget exists. */
  rearm(): void;
  /** The turn ended, or the process did: stop the stall clock. */
  disarm(): void;
  /** SIGTERM now, SIGKILL after KILL_GRACE_MS unless the process exits.
   * Idempotent while an escalation is pending. */
  escalate(): void;
  /** The process is gone: no further signals, no pending escalation, no
   * stall clock. */
  settle(): void;
  /** Classify one stderr line: a limit wall becomes a limit event plus a
   * failure, an auth wall a failure plus an error event, anything else
   * goes to the tail. Returns the limit code when the line was a limit. */
  stderrLine(line: string): Promise<void>;
  /** A decoded event passed by: the last assistant message is where the
   * protocol says the hcn-question block lives (tracked in ask mode). */
  noteEvent(event: HarnessEvent): void;
  /** At turn end: detect the block in the last assistant message, emit the
   * question (or the malformation as an error plus a task failure), and
   * report what was found. Synchronous: the events are enqueued, not
   * awaited, so a runner can close a turn from a timer callback. */
  close(): TurnClose;
}

export const superviseTurn = (
  h: HarnessDescriptor,
  questionMode: QuestionMode,
  io: SupervisorIo,
): TurnSupervisor => {
  const termination = superviseTermination(io.clock, io.signal);
  let stallTimer: TimerHandle | null = null;
  let turnOpen = false;
  let lastAssistantText: string | null = null;

  const disarm = (): void => {
    if (stallTimer !== null) io.clock.clearTimeout(stallTimer);
    stallTimer = null;
    turnOpen = false;
  };

  const escalate = termination.escalate;

  const armStall = (): void => {
    if (io.stallMs === undefined || !turnOpen) return;
    if (stallTimer !== null) io.clock.clearTimeout(stallTimer);
    stallTimer = io.clock.setTimeout(() => {
      stallTimer = null;
      // The turn may have ended between the timer firing and this callback
      // running; a closed turn is never reported as a stall.
      if (!turnOpen) return;
      io.onStall();
      escalate();
    }, io.stallMs);
  };

  return {
    beginTurn(): void {
      lastAssistantText = null;
      turnOpen = true;
      armStall();
    },
    rearm(): void {
      armStall();
    },
    disarm,
    escalate,
    settle(): void {
      termination.settle();
      disarm();
    },
    async stderrLine(line: string): Promise<void> {
      const limit = detectLimitInLine(h, line);
      if (limit !== null) {
        await io.emit({ kind: "limit", code: limit, message: `limit wall detected (${limit})` });
        await io.fail(failureFromLimit(limit));
        return;
      }
      const auth = detectAuthFailureInLine(h, line);
      if (auth !== null) {
        await io.fail(failureFromAuth(auth));
        await io.emit({ kind: "error", message: `auth wall: ${auth}` });
        return;
      }
      io.tail.push(line);
    },
    noteEvent(event: HarnessEvent): void {
      if (questionMode === "ask" && event.kind === "message" && event.role === "assistant") {
        lastAssistantText = event.text;
      }
    },
    close(): TurnClose {
      const found = questionEventOf(lastAssistantText, questionMode);
      if (found.detection === "malformed") {
        void io.emit({ kind: "error", message: found.malformed });
        void io.fail(failureFromTask(`malformed hcn-question block: ${found.malformed}`));
        return { detection: "malformed", asked: false };
      }
      if (found.detection === "block") {
        io.onQuestion(found.event.options.length);
        void io.emit(found.event);
        return { detection: "block", asked: true };
      }
      return { detection: "none", asked: false };
    },
  };
};
