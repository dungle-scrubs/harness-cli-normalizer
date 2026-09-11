import { buildSessionArgv } from "../interpretation/argv.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { parseCommonFlags, splitPassthrough } from "./args.js";
import { refusalOf, refuse } from "./refuse.js";
import { runtimeCompatibility } from "./runtime-compatibility.js";

const SESSION_PREVIEW_OPTIONS = new Set([
  "argv",
  "cwd",
  "effort",
  "json",
  "mode",
  "model",
  "prompt",
  "provider",
  "resume",
  "runtime",
]);

/** Session startup has no prompt and uses no launch-only defaults. */
export async function inspectSessionRuntime(
  harness: HarnessDescriptor,
  args: string[],
): Promise<boolean> {
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(args);
  } catch (error) {
    refuse(
      {
        issue: "invalid-option-value",
        message: error instanceof Error ? error.message : String(error),
      },
      false,
    );
    return true;
  }
  const values = parsed.values;
  if (values.mode !== "headless-session") return false;
  const unsupported = Object.keys(values).filter((key) => !SESSION_PREVIEW_OPTIONS.has(key));
  if (
    unsupported.length ||
    parsed.positionals.length ||
    splitPassthrough(args).passthrough.length
  ) {
    refuse(
      {
        issue: "invalid-option-value",
        message: `Unsupported persistent session preview options: ${unsupported.join(", ") || "positional or passthrough arguments"}`,
      },
      false,
    );
    return true;
  }
  const resume = values.resume;
  if (typeof resume !== "string" || !harness.resume.idShape.test(resume)) {
    refuse(
      {
        issue: "invalid-option-value",
        message: "Persistent session runtime inspection requires a valid --resume ID",
      },
      false,
    );
    return true;
  }
  const cwd = typeof values.cwd === "string" ? values.cwd : undefined;
  try {
    const argv = buildSessionArgv(harness, {
      sessionId: resume,
      isResume: true,
      model: typeof values.model === "string" ? values.model : undefined,
      effort: typeof values.effort === "string" ? values.effort : undefined,
      provider: typeof values.provider === "string" ? values.provider : undefined,
    });
    process.stderr.write(`argv: ${argv.join(" ")}\n`);
    process.stdout.write(
      `${JSON.stringify({ v: 1, argvKind: "redacted-preview", argv, ...(await runtimeCompatibility(harness, { cwd })) })}\n`,
    );
  } catch (error) {
    if (!(error instanceof ArgvRefusalError)) throw error;
    refuse(refusalOf(error), false);
  }
  return true;
}
