import { capabilitiesOf } from "../interpretation/capabilities.js";
import { canonicalTable, mergeToolMaps } from "../interpretation/tool-vocabulary.js";
import { HARNESS_MODES, type HarnessMode } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { splitPassthrough } from "./args.js";
import { ConfigError, loadProjectConfig, loadUserConfig } from "./config.js";
import { EXIT_REFUSAL } from "./exit-codes.js";
import { planTurn, writePlanDiagnostics } from "./plan-turn.js";
import { refuse } from "./refuse.js";
import { resolveHarness } from "./resolve-harness.js";

export const inspect = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  const h = resolveHarness(harnessName);
  const { normalized } = splitPassthrough(rawArgs);

  if (normalized.includes("--help") || normalized.includes("-h")) {
    const { INSPECT_HELP } = await import("./help.js");
    process.stdout.write(INSPECT_HELP);
    return;
  }

  // --argv: the preview is the plan the run command would spawn from, so
  // the two agree by construction (RFC-02 change 10). Refusals go through
  // the shared refuse path like every other command's.
  if (normalized.includes("--argv")) {
    if (normalized.includes("--capabilities")) {
      process.stderr.write(`--capabilities and --argv are mutually exclusive; pick one\n`);
      process.exitCode = EXIT_REFUSAL;
      return;
    }
    const outcome = await planTurn(h, rawArgs, { command: "inspect" });
    if (outcome.kind === "refusal") {
      refuse(outcome.refusal, false);
      return;
    }
    writePlanDiagnostics(h, outcome.plan, "argv");
    process.stdout.write(`${JSON.stringify(outcome.plan.redactedArgv)}\n`);
    return;
  }

  // --capabilities path: pure capability record, no spawn, no config, no prompt
  const { parseCommonFlags } = await import("./args.js");
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(rawArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(
      {
        message: `unknown flag: ${message}`,
        issue: "invalid-option-value",
        trailer: ["Run 'hcn inspect --help' for usage."],
      },
      false,
    );
    return;
  }
  const values = parsed.values as Record<string, unknown>;

  if (values.capabilities === true) {
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

  // The descriptor dump, with the tool vocabulary slice the config tiers
  // extend.
  let userMap: ReturnType<typeof loadUserConfig> = null;
  let projectMap: ReturnType<typeof loadProjectConfig> = null;
  try {
    userMap = loadUserConfig();
    projectMap = loadProjectConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      refuse({ message: `config error: ${e.message}`, issue: "invalid-option-value" }, false);
      return;
    }
    throw e;
  }
  const merged = mergeToolMaps({
    user: userMap?.config.toolMap,
    project: projectMap?.config.toolMap,
  });
  const table = canonicalTable(defaultDescriptors());
  const slice: Record<string, unknown> = {};
  const allCanonicalForInspect = [
    ...new Set([...Object.keys(table), ...Object.keys(merged[h.name] ?? {})]),
  ].sort();
  for (const canonical of allCanonicalForInspect) {
    const v = table[canonical]?.[h.name];
    const mapped = merged[h.name]?.[canonical];
    if (mapped !== undefined) {
      slice[canonical] = { native: mapped.native, source: mapped.tier };
    } else if (v !== undefined) {
      slice[canonical] =
        v.kind === "builtin"
          ? { native: v.native, source: "descriptor" }
          : { ...v, source: "descriptor" };
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
      toolsFlag: h.tools.includeFlag,
      idFlag: h.launch.idFlag,
    },
    resume: h.resume,
    sessionMode: h.sessionMode,
    vocabulary: {
      models: h.vocabulary.models,
      aliases: h.vocabulary.aliases,
      efforts: h.vocabulary.efforts,
      effortsByModel: h.vocabulary.effortsByModel,
      extensible: h.vocabulary.extensible,
      modelFlag: h.vocabulary.modelFlag,
    },
    turnOptions: h.turnOptions,
    limitMatchers: h.limitMatchers,
    authMatchers: h.authMatchers,
    toolVocabulary: slice,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
};

export const inspectCommand = inspect;
