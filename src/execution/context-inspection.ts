import type { ContextInspection } from "../interpretation/context-inspection.js";
import {
  createContextProbe,
  settledContextInspection,
} from "../interpretation/context-inspection.js";
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export type { ContextInspection } from "../interpretation/context-inspection.js";

import type { RunnerDeps, SpawnedProcess, TimerHandle } from "./deps.js";
import { LineBuffer } from "./lines.js";
import { KILL_GRACE_MS, superviseTermination } from "./supervisor.js";

export interface ContextInspectionOptions {
  /** Already validated, executable-bound ephemeral argv. The CLI adapter owns
   * no-persistence and fork-on-resume enforcement before this layer runs. */
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly harness: HarnessDescriptor;
  readonly inputId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

// Bounds serialized transport, not tokens. Native replay echoes the complete
// user message; the ordinary event line bound would silently drop its ack.
export const CONTEXT_TRANSPORT_MAX = 8 * 1024 * 1024;
const INSPECTION_TIMEOUT_MS = 30_000;
function deferred<TValue>(): {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
} {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** One disposable native control channel. shouldQuery:false stages the
 * pending task without asking the assistant to execute it. */
export async function inspectContext(
  options: ContextInspectionOptions,
  deps: RunnerDeps,
): Promise<ContextInspection> {
  if (options.signal?.aborted) return { status: "unavailable", reason: "cancelled" };
  const probe = createContextProbe(options.inputId, options.prompt);
  if (new TextEncoder().encode(probe.staged).byteLength > CONTEXT_TRANSPORT_MAX) {
    return { status: "unavailable", reason: "transport-limit" };
  }
  let child: SpawnedProcess;
  try {
    child = deps.spawn(options.argv, { cwd: options.cwd, env: options.env, stdin: "pipe" });
  } catch {
    return { status: "unavailable", reason: "transport" };
  }
  let finished = false;
  const outcome: { accounting: ContextInspection } = {
    accounting: { status: "unavailable", reason: "transport" },
  };
  let exited = false;
  let exitCode: number | null = null;
  let nativeFailure: "auth" | "limit" | null = null;
  let disposalTimer: TimerHandle | undefined;
  const result = deferred<void>();
  const stopped = deferred<boolean>();
  const signal = (kind: "SIGTERM" | "SIGKILL"): void => {
    try {
      deps.signal(child, kind);
    } catch {
      /* Exit races are handled by exited. */
    }
  };
  const termination = superviseTermination(deps.clock, signal);
  const finish = (value: ContextInspection): void => {
    if (!finished || (outcome.accounting.status === "available" && value.status === "unavailable"))
      outcome.accounting = value;
    if (finished) return;
    finished = true;
    result.resolve();
    try {
      child.stdin?.end();
    } catch {
      /* A broken pipe still needs cleanup. */
    }
    if (exited) return;
    termination.escalate();
    disposalTimer = deps.clock.setTimeout(() => {
      child.disposeOutput();
      termination.settle();
      stopped.resolve(false);
    }, 2 * KILL_GRACE_MS);
  };
  const write = (line: string): void => {
    try {
      if (child.stdin === undefined) {
        finish({ status: "unavailable", reason: "transport" });
        return;
      }
      child.stdin.write(`${line}\n`);
    } catch {
      finish({ status: "unavailable", reason: "transport" });
    }
  };
  const onLine = (line: string): void => {
    if (finished && outcome.accounting.status !== "available") return;
    const action = probe.accept(line);
    if (action?.kind === "send" && !finished) write(action.line);
    else if (action?.kind === "complete") finish(action.accounting);
  };
  const deadline = deps.clock.setTimeout(
    () => finish({ status: "unavailable", reason: "timeout" }),
    deps.turnTimeoutMs && deps.turnTimeoutMs > 0 ? deps.turnTimeoutMs : INSPECTION_TIMEOUT_MS,
  );
  const abort = (): void => finish({ status: "unavailable", reason: "cancelled" });
  options.signal?.addEventListener("abort", abort, { once: true });
  const stdout = (async (): Promise<void> => {
    const lines = new LineBuffer(CONTEXT_TRANSPORT_MAX + 65_536, () =>
      finish({ status: "unavailable", reason: "transport-limit" }),
    );
    try {
      for await (const chunk of child.stdout) {
        for (const line of lines.push(chunk)) onLine(line);
      }
      const tail = lines.flush();
      if (tail !== null) onLine(tail);
      if (!finished) finish({ status: "unavailable", reason: "transport" });
    } catch {
      finish({ status: "unavailable", reason: "transport" });
    }
  })();
  const stderr = (async (): Promise<void> => {
    const lines = new LineBuffer();
    const classify = (line: string): void => {
      if (detectAuthFailureInLine(options.harness, line) !== null) nativeFailure = "auth";
      else if (nativeFailure === null && detectLimitInLine(options.harness, line) !== null)
        nativeFailure = "limit";
    };
    try {
      for await (const chunk of child.stderr) for (const line of lines.push(chunk)) classify(line);
      const tail = lines.flush();
      if (tail !== null) classify(tail);
    } catch {
      finish({ status: "unavailable", reason: "transport" });
    }
  })();
  void child.inputError?.then(() => finish({ status: "unavailable", reason: "transport" }));
  void child.exited.then(async (code) => {
    exited = true;
    exitCode = code;
    if (!finished && code !== null && code !== 0)
      finish({ status: "unavailable", reason: "transport" });
    termination.settle();
    if (disposalTimer !== undefined) deps.clock.clearTimeout(disposalTimer);
    // Exit can precede the final bytes reaching the runtime's read buffer.
    // Drain naturally first; inherited pipes get a bounded disposal fallback.
    let drainTimer: TimerHandle | undefined;
    const drained = await Promise.race([
      Promise.all([stdout, stderr]).then(() => true),
      new Promise<boolean>((resolve) => {
        drainTimer = deps.clock.setTimeout(() => resolve(false), KILL_GRACE_MS);
      }),
    ]);
    if (drainTimer !== undefined) deps.clock.clearTimeout(drainTimer);
    child.disposeOutput();
    stopped.resolve(drained);
  });
  write(probe.initial);
  // Abort can arrive during spawn or listener registration.
  if (options.signal?.aborted) abort();
  await result.promise;
  deps.clock.clearTimeout(deadline);
  const clean = await stopped.promise;
  options.signal?.removeEventListener("abort", abort);
  return settledContextInspection({
    accounting: outcome.accounting,
    clean,
    exitCode,
    nativeFailure,
  });
}
