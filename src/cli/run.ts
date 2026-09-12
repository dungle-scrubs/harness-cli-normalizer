import type { SpawnedProcess, SpawnOptions } from "../execution/deps.js";
import type { HarnessEvent } from "../execution/events.js";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { streamTurn } from "../execution/stream-turn.js";
import { KILL_GRACE_MS } from "../execution/supervisor.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { EXIT_FAILURE, exitCodeForCause } from "./exit-codes.js";
import { planTurn, writePlanDiagnostics } from "./plan-turn.js";
import { refusalOf, refuse } from "./refuse.js";
import { createRenderState, renderEvent, writeEventNdjsonAsync } from "./render.js";
import { resolveHarness } from "./resolve-harness.js";
import { resumeStore } from "./resume-guard.js";

export const run = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  const h = resolveHarness(harnessName);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { RUN_HELP } = await import("./help.js");
    process.stdout.write(RUN_HELP);
    return;
  }

  // One owner turns the arguments into the plan the runner spawns from
  // (RFC-02 change 10); every refusal it raises is structured.
  const outcome = await planTurn(h, rawArgs, { command: "run" });
  if (outcome.kind === "refusal") {
    refuse(outcome.refusal, outcome.wantJson);
    return;
  }
  const { plan } = outcome;
  const { wantJson } = plan;
  writePlanDiagnostics(h, plan, "spawn");

  // A harness that creates a session when the id is unknown (pi, muse)
  // would turn a stale --resume into a silent blank session. Refuse when
  // the session store path does not exist; where the path cannot be
  // computed, the runner's pre-spawn warning is the only guard.
  const resume = plan.options.resume;
  if (resume !== undefined && h.resume.onMissing === "create") {
    const { path, exists } = resumeStore(h, {
      home: process.env.HOME ?? process.env.USERPROFILE ?? "",
      cwd: plan.options.cwd ?? process.cwd(),
      sessionId: resume,
    });
    if (path !== null && !exists) {
      refuse(
        {
          message: `no ${h.name} session ${resume} found at ${path}`,
          issue: "invalid-option-value",
          supported: [`a session id that exists in ${h.name}'s store`],
        },
        wantJson,
      );
      return;
    }
  }

  // D-025: a child harness must not inherit Herdr's environment.
  delete (process.env as Record<string, string | undefined>).HERDR_ENV;

  // D11: opt-in wall-clock budget (no profile entry by ratification);
  // 0 = explicit disable.
  const timeoutSeconds = plan.behavior.timeoutSeconds.value;
  const deps =
    timeoutSeconds !== undefined && timeoutSeconds > 0
      ? nodeRunnerDeps({ turnTimeoutMs: timeoutSeconds * 1000 })
      : nodeRunnerDeps();

  // Signal handling: the runner owns the process handle, so the deps are
  // wrapped to remember the last spawned process for SIGINT/SIGTERM.
  let lastProc: SpawnedProcess | null = null;
  const originalSignal = deps.signal;
  const wrappedDeps = {
    ...deps,
    signal: (proc: SpawnedProcess, sig: "SIGTERM" | "SIGKILL") => {
      lastProc = proc;
      originalSignal(proc, sig);
    },
    spawn: (argv: readonly string[], opts: SpawnOptions) => {
      const proc = deps.spawn(argv, opts);
      lastProc = proc;
      return proc;
    },
  };

  const abortController = new AbortController();
  let interrupted = false;
  let escalationTimer: ReturnType<typeof setTimeout> | null = null;
  const onSig = async () => {
    if (interrupted) return;
    interrupted = true;
    abortController.abort();
    if (lastProc) {
      try {
        wrappedDeps.signal(lastProc, "SIGTERM");
        escalationTimer = setTimeout(() => {
          if (lastProc) {
            try {
              wrappedDeps.signal(lastProc, "SIGKILL");
            } catch {}
          }
          escalationTimer = null;
        }, KILL_GRACE_MS);
        escalationTimer.unref?.();
      } catch {}
    }
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const state = createRenderState();
  let lastEvent: HarnessEvent | null = null;
  let exitCode = 0;

  try {
    const events = streamTurn(h, { ...plan.options, signal: abortController.signal }, wrappedDeps);
    for await (const event of events) {
      lastEvent = event;
      if (wantJson) {
        // Await the write: a consumer that stops reading must stall the
        // harness, not be absorbed into this process's memory.
        await writeEventNdjsonAsync(event);
      } else {
        renderEvent(event, state);
      }
      // A refusal before spawn exits 2 above; every done maps through the
      // one exit-code rule.
      if (event.kind === "done") exitCode = exitCodeForCause(event.cause);
    }
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      refuse(refusalOf(err), wantJson);
      return;
    }
    // Transport / spawn failure
    process.stderr.write(`run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (wantJson && lastEvent?.kind !== "done") {
      const failure = {
        kind: "failure" as const,
        class: "transport" as const,
        retryable: true,
        message: String(err),
      };
      process.stdout.write(`${JSON.stringify(failure)}\n`);
      process.stdout.write(
        `${JSON.stringify({ kind: "done", exitCode: null, cause: "failed", failure })}\n`,
      );
    }
    process.exitCode = EXIT_FAILURE;
    return;
  } finally {
    if (escalationTimer !== null) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }

  // If no done event was seen (should not happen), exit 1
  if (lastEvent === null) {
    process.exitCode = EXIT_FAILURE;
    return;
  }
  if (lastEvent.kind === "done") {
    process.exitCode = exitCode;
  } else {
    // Stream ended without done (e.g., consumer break via head)
    process.exitCode = interrupted ? EXIT_FAILURE : 0;
  }

  if (interrupted && process.exitCode === 0) process.exitCode = EXIT_FAILURE;
};
