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
 * human was asked, and headless has no human. Issue #189: a sandbox
 * escalation reports at once too - muse never sends that class to its
 * approval judge, so no wait can resolve it. */
export const APPROVAL_STUCK_POLLS = 30;
/** H1: consecutive unreadable polls (oversized frame, malformed JSON, RPC
 * error, unreadable shape) before the pending set counts as
 * unobservable. One bad sample is skipped and the next poll is tried. */
const MAX_UNREADABLE_POLLS = 3;
/** M2: margin past `autoResolutionMs` before a self-resolving request may
 * be reported. Counted in polls like the stuck window, so the wait only
 * elapses while observation is actually flowing. */
const AUTO_RESOLVE_MARGIN_POLLS = 5;
/** L5: JSON-RPC errors that mark the helper's surface as incompatible
 * with hcn instead of one skipped sample. Method-not-found on any
 * request means the installed muse renamed the operation; a rejected
 * handshake (bad request, bad params - e.g. an unknown capability)
 * means it speaks a different MSP revision. Server errors (-32000 and
 * below) stay transient samples: the helper is up but unhappy. */
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** L4: upper bound on the `autoResolutionMs` wait, counted in polls. Past
 * 5 minutes the field reads as a client-screen timer rather than a
 * self-resolution deadline: if exec never resolves the input, an
 * unbounded wait is the #179 hang again (forever without --timeout).
 * 300 polls at gaps of at least 1s is at least 5 minutes of flowing
 * observation. */
export const MAX_AUTO_RESOLVE_POLLS = 300;

export interface MuseApprovalObserver {
  readonly close: () => Promise<void>;
}

/** L5: the installed muse helper speaks an MSP surface hcn cannot use -
 * the operation or handshake hcn sent was rejected as unknown. Carries
 * the rejected method and the JSON-RPC error code for the message. */
export interface MuseSurfaceIncompatibility {
  readonly code: number | null;
  readonly method: string;
}

/** Issue #179: muse exec omits pending approvals from stdout, so a
 * headless turn blocked on one hangs with no event until --timeout. This
 * read-only observer polls the native log through a helper `muse serve`
 * process using only the approval/listPending operation - a log fold that
 * takes no lease, works on loaded and unloaded sessions, and never
 * subscribes. It never loads a session, never decides an approval, and
 * never copies request payloads (no command, host, path, or tool args
 * leave the helper): only the blocked subject (approval vs input), the
 * approval's subject kind, and one boolean - whether the pending approval
 * is a sandbox escalation - leave the helper. The caller owns both this
 * helper and the one turn it observes, and reaps it with the child.
 * Dual-runtime: only injected spawn/clock/signal primitives. */
export function watchMuseApprovals(
  bin: string,
  options: Pick<SpawnOptions, "cwd" | "env">,
  deps: {
    readonly clock: Clock;
    readonly signal: (proc: SpawnedProcess, sig: SignalName) => void;
    readonly spawn: (argv: readonly string[], opts: SpawnOptions) => SpawnedProcess;
  },
  sessionId: string,
  blocked: (subject: "approval" | "input", kind: string, sandboxEscalation: boolean) => void,
  unavailable: () => void,
  incompatible?: (info: MuseSurfaceIncompatibility) => void,
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
  /** L5: the helper's surface is incompatible with hcn - retrying the
   * same route cannot help, so end the turn at once with a message
   * naming the surface instead of failing closed as transport. Without
   * a handler (unit tests that predate the seam) fall back to the
   * fail-closed path so the turn still ends. */
  const reportIncompatible = (method: string, code: number | null): void => {
    if (closed || reported) return;
    reported = true;
    clearTimer();
    if (incompatible !== undefined) {
      incompatible({ code, method });
      return;
    }
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
  /** Issue #189: a sandbox-escalation approval asks to run outside the
   * muse shell sandbox - the tool-call `rawArgs` carry
   * `sandbox_permissions: "require_escalated"`. Muse never sends this
   * class to its approval judge (a human is asked instead), so no wait
   * can resolve it headless: it reports at once like a judge escalation.
   * The args are parsed only to read this one field; absent or
   * unparseable args read as ordinary, and the parse never throws. No
   * payload value from the args leaves the helper - only this boolean
   * does (the #179 rule). */
  const sandboxEscalationOf = (approval: unknown): boolean => {
    const rawArgs = asRecord(approval)?.rawArgs;
    if (typeof rawArgs !== "string") return false;
    try {
      return asRecord(JSON.parse(rawArgs))?.sandbox_permissions === "require_escalated";
    } catch {
      return false;
    }
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
    return Math.min(
      MAX_AUTO_RESOLVE_POLLS,
      Math.max(APPROVAL_STUCK_POLLS, Math.ceil(autoMs / POLL_MS) + AUTO_RESOLVE_MARGIN_POLLS),
    );
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
    judgeEscalated: boolean,
    sandboxEscalation: boolean,
    item: unknown,
  ): void => {
    if (reported || closed) return;
    const known = seen.get(key);
    if (known === undefined) {
      seen.set(key, { count: 1, required: requiredPollsFor(item), subject, kind });
      if (judgeEscalated || sandboxEscalation) {
        reported = true;
        clearTimer();
        blocked(subject, kind, sandboxEscalation);
      }
      return;
    }
    known.kind = kind;
    known.count += 1;
    known.required = Math.max(known.required, requiredPollsFor(item));
    if (judgeEscalated || sandboxEscalation || known.count >= known.required) {
      reported = true;
      clearTimer();
      blocked(known.subject, known.kind, sandboxEscalation);
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
      const code = asRecord(value.error)?.code;
      if (typeof code === "number" && code === JSON_RPC_METHOD_NOT_FOUND) {
        reportIncompatible(!initialized ? "initialize" : "approval/listPending", code);
        return;
      }
      if (
        value.error !== undefined &&
        !initialized &&
        (code === JSON_RPC_INVALID_REQUEST || code === JSON_RPC_INVALID_PARAMS)
      ) {
        reportIncompatible("initialize", code);
        return;
      }
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
        sandboxEscalationOf(approval),
        approval,
      );
      if (reported) return;
    }
    for (const input of result.userInputs) {
      const id = asRecord(input)?.userInputId;
      if (typeof id !== "string" || id === "") continue;
      track(`u:${id}`, "input", "input", false, false, input);
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
