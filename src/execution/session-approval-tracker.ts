/**
 * Issue #454/#455: the native-approval ledger of one persistent Claude
 * session, extracted from openSession (review round 1, F12): which
 * `can_use_tool` requests are waiting, which were answered, and the
 * clearing paths (native-resolved, turn-ended, process-ended,
 * channel-failed). A request keeps its full proposal ONLY while it waits;
 * an answered id becomes a tombstone (bounded, oldest evicted) so
 * re-answers keep rejecting `already-answered`, and a cleared request is
 * deleted outright - its answer right is gone, exactly like a request
 * never seen. The pending set is capped the way the Codex run lane caps
 * its own (NATIVE_APPROVAL_LIMITS): a request beyond the cap is denied
 * natively and surfaced as an error event, never silently dropped.
 *
 * Pure decoding and decision application live in
 * src/interpretation/session-approvals.ts; this module owns state and the
 * write, the way the runner's other lanes split interpretation from
 * execution.
 */
import type {
  SessionApprovalDecision,
  SessionApprovalProposal,
  SessionApprovalProtocol,
} from "../interpretation/session-approvals.js";
import { NATIVE_APPROVAL_LIMITS } from "../knowledge/native-approvals.js";
import type { Clock, TimerHandle } from "./deps.js";
import type { HarnessEvent } from "./events.js";

/** One decision as the host submitted it - the shape the session handle,
 * this tracker and the CLI's stdin approval op share. */
export type SessionApprovalDecisionRequest = SessionApprovalDecision & {
  readonly id: string;
  readonly requestId: string;
};

/** Issue #454/#455: one host decision on a forwarded native permission
 * request. `sent` means the native reply was written; a rejected decision
 * names why and nothing was written. A decision is consumed before its
 * write and never retried. */
export type SessionApprovalAnswer =
  | { readonly status: "sent" }
  | {
      readonly status: "rejected";
      readonly reason:
        | "unknown-request"
        | "already-answered"
        | "unknown-choice"
        | "invalid-answers"
        | "invalid-message"
        | "closed"
        | "write-failed";
    };

/** What the tracker needs from the session around it. `write` may throw
 * (broken stdin); `onWriteFailed` then runs the session's broken-pipe
 * shutdown. `routeEvent`'s promise enforces the turn channel's high-water
 * mark: every path the stdout pump reaches must return and await it, or a
 * flood of requests outpaces the consumer (teardown paths may fire and
 * forget - the process is ending and nothing can slow it). */
export interface SessionApprovalTrackerIO {
  /** The caller-side handle, for log lines. */
  readonly sessionId: string;
  /** The id the harness announced, for consumer-facing events (the
   * harness-minted id on pi-style sessions; claude confirms the
   * caller's). */
  readonly announcedSessionId: () => string;
  /** The wire of this session's channel: the native reply a decision
   * becomes, and whether a request dies with its turn (issue #469). */
  readonly protocol: SessionApprovalProtocol;
  /** The session's clock, for a native dialog timeout (issue #469: pi
   * resolves a dialog that carries one when it expires). */
  readonly clock: Clock;
  /** The turn currently open, for the stall rule: only a request on the
   * active turn pauses the inactivity clock. */
  readonly activeTurn: () => object | null;
  readonly log: (entry: Record<string, unknown>) => void;
  readonly routeEvent: (event: HarnessEvent) => Promise<void> | void;
  readonly pauseInactivity: () => void;
  readonly resumeInactivity: () => void;
  readonly isClosed: () => boolean;
  readonly write: (line: string) => void;
  readonly onWriteFailed: () => void;
  /** The published turn id, for the log lines. */
  readonly turnId: () => string;
}

/** One waiting request. The proposal (which carries the native tool
 * input) lives only until the request is answered or cleared. */
interface WaitingApproval {
  readonly requestId: string;
  readonly proposal: SessionApprovalProposal;
  readonly turn: object | null;
  /** The native timeout timer, when the request carries one. */
  readonly timer?: TimerHandle;
}

