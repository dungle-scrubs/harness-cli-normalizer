/**
 * planTurn: the one owner of the parse-refuse-resolve-build protocol
 * (RFC-02 change 10). Raw arguments and config tiers in; the argv a turn
 * spawns, the runner options, the provenance, and the resolved behaviour
 * out - or one structured refusal. The run command spawns from the plan
 * and the inspect command previews from it, so the spawn line and the
 * preview agree by construction, skill tokens and passthrough included.
 */

import { nativeApprovalPreflightEvidence } from "../execution/failure.js";
import { nativeApprovalPlan } from "../execution/native-approval-plan.js";
import type { NativeSettingsInspector } from "../execution/native-settings.js";
import { nodeNativeSettingsInspector } from "../execution/node-deps.js";
import { redactArgv, type TurnRunOptions } from "../execution/stream-turn.js";
import { verifyNativeSettings } from "../execution/verified-native-settings.js";
import {
  buildSpawnArgv,
  buildTurnEnv,
  promptTextOf,
  stdinPromptOf,
} from "../interpretation/argv.js";
import { assertIsolationCombination } from "../interpretation/isolation.js";
import { composeEscalatedPrompt } from "../interpretation/question.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import {
  type ConfigTier,
  type ConfigTiers,
  FloorExceededError,
  type ProvenanceEntry,
  type ResolvedBehavior,
  resolveBehavior,
  resolveEffectiveOptions,
  type UnrenderableEntry,
} from "../interpretation/resolve-options.js";
import { recognizeNativeSpelling, supportedBy } from "../interpretation/support.js";
import { renderToolSelection } from "../interpretation/tool-selection.js";
import { resolveEffortSlug } from "../interpretation/vocabulary.js";
import type { HarnessDescriptor, HarnessName } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import {
  detectPositionalPromptInjection,
  parseCommonFlags,
  parseRunExtra,
  parseTurnOptions,
  resolvePromptAsync,
  splitPassthrough,
} from "./args.js";
import { ConfigError, loadProjectConfig, loadUserConfig } from "./config.js";
import { writeProvenance } from "./provenance.js";
import { type Refusal, refusalOf } from "./refuse.js";
import { listKnownSkills, resolveSkillNames } from "./skills-root.js";

/** The impure edges a plan reads through, injectable for tests. */
export interface PlanDeps {
  readonly inspectNativeSettings?: NativeSettingsInspector;
  readonly loadUserConfig: () => { readonly config: ConfigTier } | null;
  readonly loadProjectConfig: () => { readonly config: ConfigTier } | null;
  readonly listKnownSkills: () => readonly string[];
  readonly resolveSkillNames: (names: readonly string[], harness: HarnessName) => string[];
  readonly readPrompt: (args: {
    positionalPrompt?: string;
    promptFlag?: string;
    promptFile?: string;
  }) => Promise<{ prompt: string; source: string }>;
}

export const defaultPlanDeps: PlanDeps = {
  inspectNativeSettings: nodeNativeSettingsInspector,
  loadUserConfig,
  loadProjectConfig,
  listKnownSkills,
  resolveSkillNames,
  readPrompt: resolvePromptAsync,
};

export interface TurnPlan {
  /** Decided before any refusal can fire: a refused --json run still owes
   * the stream its terminal pair. */
  readonly wantJson: boolean;
  /** Everything the runner takes: the composed prompt, the resolved turn
   * options (raw ones on resume), cwd, env, resume, question mode, and
   * the passthrough tail. */
  readonly options: TurnRunOptions;
  /** The argv the runner will spawn, built by the same owner it uses. */
  readonly argv: readonly string[];
  readonly redactedArgv: readonly string[];
  /** Launch-only; empty on resume, where omitted options follow native behavior. */
  readonly provenance: readonly ProvenanceEntry[];
  readonly unrenderable: readonly UnrenderableEntry[];
  readonly behavior: ResolvedBehavior;
  /** Tool names the grant passes through ungated, for the provenance line. */
  readonly nativeTools: readonly string[];
}

export type PlanOutcome =
  | { readonly kind: "plan"; readonly plan: TurnPlan }
  | { readonly kind: "refusal"; readonly refusal: Refusal; readonly wantJson: boolean };

export interface PlanRequest {
  /** Names the command in usage trailers. */
  readonly command: "run" | "inspect";
}

