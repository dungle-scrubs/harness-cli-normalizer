import type { InteractiveRequest } from "../interpretation/interactive.js";
import { makeInteractiveRecord } from "../interpretation/interactive.js";
import type { InteractiveControlBody, InteractiveControlRecord } from "../knowledge/interactive.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import type { InteractivePreflight } from "./interactive-preflight.js";
import { superviseTermination } from "./supervisor.js";

export interface InteractiveControl {
  readonly emit: (record: InteractiveControlRecord) => void;
  readonly preflight: () => InteractivePreflight;
  readonly signal: AbortSignal;
}

/** One owned native process, no cross-process session or reservation state. */
export async function runInteractive(
  request: InteractiveRequest,
  deps: RunnerDeps,
  control: InteractiveControl,
): Promise<number> {
  const emit = (body: InteractiveControlBody): void =>
    control.emit(makeInteractiveRecord(request.launchId, body));
  const prepared = control.preflight();
  if (prepared.kind === "refused") {
    emit({ evidence: "spawn-not-attempted", kind: "refused", reason: prepared.reason });
    return 2;
  }
  emit({ kind: "ready" });
  if (control.signal.aborted) {
    emit({ evidence: "spawn-not-attempted", kind: "refused", reason: "spawn-rejected" });
    return 2;
  }
  let child: SpawnedProcess;
  try {
    child = deps.spawn(prepared.argv, {
      cwd: request.cwd,
      env: request.environment,
      output: "inherit",
      stdin: "inherit",
    });
  } catch {
    // A thrown spawn call without typed no-child evidence is uncertain.
    return 1;
  }
  const termination = superviseTermination(deps.clock, (signal) => deps.signal(child, signal));
  const stop = (): void => termination.escalate();
  control.signal.addEventListener("abort", stop, { once: true });
  if (control.signal.aborted) stop();
  try {
    const started = await child.started;
    if (started?.kind === "not-started") {
      await child.exited;
      emit({ evidence: "spawn-not-attempted", kind: "refused", reason: "spawn-rejected" });
      return 2;
    }
    if (started?.kind !== "started" || !started.owner) {
      stop();
      await child.exited;
      return 1;
    }
    emit({
      cwd: request.cwd,
      interface: request.interface,
      kind: "started",
      owner: started.owner,
      sessionId: request.sessionId,
    });
    const exitCode = await child.exited;
    termination.settle();
    child.disposeOutput();
    emit({ cleanupComplete: true, exitCode, kind: "closed" });
    return exitCode ?? 1;
  } catch {
    stop();
    await child.exited;
    return 1;
  } finally {
    termination.settle();
    control.signal.removeEventListener("abort", stop);
    child.disposeOutput();
  }
}
