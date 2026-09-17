import { asRecord } from "../interpretation/shape.js";
import type { Clock, SignalName, SpawnedProcess, SpawnOptions, TimerHandle } from "./deps.js";
import { LineBuffer } from "./lines.js";
import { superviseTermination } from "./supervisor.js";

const POLL_MS = 1_000;
/** M1: budget for the helper to answer `initialize` before its pending set
 * counts as unobservable. A slow start (parallel fan-out) is an
 * infrastructure wobble, not a verdict - give it room before failing. */
const HELPER_START_MS = 30_000;
/** Budget for one poll reply once the helper is up. An unanswered poll is
 * one unreadable sample, not a verdict (H1). */
const POLL_RESPONSE_MS = 10_000;
/** H1: the observer channel carries its own large line limit. A
 * judge-decided approval can carry more than 64KB of rawArgs, so the
 * 64KB stream limit would end a healthy turn that a poll lands in. */
export const OBSERVER_LINE_MAX = 4_194_304;
/** L2: a pending native request must hold the same identity across this
 * many consecutive polls before the turn is stopped. Counted polls, not
 * wall-clock time: a laptop sleep stalls the polls too, so the first poll
 * after wake cannot measure a spurious 30s. Live finding (issue #179
 * validation): judge-decided approvals for ordinary tool calls appear
 * briefly mid-turn, then clear - a single non-empty sample must not stop
 * a healthy turn. A judge-escalated approval reports at once instead: a
 * human was asked, and headless has no human. */
export const APPROVAL_STUCK_POLLS = 30;
/** H1: consecutive unreadable polls (oversized frame, malformed JSON, RPC
 * error, unreadable shape) before the pending set counts as
 * unobservable. One bad sample is skipped and the next poll is tried. */
const MAX_UNREADABLE_POLLS = 3;
/** M2: margin past `autoResolutionMs` before a self-resolving request may
 * be reported. Counted in polls like the stuck window, so the wait only
 * elapses while observation is actually flowing. */
const AUTO_RESOLVE_MARGIN_POLLS = 5;

export interface MuseApprovalObserver {
  readonly close: () => Promise<void>;
}

/** Issue #179: muse exec omits pending approvals from stdout, so a
 * headless turn blocked on one hangs with no event until --timeout. This
 * read-only observer polls the native log through a helper `muse serve`
 * process using only the approval/listPending operation - a log fold that
 * takes no lease, works on loaded and unloaded sessions, and never
 * subscribes. It never loads a session, never decides an approval, and
 * never copies request payloads: only the blocked subject (approval vs
 * input) and the approval's subject kind leave the helper. The caller owns
 * both this helper and the one turn it observes, and reaps it with the
 * child. Dual-runtime: only injected spawn/clock/signal primitives. */
