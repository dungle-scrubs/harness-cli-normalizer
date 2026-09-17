import { asRecord } from "../interpretation/shape.js";
import type { Clock, SignalName, SpawnedProcess, SpawnOptions, TimerHandle } from "./deps.js";
import { LINE_MAX, LineBuffer } from "./lines.js";
import { superviseTermination } from "./supervisor.js";

const POLL_MS = 1_000;
const RESPONSE_MS = 10_000;
/** A pending native request must hold the same identity across polls for
 * this long before the turn is stopped. Live finding (issue #179
 * validation): judge-decided approvals for ordinary tool calls appear
 * briefly mid-turn, then clear - a single non-empty sample must not stop
 * a healthy turn. A judge-escalated approval reports at once instead: a
 * human was asked, and headless has no human. */
export const APPROVAL_STUCK_MS = 30_000;

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
  let cleanup: Promise<void> | null = null;
  const termination = superviseTermination(deps.clock, (sig) => deps.signal(proc, sig));
  const clearTimer = (): void => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  };
  const fail = (): void => {
    if (closed || reported) return;
    reported = true;
    clearTimer();
    unavailable();
  };
  const write = (value: unknown): boolean => {
    if (closed || reported || exited || !proc.stdin) return false;
    try {
      proc.stdin.write(`${JSON.stringify(value)}\n`);
      return true;
    } catch {
      fail();
      return false;
    }
  };
  const request = (method: string, params: unknown): void => {
    clearTimer();
    requestId += 1;
    if (!write({ id: requestId, jsonrpc: "2.0", method, params })) {
      fail();
      return;
    }
    timer = deps.clock.setTimeout(fail, RESPONSE_MS);
  };
  const poll = (): void => request("approval/listPending", { sessionId });
  const subjectKindOf = (approval: unknown): string => {
    const subject = asRecord(asRecord(approval)?.subject);
    const kind = subject?.kind;
    return typeof kind === "string" ? kind : "";
  };
  // Stability tracking: identity -> first-seen time plus the latest
  // report payload for the message. A cleared identity is forgotten, so
  // churn never stabilizes.
  const seen = new Map<
    string,
    { firstSeen: number; subject: "approval" | "input"; kind: string }
  >();
  const track = (
    key: string,
    subject: "approval" | "input",
    kind: string,
    escalated: boolean,
  ): void => {
    if (reported || closed) return;
    const now = deps.clock.now();
    const known = seen.get(key);
    if (known === undefined) {
      seen.set(key, { firstSeen: now, subject, kind });
      if (escalated) {
        reported = true;
        clearTimer();
        blocked(subject, kind);
      }
      return;
    }
    known.kind = kind;
    if (escalated || now - known.firstSeen >= APPROVAL_STUCK_MS) {
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
      fail();
      return;
    }
    if (value?.id !== requestId) return;
    clearTimer();
    const result = asRecord(value.result);
    if (value.error !== undefined || !result) {
      fail();
      return;
    }
    if (!initialized) {
      initialized = true;
      if (write({ jsonrpc: "2.0", method: "initialized", params: {} })) poll();
      return;
    }
    if (!Array.isArray(result.approvals) || !Array.isArray(result.userInputs)) {
      fail();
      return;
    }
    // Reconcile: forget cleared identities, track the rest. An item
    // without a string identity is unreadable - unknown, never empty.
    const live = new Set<string>();
    for (const approval of result.approvals) {
      const record = asRecord(approval);
      const id = record?.approvalId;
      if (typeof id !== "string" || id === "") {
        fail();
        return;
      }
      live.add(`a:${id}`);
    }
    for (const input of result.userInputs) {
      const record = asRecord(input);
      const id = record?.userInputId;
      if (typeof id !== "string" || id === "") {
        fail();
        return;
      }
      live.add(`u:${id}`);
    }
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
      );
      if (reported) return;
    }
    for (const input of result.userInputs) {
      const id = asRecord(input)?.userInputId;
      if (typeof id !== "string" || id === "") continue;
      track(`u:${id}`, "input", "input", false);
      if (reported) return;
    }
    if (!reported) timer = deps.clock.setTimeout(poll, POLL_MS);
  };
  const stdout = (async (): Promise<void> => {
    const lines = new LineBuffer(LINE_MAX, fail);
    try {
      for await (const chunk of proc.stdout) {
        for (const line of lines.push(chunk)) receive(line);
      }
      const tail = lines.flush();
      if (tail !== null) receive(tail);
      fail();
    } catch {
      fail();
    }
  })();
  const stderr = (async (): Promise<void> => {
    try {
      // Drain without retaining native diagnostics or approval contents.
      for await (const _chunk of proc.stderr) {
        /* bounded by the pipe */
      }
    } catch {
      fail();
    }
  })();
  void proc.exited.then(() => {
    exited = true;
    termination.settle();
    fail();
  });
  if (proc.inputError) void proc.inputError.then(fail);
  request("initialize", {
    capabilities: { userInputDialogs: false },
    clientInfo: { name: "hcn_approval_observer", version: "1" },
  });
  return {
    close(): Promise<void> {
      if (cleanup) return cleanup;
      closed = true;
      clearTimer();
      // muse serve need not exit on stdin EOF. Terminate the exact helper;
      // its session was never loaded, so no execution is interrupted.
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
