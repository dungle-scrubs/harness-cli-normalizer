import { redactArgv } from "../execution/stream-turn.js";
import { buildLaunchArgv } from "../interpretation/argv.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { FloorExceededError, resolveEffectiveOptions } from "../interpretation/resolve-options.js";
import { parseTurnOptions, resolvePromptAsync } from "./args.js";
import { resolveHarness } from "./resolve-harness.js";

export const inspect = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  const h = resolveHarness(harnessName);

  // Check for --help
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { INSPECT_HELP } = await import("./help.js");
    process.stdout.write(INSPECT_HELP);
    return;
  }

  // Check for positional prompt injection before parse (only when --argv and no explicit prompt)
  const { parseCommonFlags, detectPositionalPromptInjection } = await import("./args.js");
  if (rawArgs.includes("--argv")) {
    const injection = detectPositionalPromptInjection(rawArgs.filter((a) => a !== "--argv"));
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
  }

  // Parse flags for inspect
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(rawArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unknown flag: ${message}\n`);
    process.stderr.write(`Run 'hcn inspect --help' for usage.\n`);
    process.exitCode = 2;
    return;
  }

  const values = parsed.values as Record<string, unknown>;
  const wantArgv = values.argv === true;

  if (!wantArgv) {
    // Pure descriptor dump
    const out = {
      name: h.name,
      bin: h.bin,
      verifiedAgainst: h.verifiedAgainst,
      versionSource: h.versionSource,
      launch: {
        baseFlags: h.launch.baseFlags,
        subcommands: h.launch.subcommands,
        streamFlags: h.launch.streamFlags,
        promptStyle: h.launch.promptStyle,
        toolsFlag: h.launch.toolsFlag,
        idFlag: h.launch.idFlag,
      },
      resume: h.resume,
      sessionMode: h.sessionMode,
      vocabulary: {
        models: h.vocabulary.models,
        aliases: h.vocabulary.aliases,
        efforts: h.vocabulary.efforts,
        effortsByModel: (h.vocabulary as { effortsByModel?: unknown }).effortsByModel,
        extensible: h.vocabulary.extensible,
        modelFlag: h.vocabulary.modelFlag,
      },
      turnOptions: h.turnOptions,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  // --argv preview path: need prompt + turn options
  const positional = parsed.positionals as string[];
  // positional[0] would be harness already consumed, but we passed rawArgs without harness - check: caller passes remaining after harness
  // So positionals are potential prompt positional if not using --prompt
  const positionalPrompt = positional.length > 0 ? positional[0] : undefined;
  if (positional.length > 1) {
    process.stderr.write(`too many positionals for inspect --argv\n`);
    process.exitCode = 2;
    return;
  }

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
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  // Build TurnOptions from flags
  let turnOpts: ReturnType<typeof parseTurnOptions>;
  try {
    turnOpts = parseTurnOptions(values);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  // Inspect resolves exactly as a launch would: profile + user config,
  // launch-only semantics, so --argv previews the truth of a bare run.
  const { loadUserConfig, loadProjectConfig, ConfigError } = await import("./config.js");
  const tiers: {
    user?: Partial<ReturnType<typeof parseTurnOptions>>;
    project?: Partial<ReturnType<typeof parseTurnOptions>>;
  } = {};
  try {
    const loaded = loadUserConfig();
    if (loaded !== null) tiers.user = loaded.config;
    const proj = loadProjectConfig();
    if (proj !== null) tiers.project = proj.config;
  } catch (configErr) {
    if (configErr instanceof ConfigError) {
      process.stderr.write(`config error: ${(configErr as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    throw configErr;
  }
  let resolved: ReturnType<typeof resolveEffectiveOptions>;
  try {
    resolved = resolveEffectiveOptions(h, { ...turnOpts, prompt } as never, tiers);
  } catch (resErr) {
    if (resErr instanceof FloorExceededError) {
      process.stderr.write(`${(resErr as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    throw resErr;
  }
  const { prompt: _p, ...effectiveRest } = resolved.options as { prompt: string };
  const fullOpts = {
    ...(effectiveRest as object),
    prompt,
    ...(promptSource !== "positional" ? { __explicitPrompt: true as const } : {}),
  } as Parameters<typeof buildLaunchArgv>[1];

  let argv: string[];
  try {
    argv = buildLaunchArgv(h, fullOpts);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  // Redact prompt for display, but keep structure
  const redacted = redactArgv(argv, prompt);
  // Also handle --resume case: need to use buildResumeArgv if resume present
  if (values.resume !== undefined || values["session-id"] !== undefined) {
    // For inspect --argv with --resume, show resume argv
    const { buildResumeArgv } = await import("../interpretation/argv.js");
    const resumeId = String(values.resume ?? values["session-id"]);
    try {
      const resumeOpts = { ...fullOpts, sessionId: resumeId };
      const resumeArgv = buildResumeArgv(h, resumeOpts);
      const redactedResume = redactArgv(resumeArgv, prompt);
      process.stdout.write(`${JSON.stringify(redactedResume)}\n`);
      process.stderr.write(`argv: ${redactedResume.join(" ")}\n`);
      return;
    } catch (err) {
      if (err instanceof ArgvRefusalError) {
        process.stderr.write(`${err.message}\n`);
        if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  }

  process.stdout.write(`${JSON.stringify(redacted)}\n`);
  process.stderr.write(`argv: ${redacted.join(" ")}\n`);
};

export const inspectCommand = inspect;
