import { redactArgv } from "../execution/stream-turn.js";
import { buildLaunchArgv } from "../interpretation/argv.js";
import { capabilitiesOf } from "../interpretation/capabilities.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { FloorExceededError, resolveEffectiveOptions } from "../interpretation/resolve-options.js";
import { canonicalTable, mergeToolMaps } from "../interpretation/tool-vocabulary.js";
import type { HarnessMode } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { parseTurnOptions, resolvePromptAsync } from "./args.js";
import { ConfigError, loadProjectConfig, loadUserConfig } from "./config.js";
import { EXIT_REFUSAL } from "./exit-codes.js";
import { refusalOf, refuse } from "./refuse.js";
import { resolveHarness } from "./resolve-harness.js";

const HARNESS_MODES = ["headless-turn", "headless-session", "interactive"] as const;

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

  // --capabilities path: pure capability record, no spawn, no config, no prompt
  if (values.capabilities === true) {
    if (wantArgv) {
      process.stderr.write(`--capabilities and --argv are mutually exclusive; pick one\n`);
      process.exitCode = EXIT_REFUSAL;
      return;
    }
    const mode = values.mode === undefined ? "headless-turn" : String(values.mode);
    if (!(HARNESS_MODES as readonly string[]).includes(mode)) {
      process.stderr.write(
        `invalid --mode ${JSON.stringify(mode)}; supported: ${HARNESS_MODES.join(", ")}\n`,
      );
      process.exitCode = EXIT_REFUSAL;
      return;
    }
    const model = values.model === undefined ? "" : String(values.model);
    const caps = capabilitiesOf(h, model, mode as HarnessMode);
    process.stdout.write(`${JSON.stringify(caps)}\n`);
    return;
  }

  // Load config once at top and reuse for both paths
  let rawUserMap: Record<string, Record<string, string>> | undefined;
  let rawProjectMap: Record<string, Record<string, string>> | undefined;
  let loadedTiers: {
    user?: import("../interpretation/argv.js").TurnOptions;
    project?: import("../interpretation/argv.js").TurnOptions;
  } = {};
  try {
    const u = loadUserConfig();
    rawUserMap = (u?.config as { toolMap?: Record<string, Record<string, string>> } | undefined)
      ?.toolMap;
    if (u) loadedTiers = { ...loadedTiers, user: u.config as never };
    const p = loadProjectConfig();
    rawProjectMap = (p?.config as { toolMap?: Record<string, Record<string, string>> } | undefined)
      ?.toolMap;
    if (p) loadedTiers = { ...loadedTiers, project: p.config as never };
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${(e as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const merged = mergeToolMaps({ user: rawUserMap, project: rawProjectMap });

  if (!wantArgv) {
    const table = canonicalTable(defaultDescriptors());
    const slice: Record<string, unknown> = {};
    const allCanonicalForInspect = [
      ...new Set([...Object.keys(table), ...Object.keys(merged[h.name] ?? {})]),
    ].sort();
    for (const canonical of allCanonicalForInspect) {
      const perHarness = table[canonical] as Record<string, unknown> | undefined;
      const v = perHarness?.[h.name];
      const mapped = merged[h.name]?.[canonical];
      if (mapped !== undefined) {
        slice[canonical] = { native: mapped.native, source: mapped.tier };
      } else if (v !== undefined) {
        const vv = v as { kind: string; native?: string; key?: string };
        const val =
          vv.kind === "builtin"
            ? { native: vv.native, source: "descriptor" }
            : { ...vv, source: "descriptor" };
        slice[canonical] = val;
      } else {
        slice[canonical] = { native: null, source: "none" };
      }
    }
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
      limitMatchers: h.limitMatchers,
      authMatchers: h.authMatchers,
      toolVocabulary: slice,
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

  // Mirror run.ts skills resolution (F-16): resolve names and build claude tokens
  const rawSkills = (turnOpts as unknown as { skills?: string[] }).skills;
  if (rawSkills !== undefined && rawSkills.length > 0) {
    try {
      const { resolveSkillNames, listKnownSkills } = await import("./skills-root.js");
      const resolvedSkills = resolveSkillNames(rawSkills, h.name);
      const skillTokens: string[] = [];
      if (h.name === "claude") {
        const { claudeSkillOverridesArg } = await import("../interpretation/skills-selection.js");
        skillTokens.push(...claudeSkillOverridesArg(listKnownSkills(), resolvedSkills));
      } else if (h.name === "codex") {
        const { codexSkillConfigArg } = await import("../interpretation/skills-selection.js");
        skillTokens.push(...codexSkillConfigArg(listKnownSkills(), resolvedSkills));
      }
      (turnOpts as unknown as Record<string, unknown>).skills = resolvedSkills;
      (turnOpts as unknown as Record<string, unknown>).__skillTokens = skillTokens;
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

  // Resume previews from unresolved options, mirroring run.ts launch-only rule (F-15)
  if (values.resume !== undefined || values["session-id"] !== undefined) {
    if (values.resume !== undefined && values["session-id"] !== undefined) {
      const err = new ArgvRefusalError({
        issue: "mutually-exclusive-options",
        harness: h.name,
        supported: ["--resume or --session-id, not both (--session-id is an alias for --resume)"],
        detail: "both --resume and --session-id given",
      });
      process.stderr.write(`${err.message}\n`);
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    const { buildResumeArgv } = await import("../interpretation/argv.js");
    const resumeId = String(values.resume ?? values["session-id"]);
    try {
      const resumeOpts = {
        ...(turnOpts as object),
        prompt,
        sessionId: resumeId,
        ...(promptSource !== "positional" ? { __explicitPrompt: true as const } : {}),
      } as Parameters<typeof buildResumeArgv>[1];
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

  // Reuse already-loaded config for argv preview
  const tiers: {
    user?: Partial<ReturnType<typeof parseTurnOptions>>;
    project?: Partial<ReturnType<typeof parseTurnOptions>>;
  } = {};
  if (loadedTiers.user) tiers.user = loadedTiers.user as never;
  if (loadedTiers.project) tiers.project = loadedTiers.project as never;
  let resolved: ReturnType<typeof resolveEffectiveOptions>;
  try {
    resolved = resolveEffectiveOptions(h, { ...turnOpts, prompt } as never, tiers);
  } catch (resErr) {
    if (resErr instanceof FloorExceededError) {
      process.stderr.write(`${(resErr as Error).message}\n`);
      process.exitCode = 2;
      return;
    }
    if (resErr instanceof ArgvRefusalError) {
      refuse(refusalOf(resErr as ArgvRefusalError), false);
      return;
    }
    throw resErr;
  }
  const { writeProvenance } = await import("./provenance.js");
  writeProvenance(h.name, resolved.provenance, resolved.unrenderable);
  const { prompt: _p, ...effectiveRest } = resolved.options as { prompt: string };
  const fullOpts = {
    ...(effectiveRest as object),
    prompt,
    ...(promptSource !== "positional" ? { __explicitPrompt: true as const } : {}),
  } as Parameters<typeof buildLaunchArgv>[1];

  let argv: string[];
  try {
    argv = buildLaunchArgv(h, fullOpts);
    const skillTokens = (effectiveRest as unknown as { __skillTokens?: string[] }).__skillTokens;
    if (skillTokens !== undefined && skillTokens.length > 0) argv.push(...skillTokens);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      refuse(refusalOf(err as ArgvRefusalError), false);
      return;
    }
    throw err;
  }

  // Redact prompt for display, but keep structure
  const redacted = redactArgv(argv, prompt);

  process.stdout.write(`${JSON.stringify(redacted)}\n`);
  process.stderr.write(`argv: ${redacted.join(" ")}\n`);
};

export const inspectCommand = inspect;