/** The refusal for an unknown flag: a native spelling typed before the
 * separator is recognized and redirected to the normalized flag (ADR 0003,
 * D7 part B); anything else keeps the plain unknown-flag error. */
const unknownFlagRefusal = (
  message: string,
  rawArgs: readonly string[],
  command: PlanRequest["command"],
): Refusal => {
  // parseArgs reports unknown long flags as "Unknown option '--x'" but
  // splits bundled short flags ("-nt" -> "Unknown option 'n'"). Match the
  // reported token back against the ORIGINAL argv: a short-flag bundle
  // that some descriptor spells exactly (pi's -nt) is recognizable; a
  // lone unknown token keeps the plain error.
  const flagMatch = message.match(/Unknown option '([A-Za-z0-9_-]+)'/);
  let rawFlag: string | undefined;
  if (flagMatch?.[1] !== undefined) {
    const reported = flagMatch[1].startsWith("-") ? flagMatch[1] : `-${flagMatch[1]}`;
    const fromArgv =
      rawArgs.find((a) => a === reported) ??
      (reported.length === 2
        ? rawArgs.find((a) => a.length > 2 && a.startsWith(reported))
        : undefined);
    rawFlag = fromArgv ?? reported;
  }
  const trailer = [`Run 'hcn ${command} --help' for usage.`];
  const native =
    rawFlag !== undefined ? recognizeNativeSpelling(defaultDescriptors(), rawFlag) : null;
  if (native === null) {
    return { message: `unknown flag: ${message}`, issue: "invalid-option-value", trailer };
  }
  const by = native.option.startsWith("discovery.")
    ? native.entries
    : supportedBy(defaultDescriptors(), native.option);
  const facet = native.option.split(".")[1];
  const normalizedSpelling =
    native.option === "excludeTools"
      ? "--exclude-tools"
      : native.option.startsWith("discovery.")
        ? `--no-${facet === "instructionFiles" ? "instruction-files" : facet}`
        : `--${native.option}`;
  return {
    message: `unknown flag: ${rawFlag} is a native spelling (used by ${native.entries.map((e) => e.harness).join(", ")}) - use the normalized ${normalizedSpelling} flag instead`,
    issue: "invalid-option-value",
    supportedBy: by,
    trailer,
  };
};

