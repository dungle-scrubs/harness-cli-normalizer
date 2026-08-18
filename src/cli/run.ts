import type { HarnessEvent } from "../execution/events.js";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { KILL_GRACE_MS, redactArgv, streamTurn } from "../execution/stream-turn.js";
import { buildLaunchArgv, buildResumeArgv } from "../interpretation/argv.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { recognizeNativeSpelling, supportedBy } from "../interpretation/support.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { parseRunExtra, parseTurnOptions, resolvePromptAsync } from "./args.js";
import { createRenderState, renderEvent, writeEventNdjson } from "./render.js";
import { resolveHarness } from "./resolve-harness.js";

export const run = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  const h = resolveHarness(harnessName);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { RUN_HELP } = await import("./help.js");
    process.stdout.write(RUN_HELP);
    return;
  }

  const { parseCommonFlags, detectPositionalPromptInjection } = await import("./args.js");
  const injection = detectPositionalPromptInjection(rawArgs);
  if (injection) {
    const err = new ArgvRefusalError({
      issue: "prompt-flag-injection",
      harness: h.name,
      supported: ["prompt must not start with '-'"],
      detail: `it would be parsed as a flag by ${h.bin}`,
    });
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(`supported: prompt must not start with '-'\n`);
    process.exitCode = 2;
    return;
  }
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(rawArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // D7 part B: a native spelling passed before the separator gets
    // recognized and redirected to the normalized flag instead of a
    // generic unknown-flag error.
    // parseArgs reports unknown long flags as "Unknown option '--x'" but
    // splits bundled short flags ("-nt" -> "Unknown option 'n'"). Match the
    // reported token back against the ORIGINAL argv: a short-flag bundle
    // that some descriptor spells exactly (pi's -nt) is recognizable; a
    // lone unknown token keeps the plain error.
    const flagMatch = message.match(/Unknown option '([A-Za-z0-9_-]+)'/);
    let rawFlag: string | undefined;
    if (flagMatch?.[1] !== undefined) {
      const reported = flagMatch[1].startsWith("-") ? flagMatch[1] : `-${flagMatch[1]}`;
      // Exact long flag: use it. Reported short flag (e.g. -n): the caller
      // may have typed a BUNDLE (-nt) that parseArgs split - find the argv
      // token that starts with the reported short and is longer; recognition
      // then decides whether the whole bundle is a descriptor spelling.
      const fromArgv =
        rawArgs.find((a) => a === reported) ??
        (reported.length === 2
          ? rawArgs.find((a) => a.length > 2 && a.startsWith(reported))
          : undefined);
      rawFlag = fromArgv ?? reported;
    }
    const native =
      rawFlag !== undefined ? recognizeNativeSpelling(defaultDescriptors(), rawFlag) : null;
    if (native !== null) {
      const by = native.option.startsWith("discovery.")
        ? native.entries
        : supportedBy(defaultDescriptors(), native.option);
      const normalizedSpelling =
        native.option === "excludeTools"
          ? "--exclude-tools"
          : native.option.startsWith("discovery.")
            ? `--no-${native.option.split(".")[1] === "instructionFiles" ? "instruction-files" : native.option.split(".")[1]}`
            : `--${native.option}`;
      process.stderr.write(
        `unknown flag: ${rawFlag} is a native spelling (used by ${native.entries.map((e) => e.harness).join(", ")}) - use the normalized ${normalizedSpelling} flag instead\n`,
      );
      if (by.length > 0) {
        process.stderr.write(
          `supported on: ${by.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
        );
      }
    } else {
      process.stderr.write(`unknown flag: ${message}\n`);
    }
    process.stderr.write(`Run 'hcn run --help' for usage.\n`);
    process.exitCode = 2;
    return;
  }

  const values = parsed.values as Record<string, unknown>;
  const positionals = parsed.positionals as string[];
  // positionals may contain prompt if not using flag; harness already consumed so first positional is prompt
  const positionalPrompt = positionals.length > 0 ? positionals[0] : undefined;
  if (positionals.length > 1) {
    process.stderr.write(`too many positionals for run; expected one prompt\n`);
    process.exitCode = 2;
    return;
  }

  const wantJson = values.json === true;

  // Resolve prompt (async for --prompt-file -)
  let prompt: string;
  let promptSource: string;
  try {
    const resolved = await resolvePromptAsync({
      positionalPrompt,
      promptFlag: values.prompt as string | undefined,
      promptFile: values["prompt-file"] as string | undefined,
    });
    prompt = resolved.prompt;
    promptSource = resolved.source;
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      if (err.supportedBy?.length) {
        process.stderr.write(
          `supported on: ${err.supportedBy.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
        );
      }
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`prompt file not found: ${(err as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  // Build turn options
  let turnOpts: ReturnType<typeof parseTurnOptions>;
  try {
    turnOpts = parseTurnOptions(values);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      if (err.supportedBy?.length) {
        process.stderr.write(
          `supported on: ${err.supportedBy.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
        );
      }
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  let extra: ReturnType<typeof parseRunExtra>;
  try {
    extra = parseRunExtra(values);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      if (err.supportedBy?.length) {
        process.stderr.write(
          `supported on: ${err.supportedBy.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
        );
      }
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const isExplicit = promptSource !== "positional";
  const fullOpts = {
    ...turnOpts,
    prompt,
    cwd: extra.cwd,
    env: extra.env,
    resume: extra.resume,
    ...(isExplicit ? { __explicitPrompt: true as const } : {}),
  } as Parameters<typeof streamTurn>[1] & { resume?: string; __explicitPrompt?: boolean };

  // Pre-validate via building argv to catch refusals before spawn (so we don't spawn on bad args)
  let _validated = false;
  let preArgv: string[] | null = null;
  try {
    if (fullOpts.resume) {
      preArgv = buildResumeArgv(h, {
        ...(turnOpts as object),
        prompt,
        sessionId: fullOpts.resume,
        __explicitPrompt: isExplicit,
      } as never);
    } else {
      preArgv = buildLaunchArgv(h, {
        ...(turnOpts as object),
        prompt,
        __explicitPrompt: isExplicit,
      } as never);
    }
    _validated = true;
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      if (err.supportedBy?.length) {
        process.stderr.write(
          `supported on: ${err.supportedBy.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
        );
      }
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  // preArgv is already set via validated build; no extra handling needed for explicit prompt bypass
  // since buildLaunchArgv now respects __explicitPrompt.

  if (preArgv) {
    const redacted = redactArgv(preArgv, prompt);
    if (!wantJson) {
      process.stderr.write(`spawn: ${redacted.join(" ")}\n`);
    } else {
      // In JSON mode, diagnostics to stderr only
      process.stderr.write(`spawn: ${redacted.join(" ")}\n`);
    }
  }

  // Delete HERDR_ENV before spawn
  delete (process.env as Record<string, string | undefined>).HERDR_ENV;

  const deps = nodeRunnerDeps();

  // Signal handling
  const _currentProc: { signal: (sig: "SIGTERM" | "SIGKILL") => void } | null = null;
  // We'll need to track the spawned process via deps.signal; but streamTurn owns process handle.
  // Instead we intercept deps.signal via a wrapper that captures proc.
  // Simpler: use deps directly and handle SIGINT by calling process.kill? But spec says via injected signal.
  // We'll create a wrapper deps where signal captures last proc.
  let lastProc: import("../execution/deps.js").SpawnedProcess | null = null;
  const originalSignal = deps.signal;
  const wrappedDeps = {
    ...deps,
    signal: (proc: import("../execution/deps.js").SpawnedProcess, sig: "SIGTERM" | "SIGKILL") => {
      lastProc = proc;
      originalSignal(proc, sig);
    },
    spawn: (argv: readonly string[], opts: import("../execution/deps.js").SpawnOptions) => {
      const proc = deps.spawn(argv, opts);
      lastProc = proc;
      return proc;
    },
  };

  let interrupted = false;
  const onSig = async () => {
    if (interrupted) return;
    interrupted = true;
    if (lastProc) {
      try {
        wrappedDeps.signal(lastProc, "SIGTERM");
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            if (lastProc) {
              try {
                wrappedDeps.signal(lastProc, "SIGKILL");
              } catch {}
            }
            resolve();
          }, KILL_GRACE_MS);
        });
      } catch {}
    }
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const state = createRenderState();
  let lastEvent: HarnessEvent | null = null;
  let exitCode = 0;

  try {
    // streamTurn handles both launch and resume via TurnRunOptions
    const events = streamTurn(h, fullOpts, wrappedDeps);
    for await (const event of events) {
      lastEvent = event;
      if (wantJson) {
        writeEventNdjson(event);
      } else {
        renderEvent(event, state);
      }
      if (event.kind === "done") {
        if (event.cause === "clean") exitCode = 0;
        else exitCode = 1;
        // If failure class is rejected? But done.cause for rejected would be failed? Still 1 per mapping, but refusal before spawn is 2.
        // The RFC says limit/auth ->1, transport ->1, refusal ->2 (already handled). So done non-clean =>1.
      }
      if (event.kind === "limit") {
        // Also ensure exitCode will be 1 (handled via done)
      }
    }
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      if (err.supportedBy?.length) {
        process.stderr.write(
          `supported on: ${err.supportedBy.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
        );
      }
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      return;
    }
    // Transport / spawn failure
    process.stderr.write(`run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (wantJson && lastEvent?.kind !== "done") {
      // Emit failure+done if stream didn't? streamTurn should already emit done, but if we crashed before spawn, synthesize?
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
    process.exitCode = 1;
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    return;
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }

  // If no done event was seen (should not happen), exit 1
  if (lastEvent === null) {
    process.exitCode = 1;
    return;
  }
  if (lastEvent.kind === "done") {
    process.exitCode = exitCode;
  } else {
    // Stream ended without done (e.g., consumer break via head)
    process.exitCode = interrupted ? 1 : 0;
  }

  if (interrupted && process.exitCode === 0) process.exitCode = 1;
};