export function watchMuseApprovals(
  bin: string,
  options: Pick<SpawnOptions, "cwd" | "env">,
  deps: {
    readonly clock: Clock;
    readonly signal: (proc: SpawnedProcess, sig: SignalName) => void;
    readonly spawn: (argv: readonly string[], opts: SpawnOptions) => SpawnedProcess;
  },
  sessionId: string,
  blocked: (subject: "approval" | "input", kind: string) => void,
  unavailable: () => void,
): MuseApprovalObserver {
  let proc: SpawnedProcess;
  try {
    proc = deps.spawn([bin, "serve"], { ...options, stdin: "pipe" });
  } catch {
    unavailable();
    return { close: async () => {} };
  }
  let closed = false;
  let reported = false;
  let exited = false;
  let timer: TimerHandle | null = null;
  let requestId = 0;
  let initialized = false;
  let unreadableStreak = 0;
  let cleanup: Promise<void> | null = null;
  const termination = superviseTermination(deps.clock, (sig) => deps.signal(proc, sig));
  const clearTimer = (): void => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  };
  /** The pending set is unknown, never empty. Fail closed - a turn hcn
   * cannot supervise must not hang silently until --timeout. */
  const failClosed = (): void => {
    if (closed || reported) return;
    reported = true;
    clearTimer();
    unavailable();
  };
  /** One poll produced no readable sample: skip it and try the next poll.
   * Fail closed only after several in a row (H1). */
  const unreadable = (): void => {
    if (closed || reported) return;
    unreadableStreak += 1;
    clearTimer();
    if (unreadableStreak >= MAX_UNREADABLE_POLLS) {
      reported = true;
      unavailable();
      return;
    }
    timer = deps.clock.setTimeout(() => {
      timer = null;
      if (!initialized) init();
      else poll();
    }, POLL_MS);
  };
  const write = (value: unknown): boolean => {
    if (closed || reported || exited || !proc.stdin) return false;
    try {
      proc.stdin.write(`${JSON.stringify(value)}\n`);
      return true;
    } catch {
      return false;
    }
  };
  const request = (method: string, params: unknown, budgetMs: number): void => {
    clearTimer();
    requestId += 1;
    if (!write({ id: requestId, jsonrpc: "2.0", method, params })) {
      // A broken stdin pipe means the helper is gone; its exit settles
      // this. Count the sample meanwhile so a wedged pipe still closes.
      unreadable();
      return;
    }
    timer = deps.clock.setTimeout(onTimeout, budgetMs);
  };
  const onTimeout = (): void => {
    timer = null;
    if (closed || reported) return;
    if (!initialized) {
      // M1: the helper never became ready within the start budget.
      reported = true;
      unavailable();
      return;
    }
    unreadable();
  };
  const init = (): void => {
    request(
      "initialize",
      {
        capabilities: { userInputDialogs: false },
        clientInfo: { name: "hcn_approval_observer", version: "1" },
      },
      HELPER_START_MS,
    );
  };
  const poll = (): void => request("approval/listPending", { sessionId }, POLL_RESPONSE_MS);
  const subjectKindOf = (approval: unknown): string => {
    const subject = asRecord(asRecord(approval)?.subject);
    const kind = subject?.kind;
    return typeof kind === "string" ? kind : "";
  };
  /** M2: a request that resolves itself carries its own deadline. The
   * schema declares `autoResolutionMs` on user inputs (and the reader
   * below accepts it on approvals if a future schema carries it there):
   * never report before it elapses, plus a margin. Counted in polls, so
   * only flowing observation advances the wait. */
  const requiredPollsFor = (item: unknown): number => {
    const autoMs = asRecord(item)?.autoResolutionMs;
    if (typeof autoMs !== "number" || !Number.isFinite(autoMs) || autoMs <= 0) {
      return APPROVAL_STUCK_POLLS;
    }
    return Math.max(APPROVAL_STUCK_POLLS, Math.ceil(autoMs / POLL_MS) + AUTO_RESOLVE_MARGIN_POLLS);
  };
  // Stability tracking: identity -> consecutive-poll count plus the latest
  // report payload for the message. A cleared identity is forgotten, so
  // churn never stabilizes.
  const seen = new Map<
    string,
    { count: number; required: number; subject: "approval" | "input"; kind: string }
  >();
  const track = (
    key: string,
    subject: "approval" | "input",
    kind: string,
    escalated: boolean,
    item: unknown,
  ): void => {
    if (reported || closed) return;
    const known = seen.get(key);
    if (known === undefined) {
      seen.set(key, { count: 1, required: requiredPollsFor(item), subject, kind });
      if (escalated) {
        reported = true;
        clearTimer();
        blocked(subject, kind);
      }
      return;
    }
    known.kind = kind;
    known.count += 1;
    known.required = Math.max(known.required, requiredPollsFor(item));
    if (escalated || known.count >= known.required) {
      reported = true;
      clearTimer();
      blocked(known.subject, known.kind);
    }
  };
  const receive = (line: string): void => {
    if (closed || reported) return;
    let value: Record<string, unknown> | null;
    try {
      value = asRecord(JSON.parse(line));
    } catch {
      unreadable();
      return;
    }
    if (value?.id !== requestId) return;
    clearTimer();
    const result = asRecord(value.result);
    if (value.error !== undefined || !result) {
      unreadable();
      return;
    }
    if (!initialized) {
      initialized = true;
      unreadableStreak = 0;
      if (write({ jsonrpc: "2.0", method: "initialized", params: {} })) poll();
      else unreadable();
      return;
    }
    if (!Array.isArray(result.approvals) || !Array.isArray(result.userInputs)) {
      unreadable();
      return;
    }
    // Reconcile: forget cleared identities, track the rest. An item
    // without a string identity is unreadable - unknown, never empty.
    const live = new Set<string>();
    for (const approval of result.approvals) {
      const record = asRecord(approval);
      const id = record?.approvalId;
      if (typeof id !== "string" || id === "") {
        unreadable();
        return;
      }
      live.add(`a:${id}`);
    }
    for (const input of result.userInputs) {
      const record = asRecord(input);
      const id = record?.userInputId;
      if (typeof id !== "string" || id === "") {
        unreadable();
        return;
      }
      live.add(`u:${id}`);
    }
    unreadableStreak = 0;
    for (const key of [...seen.keys()]) {
      if (!live.has(key)) seen.delete(key);
    }
    for (const approval of result.approvals) {
      const record = asRecord(approval);
      const id = record?.approvalId;
      if (typeof id !== "string" || id === "") continue;
      track(
        `a:${id}`,
        "approval",
        subjectKindOf(approval),
        asRecord(approval)?.judgeEscalated === true,
        approval,
      );
      if (reported) return;
    }
    for (const input of result.userInputs) {
      const id = asRecord(input)?.userInputId;
      if (typeof id !== "string" || id === "") continue;
      track(`u:${id}`, "input", "input", false, input);
      if (reported) return;
    }
    if (!reported) timer = deps.clock.setTimeout(poll, POLL_MS);
  };
  const stdout = (async (): Promise<void> => {
    // H1: this channel decodes the full pending set (rawArgs included), so
    // it carries its own multi-MB limit. An oversized frame is one
    // unreadable sample: skipped, never a verdict on its own.
    const lines = new LineBuffer(OBSERVER_LINE_MAX, unreadable);
    try {
      for await (const chunk of proc.stdout) {
        for (const line of lines.push(chunk)) receive(line);
      }
      const tail = lines.flush();
      if (tail !== null) receive(tail);
      failClosed();
    } catch {
      failClosed();
    }
  })();
  const stderr = (async (): Promise<void> => {
    try {
      // Drain without retaining native diagnostics or approval contents.
      for await (const _chunk of proc.stderr) {
        /* bounded by the pipe */
      }
    } catch {
      failClosed();
    }
  })();
  void proc.exited.then(() => {
    exited = true;
    termination.settle();
    failClosed();
  });
  if (proc.inputError) void proc.inputError.then(failClosed);
  init();
  return {
    close(): Promise<void> {
      if (cleanup) return cleanup;
      closed = true;
      clearTimer();
      // Terminate the exact helper; its session was never loaded, so no
      // execution is interrupted. Probed on Muse Code 1.3.0: serve exits
      // 0 about 4s after stdin EOF with no signal, so even a SIGKILLed hcn
      // orphans no helper - the pipe EOF does it. The explicit terminate
      // stays for promptness on the graceful path.
      if (!exited) termination.escalate();
      proc.disposeOutput();
      cleanup = (async () => {
        await Promise.all([proc.exited, stdout, stderr]);
        termination.settle();
      })();
      return cleanup;
    },
  };
}