export const planTurn = async (
  h: HarnessDescriptor,
  rawArgs: readonly string[],
  request: PlanRequest,
  deps: PlanDeps = defaultPlanDeps,
): Promise<PlanOutcome> => {
  const { normalized, passthrough } = splitPassthrough(rawArgs);
  const wantJson = normalized.includes("--json");
  const refusal = (r: Refusal): PlanOutcome => ({
    kind: "refusal",
    refusal: normalized.includes("--native-approvals")
      ? {
          ...r,
          nativeApproval: nativeApprovalPreflightEvidence(r.issue),
        }
      : r,
    wantJson,
  });
  const refused = (err: ArgvRefusalError): PlanOutcome => refusal(refusalOf(err));

  const injection = detectPositionalPromptInjection([...rawArgs]);
  if (injection) {
    return refused(
      new ArgvRefusalError({
        issue: "prompt-flag-injection",
        harness: h.name,
        supported: ["prompt must not start with '-'"],
        detail: `it would be parsed as a flag by ${h.bin}`,
      }),
    );
  }

  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags([...rawArgs], {
      nativeSettingsFingerprint: true,
      nativeApprovals: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refusal(unknownFlagRefusal(message, rawArgs, request.command));
  }
  const values = parsed.values as Record<string, unknown>;
  if (
    values["native-settings-fingerprint"] !== undefined &&
    values.mode !== undefined &&
    values.mode !== "headless-turn"
  ) {
    return refusal({
      issue: "invalid-option-value",
      message: "--native-settings-fingerprint supports headless-turn only",
    });
  }
  if (
    values["native-approvals"] === true &&
    (!wantJson || values["prompt-file"] === "-" || !values["native-settings-fingerprint"])
  )
    return refusal({
      issue: "invalid-option-value",
      message: "native approvals require --json, saved settings and a prompt outside stdin",
    });
  const positionals = parsed.positionals as string[];
  if (positionals.length > 1) {
    return refusal({
      message: `too many positionals for ${request.command}; expected one prompt`,
      issue: "invalid-option-value",
    });
  }
  if (passthrough.length === 0 && rawArgs.includes("--")) {
    return refusal({
      message: "-- separator given but no passthrough tokens followed it",
      issue: "invalid-option-value",
    });
  }

  let prompt: string;
  let explicitPrompt: boolean;
  try {
    const resolved = await deps.readPrompt({
      positionalPrompt: positionals[0],
      promptFlag: values.prompt as string | undefined,
      promptFile: values["prompt-file"] as string | undefined,
    });
    prompt = resolved.prompt;
    explicitPrompt = resolved.source !== "positional";
  } catch (err) {
    if (err instanceof ArgvRefusalError) return refused(err);
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return refusal({
        message: `prompt file not found: ${err.message}`,
        issue: "invalid-option-value",
      });
    }
    throw err;
  }

  let turnOpts: ReturnType<typeof parseTurnOptions>;
  let extra: ReturnType<typeof parseRunExtra>;
  try {
    turnOpts = parseTurnOptions(values);
    extra = parseRunExtra(values);
    assertIsolationCombination(h, { ...turnOpts, passthrough });
  } catch (err) {
    if (err instanceof ArgvRefusalError) return refused(err);
    throw err;
  }

  // issue #38: skill names resolve against the caller's registry root (an
  // fs read, the CLI's); the descriptor renders them (RFC-02 change 2).
  const { skillNames, ...turnOptsSansNames } = turnOpts;
  turnOpts = turnOptsSansNames;
  if (skillNames !== undefined && skillNames.length > 0) {
    try {
      turnOpts = {
        ...turnOpts,
        skills: {
          picks: deps.resolveSkillNames(skillNames, h.name),
          known: deps.listKnownSkills(),
        },
      };
    } catch (err) {
      if (err instanceof ArgvRefusalError) return refused(err);
      throw err;
    }
  }

  // Config files load on EVERY run, launch or resume: the tiers feed the
  // defaults profile on launch, and hcn-owned behaviour (question mode,
  // timeout) resolves from them on resume too - otherwise a no-ask
  // session would flip its preamble on the answer turn.
  const tiers: { user?: ConfigTier; project?: ConfigTier } = {};
  try {
    const user = deps.loadUserConfig();
    if (user !== null) tiers.user = user.config;
    const project = deps.loadProjectConfig();
    if (project !== null) tiers.project = project.config;
  } catch (err) {
    if (err instanceof ConfigError) {
      return refusal({ message: `config error: ${err.message}`, issue: "invalid-option-value" });
    }
    throw err;
  }

  // Defaults profile + config: LAUNCH-ONLY. Omitted settings follow native
  // behavior on resume; the resolver never runs on resume paths.
  let effectiveTurnOpts = turnOpts;
  let provenance: readonly ProvenanceEntry[] = [];
  let unrenderable: readonly UnrenderableEntry[] = [];
  if (extra.resume === undefined) {
    try {
      const resolved = resolveEffectiveOptions(h, { ...turnOpts, prompt }, tiers as ConfigTiers);
      const { prompt: _prompt, ...rest } = resolved.options;
      effectiveTurnOpts = rest as typeof turnOpts;
      provenance = resolved.provenance;
      unrenderable = resolved.unrenderable;
    } catch (err) {
      if (err instanceof FloorExceededError) {
        return refusal({ message: err.message, issue: "invalid-tool-grant" });
      }
      if (err instanceof ArgvRefusalError) return refused(err);
      throw err;
    }
  }

  const behavior = resolveBehavior(
    { questions: turnOpts.questions, timeoutSeconds: extra.timeoutSeconds },
    tiers as ConfigTiers,
  );

  // RFC-05: on an effort-in-model harness the resolved slug replaces
  // opts.model once, on launch and resume alike, before buildSpawnArgv -
  // so capabilities, provenance, and the decoder see the slug that runs.
  // Only arg-tier --effort enforces (turnOpts carries the parsed args);
  // the model rides from any tier (arg --model, else the resolved
  // config-tier model on launch) or none. The step also runs when a model
  // from any tier is present without effort, so a bare stem refuses with
  // its row instead of reaching turnTail's full-list unknown-model. A
  // resolver refusal surfaces like any other argv refusal. Provenance
  // keeps the supplying entry's tier and takes the slug as its value;
  // when no model entry exists an arg-tier one is appended - but only
  // when the slug differs, so a valid slug without effort leaves
  // provenance untouched. Never on resume, where provenance stays absent
  // as today.
  const effortModel = turnOpts.model ?? effectiveTurnOpts.model;
  if (
    (turnOpts.effort !== undefined || effortModel !== undefined) &&
    h.turnOptions.effort?.kind === "effort-in-model"
  ) {
    let slug: string | undefined;
    try {
      slug = resolveEffortSlug(h, effortModel, turnOpts.effort);
    } catch (err) {
      if (err instanceof ArgvRefusalError) return refused(err);
      throw err;
    }
    if (slug !== undefined && slug !== effortModel) {
      effectiveTurnOpts = { ...effectiveTurnOpts, model: slug };
      if (extra.resume === undefined) {
        provenance = provenance.some((p) => p.key === "model")
          ? provenance.map((p) => (p.key === "model" ? { ...p, value: slug } : p))
          : [...provenance, { key: "model", value: slug, tier: "arg" }];
      }
    }
  }

  // The prompt here is the COMPOSED one (escalation preamble included):
  // redactArgv masks by position, so an argv built from the raw prompt
  // would leak it into the spawn line. It carries its provenance: an
  // explicit prompt (flag or file) may start with a dash.
  const options: TurnRunOptions = {
    ...effectiveTurnOpts,
    ...(values["native-approvals"] === true ? { nativeApprovals: true } : {}),
    prompt: {
      text: composeEscalatedPrompt(prompt, behavior.questions.value),
      explicit: explicitPrompt,
    },
    ...(extra.cwd !== undefined ? { cwd: extra.cwd } : {}),
    ...(extra.env !== undefined ? { env: extra.env } : {}),
    ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
    ...(values["native-settings-fingerprint"] !== undefined
      ? { nativeSettingsFingerprint: String(values["native-settings-fingerprint"]) }
      : {}),
    questions: behavior.questions.value,
    ...(passthrough.length > 0 ? { passthrough } : {}),
  };

  let argv: string[];
  try {
    if (options.nativeApprovals)
      argv = nativeApprovalPlan(h, options, deps.inspectNativeSettings).argv;
    else {
      const verifiedNativeSettings = verifyNativeSettings(h, options, deps.inspectNativeSettings);
      argv = buildSpawnArgv(h, { ...options, verifiedNativeSettings });
    }
  } catch (err) {
    if (err instanceof ArgvRefusalError) return refused(err);
    throw err;
  }

  // On a harness whose include flag is not a strict allowlist (claude), a
  // name outside the curated set passes through ungated; say which ones so
  // a wrong-case name is visible.
  let nativeTools: readonly string[] = [];
  const grant = effectiveTurnOpts.tools;
  if (grant !== undefined && grant.length > 0) {
    try {
      nativeTools = renderToolSelection(h, {
        include: [...grant],
        toolMap: options.toolMap,
      }).passthrough;
    } catch {
      // the builder above already refused
    }
  }

  return {
    kind: "plan",
    plan: {
      wantJson,
      options,
      argv,
      redactedArgv: redactArgv(argv, promptTextOf(options), stdinPromptOf(h, options) !== null),
      provenance,
      unrenderable,
      behavior,
      nativeTools,
    },
  };
};

/** The diagnostics a plan prints to stderr - never stdout, which carries
 * the NDJSON contract: provenance and divergence, the argv line under the
 * given label, the question-mode provenance, and the native tool names. */
export const writePlanDiagnostics = (
  h: HarnessDescriptor,
  plan: TurnPlan,
  label: "spawn" | "argv",
): void => {
  writeProvenance(h.name, plan.provenance, plan.unrenderable);
  const env = buildTurnEnv(
    h,
    plan.options,
    plan.options.resume === undefined ? "launch" : "resume",
  );
  if (Object.keys(env).length > 0) {
    process.stderr.write(
      `env: ${Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}\n`,
    );
  }
  process.stderr.write(
    `${label}: ${plan.redactedArgv.map((token) => (token === "" ? '""' : token)).join(" ")}\n`,
  );
  process.stderr.write(
    `provenance: questions = ${plan.behavior.questions.value} (${plan.behavior.questions.tier})\n`,
  );
  if (plan.nativeTools.length > 0) {
    process.stderr.write(`provenance: native tools = ${JSON.stringify(plan.nativeTools)}\n`);
  }
};