export interface SessionApprovalTracker {
  /** Track a freshly decoded native request. A duplicate native id is
   * ignored; a request beyond the pending cap is denied natively with a
   * message and reported as an error event, and nothing is tracked.
   * Returns the delivery promise of the event it routes, for the stdout
   * pump to await (backpressure). */
  offer(
    requestId: string,
    proposal: SessionApprovalProposal,
    turn: object | null,
    options?: { readonly timeoutMs?: number },
  ): Promise<void> | void;
  /** Whether the id is already known - waiting, or answered (a
   * tombstone). The caller uses this to give a duplicate none of the
   * side effects of a first sighting (it must not open a turn). */
  isKnown(requestId: string): boolean;
  /** The child cancelled its own request: cleared `native-resolved`.
   * Returns the cleared event's delivery promise, for the stdout pump. */
  cancel(requestId: string): Promise<void> | void;
  /** Clear everything still waiting on one turn: `turn-ended`. */
  clearTurn(turn: object): void;
  /** Clear everything still waiting: `process-ended`. */
  clearAll(): void;
  /** Clear everything still waiting: `channel-failed` (the stdin pipe
   * broke; nothing can be written any more). */
  clearChannel(): void;
  /** Answer one request (see SessionApprovalAnswer). */
  answer(decision: SessionApprovalDecisionRequest): SessionApprovalAnswer;
  /** Whether any request is still waiting on this turn (the close drain
   * gives up on such a turn: no decision can arrive once stdin ends). */
  isWaitingOn(turn: object): boolean;
}

