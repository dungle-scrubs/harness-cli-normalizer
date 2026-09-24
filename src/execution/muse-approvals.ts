import { type MuseCompaction, museViewPageOf } from "../interpretation/muse-compaction.js";
import { asRecord } from "../interpretation/shape.js";
import type { Clock, SignalName, SpawnedProcess, SpawnOptions, TimerHandle } from "./deps.js";
import { LineBuffer } from "./lines.js";
import { superviseTermination } from "./supervisor.js";

const POLL_MS = 1_000;
/** M1: budget for the helper to answer `initialize` before its pending set
 * counts as unobservable. A slow start (parallel fan-out) is an
 * infrastructure wobble, not a verdict - give it room before failing. */
const HELPER_START_MS = 30_000;
/** Hardening after the 2026-09-24 live incident: a `muse serve` helper
 * hung mid-startup and never answered `initialize`, and the fail-closed
 * at the first budget ended a healthy turn. One replacement helper gets
 * its own start budget; only when it also fails the start phase does the
 * pending set count as unobservable. Counted per start attempt, so the
 * worst unobservable window doubles while a live turn keeps running. */
const HELPER_START_ATTEMPTS = 2;
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
  /** ADR 0009 / #241: every terminal compaction the MSP view reports,
   * once each. Optional - an omitted sink turns the view fold off, which
   * is what every caller predating it gets. */
  compaction?: (found: MuseCompaction) => void,
): MuseApprovalObserver {
  let closed = false;
  let reported = false;
  let exited = false;
  let timer: TimerHandle | null = null;
  let requestId = 0;
  let initialized = false;
  let unreadableStreak = 0;
  let startAttempts = 0;
  let proc: SpawnedProcess;
  const helpers: Array<{
    readonly drained: Promise<void>;
    readonly proc: SpawnedProcess;
    readonly terminate: () => void;
  }> = [];
  // ---- #241: the MSP view fold. -------------------------------------
  // It rides the same helper but NOT the same request channel. The
  // approval poll's cadence and its consecutive-poll counting are the
  // basis of the blocked-approval verdict, so nothing here may sit
  // between two approval polls: a view page that answers slowly would
  // delay a verdict by its whole budget. View requests therefore carry
  // their own string id space (`v1`, `v2`, ...), their own timer, and at
  // most one in flight. The approval path below is untouched.
  let viewEnabled = compaction !== undefined;
  let viewRequestId = 0;
  let viewInFlight: string | null = null;
  let viewTimer: TimerHandle | null = null;
  /** Paging forward from here. Null means "from the beginning", which is
   * what closes the attach-timing risk: muse compacts pre-turn and
   * blocking, and this observer starts on the identity event, so the
   * compaction is over before the helper is up. The view is a durable
   * cursor-paged log, not a live subscription, so a first page with no
   * anchor returns items recorded before attach. `anchor:
   * "latestCompaction"` would NOT - it resolves to the boundary and pages
   * strictly after it, excluding the compaction item itself. */
  let viewCursor: string | null = null;
  /** One compaction reports once, across repeated or overlapping pages. */
  const reportedCompactions = new Set<string>();
  let cleanup: Promise<void> | null = null;
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
      startAttemptFailed();
      return;
    }
    unreadable();
  };
  const startAttemptFailed = (): void => {
    if (closed || reported) return;
    clearTimer();
    clearViewTimer();
    viewInFlight = null;
    unreadableStreak = 0;
    if (startAttempts < HELPER_START_ATTEMPTS) {
      const retired = helpers[helpers.length - 1];
      if (retired !== undefined) {
        retired.terminate();
        retired.proc.disposeOutput();
      }
      if (!spawnHelper()) {
        reported = true;
        unavailable();
        return;
      }
      init();
      return;
    }
    reported = true;
    unavailable();
  };
  const spawnHelper = (): boolean => {
    let spawned: SpawnedProcess;
    try {
      spawned = deps.spawn([bin, "serve"], { ...options, stdin: "pipe" });
    } catch {
      return false;
    }
    startAttempts += 1;
    proc = spawned;
    exited = false;
    const termination = superviseTermination(deps.clock, (sig) => deps.signal(spawned, sig));
    const gone = (fromExit: boolean): void => {
      if (proc !== spawned) return;
      if (fromExit) {
        exited = true;
        termination.settle();
      }
      if (closed || reported) return;
      if (!initialized) {
        startAttemptFailed();
        return;
      }
      failClosed();
    };
    const stdout = (async (): Promise<void> => {
      // H1: this channel decodes the full pending set (rawArgs included), so
      // it carries its own multi-MB limit. An oversized frame is one
      // unreadable sample: skipped, never a verdict on its own.
      const lines = new LineBuffer(OBSERVER_LINE_MAX, unreadable);
      try {
        for await (const chunk of spawned.stdout) {
          for (const line of lines.push(chunk)) receive(line);
        }
        const tail = lines.flush();
        if (tail !== null) receive(tail);
        gone(false);
      } catch {
        gone(false);
      }
    })();
    const stderr = (async (): Promise<void> => {
      try {
        // Drain without retaining native diagnostics or approval contents.
        for await (const _chunk of spawned.stderr) {
          /* bounded by the pipe */
        }
      } catch {
        /* drain only; exit settles this helper */
      }
    })();
    void spawned.exited.then(() => {
      gone(true);
    });
    if (spawned.inputError) void spawned.inputError.then(() => gone(false));
    let terminated = false;
    helpers.push({
      proc: spawned,
      terminate: () => {
        if (terminated) return;
        terminated = true;
        termination.escalate();
      },
      drained: Promise.all([spawned.exited, stdout, stderr]).then(() => {
        termination.settle();
      }),
    });
    return true;
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
  const poll = (): void => {
    request("approval/listPending", { sessionId }, POLL_RESPONSE_MS);
    // Fire-and-forget beside the poll: the reply is matched by its own id
    // and settles on its own timer, so it can neither delay nor fail the
    // approval poll that just went out.
    pollView();
  };
  const clearViewTimer = (): void => {
    if (viewTimer !== null) deps.clock.clearTimeout(viewTimer);
    viewTimer = null;
  };
  /** #241: one page per approval poll, at most one in flight. A page that
   * never answers is abandoned on its own budget and simply retried with
   * the next poll. */
  const pollView = (): void => {
    if (!viewEnabled || closed || reported || viewInFlight !== null) return;
    viewRequestId += 1;
    const id = `v${viewRequestId}`;
    const sent = write({
      id,
      jsonrpc: "2.0",
      method: "view/page",
      params: { sessionId, ...(viewCursor !== null ? { cursor: viewCursor } : {}) },
    });
    if (!sent) return;
    viewInFlight = id;
    clearViewTimer();
    viewTimer = deps.clock.setTimeout(() => {
      viewTimer = null;
      viewInFlight = null;
    }, POLL_RESPONSE_MS);
  };
  /** A view reply. Returns true when it was one, so `receive` can stop.
   * Nothing here touches `reported`, `unreadableStreak` or the approval
   * timer: the fold is additive and never decides a turn. */
  const receiveView = (value: Record<string, unknown>): boolean => {
    if (typeof value.id !== "string" || value.id !== viewInFlight) return false;
    viewInFlight = null;
    clearViewTimer();
    const result = asRecord(value.result);
    if (value.error !== undefined || !result) {
      // A muse with no `view/page` supervises approvals perfectly well; it
      // just has no compaction view. Turn the fold off rather than end the
      // turn as an incompatible surface.
      if (asRecord(value.error)?.code === JSON_RPC_METHOD_NOT_FOUND) viewEnabled = false;
      return true;
    }
    const page = museViewPageOf(result);
    if (page === null) return true;
    for (const found of page.compactions) {
      if (reportedCompactions.has(found.itemId)) continue;
      reportedCompactions.add(found.itemId);
      compaction?.(found);
    }
    if (page.nextCursor !== null) viewCursor = page.nextCursor;
    return true;
  };
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
    if (value !== null && receiveView(value)) return;
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
  if (!spawnHelper()) {
    reported = true;
    unavailable();
    return { close: async () => {} };
  }
  init();
  return {
    close(): Promise<void> {
      if (cleanup) return cleanup;
      closed = true;
      clearTimer();
      clearViewTimer();
      // Terminate every helper this observer spawned; their sessions were
      // never loaded, so no execution is interrupted. Probed on Muse Code
      // 1.3.0: serve exits 0 about 4s after
      // stdin EOF with no signal, so even a SIGKILLed hcn orphans no
      // helper - the pipe EOF does it. The explicit terminate stays for
      // promptness on the graceful path.
      for (const helper of helpers) helper.terminate();
      for (const helper of helpers) helper.proc.disposeOutput();
      cleanup = (async () => {
        await Promise.all(helpers.map((helper) => helper.drained));
      })();
      return cleanup;
    },
  };
}
