import { randomUUID } from "node:crypto";
import type { ContextInspection } from "../execution/context-inspection.js";
import { inspectContext } from "../execution/context-inspection.js";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { promptTextOf } from "../interpretation/argv.js";
import {
  assertContextInspectionOptions,
  buildContextInspectionArgv,
} from "../interpretation/context-inspection.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { EXIT_FAILURE } from "./exit-codes.js";
import { planTurn } from "./plan-turn.js";
import { refusalOf, refuse } from "./refuse.js";
import { runtimeCompatibility } from "./runtime-compatibility.js";

/** Accounting starts a disposable harness process but never submits a task
 * for execution. Pin its executable to the exact path just verified. */
export async function inspectContextCommand(
  harness: HarnessDescriptor,
  args: string[],
): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    await inspectContextRequest(harness, args, controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    if (controller.signal.aborted) process.exitCode = EXIT_FAILURE;
  }
}

async function inspectContextRequest(
  harness: HarnessDescriptor,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  const outcome = await planTurn(harness, args, { command: "inspect" });
  if (outcome.kind === "refusal") {
    refuse(outcome.refusal, outcome.wantJson);
    return;
  }
  const options = outcome.plan.options;
  try {
    assertContextInspectionOptions(harness, options);
  } catch (error) {
    if (!(error instanceof ArgvRefusalError)) throw error;
    refuse(refusalOf(error), outcome.plan.wantJson);
    return;
  }
  const runtime = await runtimeCompatibility(harness, options);
  let accounting: ContextInspection;
  if (harness.contextInspection === null) {
    accounting = { status: "unavailable", reason: "unsupported-adapter" };
  } else if (
    runtime.resume.status !== "supported" ||
    runtime.executable.path === null ||
    harness.contextInspection?.kind !== "claude-control-v1"
  ) {
    accounting = { status: "unavailable", reason: "unverified-adapter" };
  } else {
    try {
      const argv = buildContextInspectionArgv(harness, options);
      argv[0] = runtime.executable.path;
      accounting = await inspectContext(
        {
          argv,
          cwd: options.cwd,
          env: options.env,
          inputId: randomUUID(),
          signal,
          harness,
          prompt: promptTextOf(options),
        },
        {
          ...nodeRunnerDeps(),
          turnTimeoutMs: (outcome.plan.behavior.timeoutSeconds.value || 30) * 1000,
        },
      );
    } catch (error) {
      if (!(error instanceof ArgvRefusalError)) throw error;
      refuse(refusalOf(error), outcome.plan.wantJson);
      return;
    }
  }
  const output = { v: 1, harness: harness.name, mode: "headless-turn", ...runtime, accounting };
  if (outcome.plan.wantJson) process.stdout.write(`${JSON.stringify(output)}\n`);
  else if (accounting.status === "available")
    process.stdout.write(
      `${accounting.model}: native estimate ${accounting.totalTokens} tokens; supported input limit ${accounting.inputLimitTokens}.\n`,
    );
  else process.stdout.write(`Context accounting unavailable: ${accounting.reason}.\n`);
}