export const createSessionApprovalTracker = (
  io: SessionApprovalTrackerIO,
): SessionApprovalTracker => {
  const waiting = new Map<string, WaitingApproval>();
  // Answered request ids: the tombstones that keep rejecting re-answers.
  // One insertion-ordered set - a Set iterates oldest first, so the cap
  // evicts its first entry. Bounded; past the cap the evicted id reads
  // like any unknown request.
  const answered = new Set<string>();

  const tombstone = (requestId: string): void => {
    answered.add(requestId);
    if (answered.size > NATIVE_APPROVAL_LIMITS.identities) {
      const oldest = answered.keys().next().value;
      if (oldest !== undefined) answered.delete(oldest);
    }
  };

  const syncStall = (): void => {
    // Issue #469: only a request that belongs to the ACTIVE turn pauses
    // the inactivity clock - a human is deciding right now. A request
    // left over from an earlier turn (pi's dialog outlives its turn) or
    // one raised between turns does not: the next turn's budget counts.
    const active = io.activeTurn();
    const onActiveTurn = [...waiting.values()].some(
      (entry) => entry.turn !== null && entry.turn === active,
    );
    if (onActiveTurn) io.pauseInactivity();
    else io.resumeInactivity();
  };

  const clearOne = (
    entry: WaitingApproval,
    reason: "native-resolved" | "turn-ended" | "process-ended" | "channel-failed",
  ): Promise<void> | void => {
    waiting.delete(entry.requestId);
    if (entry.timer !== undefined) io.clock.clearTimeout(entry.timer);
    io.log({
      event: "approval_cleared",
      sessionId: io.sessionId,
      turnId: io.turnId(),
      requestId: entry.requestId,
      reason,
    });
    return io.routeEvent({ kind: "approval-cleared", requestId: entry.requestId, reason, v: 1 });
  };

  return {
    offer(requestId, proposal, turn, options) {
      if (waiting.has(requestId) || answered.has(requestId)) return;
      if (waiting.size >= NATIVE_APPROVAL_LIMITS.pending) {
        // The cap exists so a pathological child cannot hold the session
        // hostage with unbounded waiting requests. The request is denied
        // natively (the child is waiting for an answer) and the host sees
        // an error event naming it - never a silent drop. The write is
        // guarded like every other: a broken pipe runs the session's
        // shutdown instead of throwing through the stdout pump.
        const message = `denied by hcn: ${NATIVE_APPROVAL_LIMITS.pending} permission requests are already waiting`;
        const line = io.protocol.refuse(requestId, message);
        try {
          io.write(line);
        } catch {
          io.onWriteFailed();
        }
        io.log({
          event: "approval_denied",
          sessionId: io.sessionId,
          turnId: io.turnId(),
          requestId,
          reason: "pending-cap",
        });
        return io.routeEvent({
          kind: "error",
          message: `permission request ${JSON.stringify(requestId)} denied: ${NATIVE_APPROVAL_LIMITS.pending} requests already waiting`,
        });
      }
      // Issue #469: a request raised between turns has no turn to name,
      // and the event says so by carrying no turnId.
      const turnId = turn === null ? undefined : io.turnId();
      // Issue #469: a native timeout is the harness's own clock - pi
      // resolves such a dialog itself when it expires, so hcn clears it
      // as native-resolved when the timer fires.
      const timer =
        options?.timeoutMs === undefined
          ? undefined
          : io.clock.setTimeout(() => {
              const entry = waiting.get(requestId);
              if (entry === undefined) return;
              void clearOne(entry, "native-resolved");
              // Only a request on the active turn can have paused the
              // stall clock. A leftover dialog expiring during a later
              // turn must not restart that turn's inactivity budget.
              if (entry.turn !== null && entry.turn === io.activeTurn()) syncStall();
            }, options.timeoutMs);
      waiting.set(requestId, {
        requestId,
        proposal,
        turn,
        ...(timer === undefined ? {} : { timer }),
      });
      syncStall();
      io.log({
        event: "approval_request",
        sessionId: io.sessionId,
        turnId: io.turnId(),
        requestId,
        category: proposal.category,
        tool: proposal.tool,
      });
      return io.routeEvent({
        kind: "approval-request",
        v: 1,
        requestId,
        sessionId: io.announcedSessionId(),
        ...(turnId === undefined ? {} : { turnId }),
        category: proposal.category,
        tool: proposal.tool,
        details: proposal.details,
        input: proposal.input,
        choices: proposal.choices,
        ...(proposal.questions === undefined ? {} : { questions: proposal.questions }),
        ...(proposal.plan === undefined ? {} : { plan: proposal.plan }),
      });
    },
    isKnown(requestId) {
      return waiting.has(requestId) || answered.has(requestId);
    },
    cancel(requestId) {
      const entry = waiting.get(requestId);
      if (entry === undefined) return;
      const delivery = clearOne(entry, "native-resolved");
      syncStall();
      return delivery;
    },
    clearTurn(turn) {
      // Issue #469: a channel whose requests die with their turn clears
      // them here; pi's extension dialog outlives its turn and stays
      // answerable, so the tracker does nothing for it.
      if (!io.protocol.clearsAtTurnEnd) return;
      let cleared = false;
      for (const entry of [...waiting.values()]) {
        if (entry.turn !== turn) continue;
        void clearOne(entry, "turn-ended");
        cleared = true;
      }
      if (cleared) syncStall();
    },
    clearAll() {
      for (const entry of [...waiting.values()]) void clearOne(entry, "process-ended");
      syncStall();
    },
    clearChannel() {
      for (const entry of [...waiting.values()]) void clearOne(entry, "channel-failed");
      syncStall();
    },
    answer(decision) {
      const rejected = (
        reason: Extract<SessionApprovalAnswer, { status: "rejected" }>["reason"],
      ): SessionApprovalAnswer => {
        io.log({
          event: "approval_decision",
          sessionId: io.sessionId,
          id: decision.id,
          requestId: decision.requestId,
          status: "rejected",
          reason,
        });
        return { status: "rejected", reason };
      };
      // The request's own state is knowable regardless of the session's,
      // and more precise: an answered request keeps rejecting re-answers
      // even on a dying session, because the decision was consumed.
      if (answered.has(decision.requestId)) return rejected("already-answered");
      const entry = waiting.get(decision.requestId);
      if (entry === undefined) return rejected("unknown-request");
      if (io.isClosed()) return rejected("closed");
      const applied = io.protocol.decide(decision.requestId, entry.proposal, decision);
      if (!applied.ok) return rejected(applied.reason);
      // Encode BEFORE consuming: an encode failure must leave the request
      // answerable. The input came from JSON.parse so this cannot fail in
      // practice; the order is the contract, not the reachability.
      const line = applied.line;
      // Consumed before the write: an uncertain delivery is never retried.
      waiting.delete(decision.requestId);
      if (entry.timer !== undefined) io.clock.clearTimeout(entry.timer);
      tombstone(decision.requestId);
      syncStall();
      try {
        io.write(line);
      } catch {
        io.onWriteFailed();
        return rejected("write-failed");
      }
      io.log({
        event: "approval_decision",
        sessionId: io.sessionId,
        turnId: io.turnId(),
        id: decision.id,
        requestId: decision.requestId,
        choiceId: decision.choiceId,
        status: "sent",
      });
      return { status: "sent" };
    },
    isWaitingOn(turn) {
      for (const entry of waiting.values()) if (entry.turn === turn) return true;
      return false;
    },
  };
};
