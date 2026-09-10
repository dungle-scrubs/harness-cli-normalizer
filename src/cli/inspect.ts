import { capabilitiesOf } from "../interpretation/capabilities.js";
import { canonicalTable, mergeToolMaps } from "../interpretation/tool-vocabulary.js";
import { HARNESS_MODES, type HarnessMode } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { parseCommonFlags } from "./args.js";
import { ConfigError, loadProjectConfig, loadUserConfig } from "./config.js";
import { EXIT_REFUSAL } from "./exit-codes.js";
import { inspectContextCommand } from "./inspect-context.js";
import { inspectSessionRuntime } from "./inspect-session.js";
import { planTurn, writePlanDiagnostics } from "./plan-turn.js";
import { refuse } from "./refuse.js";
import { resolveHarness } from "./resolve-harness.js";
import { runtimeCompatibility } from "./runtime-compatibility.js";

export const inspect = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  const h = resolveHarness(harnessName);
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(rawArgs);
  } catch (err) {
    // Preserve the shared prompt-injection and native-spelling diagnostics.
    const outcome = await planTurn(h, rawArgs, { command: "inspect" });
    if (outcome.kind === "refusal") {
      refuse(outcome.refusal, outcome.wantJson && rawArgs.includes("--context"));
      return;
    }
    throw err;
  }
  const values = parsed.values as Record<string, unknown>;

  if (values.help === true) {
    const { INSPECT_HELP } = await import("./help.js");
    process.stdout.write(INSPECT_HELP);
    return;
  }

  // --argv: the preview is the plan the run command would spawn from, so
  // the two agree by construction (RFC-02 change 10). Refusals go through
  // the shared refuse path like every other command's.
  if (
    (values.capabilities && (values.argv || values.runtime || values.context)) ||
    (values.context && (values.argv || values.runtime))
  ) {
    refuse(
      {
        issue: "invalid-option-value",
        message: "--capabilities and --context are mutually exclusive with other inspection modes",
      },
      values.context === true && values.json === true,
    );
    return;
  }
  if (values.context && values.mode !== undefined && values.mode !== "headless-turn") {
    refuse(
      { issue: "invalid-option-value", message: "--context supports headless-turn only" },
      values.json === true,
    );
    return;
  }
  if (values.context === true) {
    await inspectContextCommand(h, rawArgs);
    return;
  }
  if (values.argv === true || values.runtime === true) {
    if (values.runtime === true && (await inspectSessionRuntime(h, rawArgs))) return;
    const outcome = await planTurn(h, rawArgs, { command: "inspect" });
    if (outcome.kind === "refusal") {
      refuse(outcome.refusal, false);
      return;
    }
    writePlanDiagnostics(h, outcome.plan, "argv");
    if (values.runtime === true) {
      const mode = parseCommonFlags(rawArgs).values.mode ?? "headless-turn";
      if (mode !== "headless-turn" && mode !== "headless-session") {
        refuse(
          {
            message: `invalid runtime mode: ${String(mode)}`,
            issue: "invalid-option-value",
            supported: ["headless-turn", "headless-session"],
          },
          false,
        );
        return;
      }
      const argv = outcome.plan.redactedArgv;
      process.stdout.write(
        `${JSON.stringify({ v: 1, argvKind: "redacted-preview", argv, ...(await runtimeCompatibility(h, { ...outcome.plan.options, mode })) })}\n`,
      );
      return;
    }
    process.stdout.write(`${JSON.stringify(outcome.plan.redactedArgv)}\n`);
    return;
  }

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
  const { admission: _admission, ...resume } = h.resume;
  const out = {
    name: h.name,
    bin: h.bin,
    verifiedAgainst: h.verifiedAgainst,
    versionSource: h.versionSource,
    launch: {
      baseFlags: h.launch.baseFlags,
      subcommands: h.launch.subcommands,
      streamFlags: h.launch.streamFlags,
      stdinPrompt: h.launch.stdinPrompt ?? null,
      promptStyle: h.launch.promptStyle,
      toolsFlag: h.tools.includeFlag,
      idFlag: h.launch.idFlag,
    },
    resume,
    contextInspection: h.contextInspection ?? null,
    nativeContextManagement:
      h.nativeContextManagement === null
        ? null
        : {
            kind: h.nativeContextManagement.kind,
            modes: h.nativeContextManagement.modes,
          },
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
