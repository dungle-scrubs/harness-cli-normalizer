/**
 * Argv construction: pure functions turning a descriptor + launch options
 * into the exact argv a spawner would exec. Ordering rules (positional
 * prompt before tool grants) and the spawn-boundary refusals live here so
 * no caller re-derives them.
 */
import type {
  AccessValue,
  HarnessDescriptor,
  StreamingGranularity,
} from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { assertIsolationCombination } from "./isolation.js";
import { ArgvRefusalError } from "./refusal.js";
import { assertAccessExclusivity } from "./resolve-options.js";
import { assertUsableSessionId, SESSION_ID_MAX, SessionIdRefusalError } from "./session-id.js";
import { renderSkillsSelection, type SkillsSelection } from "./skills-selection.js";
import { supportedBy } from "./support.js";
import { renderToolSelection } from "./tool-selection.js";
import type { ToolMap } from "./tool-vocabulary.js";
import { renderTurnOptions } from "./turn-options.js";
import { validateModel } from "./vocabulary.js";

export type { RefusalIssue } from "./refusal.js";
export { ArgvRefusalError, buildRefusalMessage, REFUSAL_ISSUES } from "./refusal.js";

/** A prompt carries its own provenance (RFC-02 change 13): a plain string
 * is an implicit, positional prompt; the object form came from an explicit
 * flag or file, so a leading dash is the caller's intent, not a flag. */
export type Prompt = string | { readonly text: string; readonly explicit: boolean };

/** The one accessor for the prompt's text, for builders, the runner, and
 * redaction alike. */
export const promptTextOf = (opts: { readonly prompt: Prompt }): string =>
  typeof opts.prompt === "string" ? opts.prompt : opts.prompt.text;

/** The same prompt with new text: the composed form keeps its provenance. */
export const withPromptText = (prompt: Prompt, text: string): Prompt =>
  typeof prompt === "string" ? text : { ...prompt, text };

/** One guard for every builder that places a positional prompt: an
 * implicit prompt may not start with '-' (it would be parsed as a flag),
 * while an explicit one - `hcn run --prompt "-bad"` - passes. Selector
 * hygiene (session ids) lives in session-id.ts; model selectors go through
 * validateModel - both refuse, never sanitize. */
const assertCleanPrompt = (h: HarnessDescriptor, prompt: Prompt): void => {
  if (typeof prompt !== "string" && prompt.explicit) return;
  if (promptTextOf({ prompt }).startsWith("-")) {
    throw new ArgvRefusalError({
      issue: "prompt-flag-injection",
      harness: h.name,
      supported: ["prompt must not start with '-'"],
      detail: `it would be parsed as a flag by ${h.bin}`,
    });
  }
};

export interface DiscoveryOptions {
  readonly tools?: boolean;
  readonly instructionFiles?: boolean;
  readonly extensions?: boolean;
  readonly skills?: boolean;
}

export interface TurnOptions {
  readonly isolation?: "tool-free";
  readonly prompt: Prompt;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  /** Caller-directed skills allowlist: the resolved picks and the
   * registry's known names. Rendered per descriptor by
   * renderSkillsSelection (pi loads each pick with discovery off; claude
   * and codex turn the complement off); muse refuses. */
  readonly skills?: SkillsSelection;
  readonly model?: string;
  readonly autonomy?: boolean;
  readonly effort?: string;
  readonly sandbox?: string;
  readonly contextWindow?: number;
  readonly provider?: string;
  readonly discovery?: DiscoveryOptions;
  readonly write?: boolean;
  readonly shell?: boolean;
  readonly maxSteps?: number;
  /** issue #48: replaces the harness's built-in system prompt (opt-in-only,
   * no profile entry). claude/pi: flag-value (claude pairs the dynamic-section
   * exclusion); codex: config-kv `instructions` (literal or path); muse:
   * refuses with hint. */
  readonly systemPrompt?: string;
  /** issue #48: appends to the built-in prompt (claude/pi only). */
  readonly appendSystemPrompt?: string;
  /** question mode: which preamble hcn injects (ask/assume/none).
   * A BEHAVIOR INSTRUCTION, not a turn option. It never renders into any
   * harness argv; the CLI layer turns it into the prompt preamble and
   * arms question-block detection. Undefined means the default: "ask". */
  readonly questions?: import("./question.js").QuestionMode;
  /** The merged toolMap (every harness, native plus tier), the one shape
   * past option resolution (RFC-02 change 8). */
  readonly toolMap?: ToolMap;
  readonly access?: AccessValue;
}

export interface ResumeOptions extends TurnOptions {
  readonly sessionId: string;
}

export type LaunchOptions = TurnOptions;

/** Returns the exact text to pipe, or null when it travels in argv. */
export function stdinPromptOf(h: HarnessDescriptor, opts: TurnOptions): string | null {
  const transport = h.launch.stdinPrompt;
  if (!transport) return null;
  const text = promptTextOf(opts);
  if (text.length <= transport.aboveBytes / 3) return null;
  return text.length > transport.aboveBytes ||
    new TextEncoder().encode(text).byteLength > transport.aboveBytes
    ? text
    : null;
}

/** The shared tail of every headless-turn argv: prompt, stream flags, then
 * validated selections, with the variadic tools flag LAST and fed exactly
 * one joined token so nothing after it can be swallowed as a tool name. */
const turnTail = (h: HarnessDescriptor, opts: TurnOptions): string[] => {
  const stdinPrompt = stdinPromptOf(h, opts);
  if (stdinPrompt === null) assertCleanPrompt(h, opts.prompt);
  const tail = [
    stdinPrompt === null ? promptTextOf(opts) : (h.launch.stdinPrompt?.argument ?? ""),
    ...h.launch.streamFlags,
  ];
  if (opts.model !== undefined) {
    const validated = validateModel(h, opts.model);
    if (!validated.ok) {
      const supported = [...h.vocabulary.models, ...Object.keys(h.vocabulary.aliases)];
      throw new ArgvRefusalError({
        issue: "unknown-model",
        harness: h.name,
        supported: supported.length ? supported : ["no curated models"],
        detail: opts.model,
      });
    }
    tail.push(h.vocabulary.modelFlag, validated.id);
  }
  if (opts.autonomy === true) {
    if (h.autonomy === null) {
      const by = supportedBy(defaultDescriptors(), "autonomy");
      throw new ArgvRefusalError({
        issue: "no-autonomy-mode",
        harness: h.name,
        supported: by.map((e) => `${e.harness} ${e.spelling}`),
        supportedBy: by,
        hint: "pi has no unattended-run flag; approximate with a per-tool allowlist (--tools read,bash) if you need unattended behavior on pi",
      });
    }
    tail.push(h.autonomy.flag);
  }
  if (opts.tools !== undefined || opts.excludeTools !== undefined) {
    const rendered = renderToolSelection(h, {
      include: opts.tools,
      exclude: opts.excludeTools,
      toolMap: opts.toolMap,
    });
    tail.push(...rendered.tokens);
  }
  if (opts.skills !== undefined) {
    tail.push(...renderSkillsSelection(h, opts.skills));
  }
  return tail;
};

export const buildLaunchArgv = (h: HarnessDescriptor, opts: LaunchOptions): string[] => [
  h.bin,
  ...h.launch.baseFlags,
  ...renderTurnOptions(h, opts, "launch", "before-prompt"),
  ...turnTail(h, opts),
  ...renderTurnOptions(h, opts, "launch", "after-prompt"),
];

/** A session id that fails the shape rule is a spawn-boundary refusal like
 * any other: typed, so streamTurn turns it into failure + done and the CLI
 * exits 2, instead of a bare SessionIdRefusalError escaping the runner. */
const refuseUnusableSessionId = (h: HarnessDescriptor, sessionId: string): void => {
  try {
    assertUsableSessionId(sessionId);
  } catch (e) {
    if (!(e instanceof SessionIdRefusalError)) throw e;
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      message: `${h.name} cannot resume ${e.message}`,
      supported: [
        `a session id of letters, digits, '.', '_', ':', '@', '-' only, starting with a letter or digit, at most ${SESSION_ID_MAX} chars`,
      ],
      detail: e.message,
    });
  }
};

export const buildResumeArgv = (h: HarnessDescriptor, opts: ResumeOptions): string[] => {
  refuseUnusableSessionId(h, opts.sessionId);
  assertAccessExclusivity(h, opts);
  // Subcommands lead, then the resume token and id, then the flags the
  // RESUME grammar accepts (never inherited launch flags - codex exec
  // resume rejects --sandbox). One shape serves both styles:
  // `claude --resume <id> -p <prompt>`, `codex exec resume <id> --json
  // <prompt>`, `muse exec --session-id <id> <prompt>`.
  return [
    h.bin,
    ...h.launch.subcommands,
    h.resume.flag,
    opts.sessionId,
    ...h.resume.extraFlags,
    ...renderTurnOptions(h, opts, "resume", "before-prompt"),
    ...turnTail(h, opts),
    ...renderTurnOptions(h, opts, "resume", "after-prompt"),
  ];
};

/** What a spawn needs beyond the turn options: the session to resume, if
 * any, and the raw passthrough tail (ADR 0003). */
export interface SpawnArgvOptions extends TurnOptions {
  readonly resume?: string;
  readonly passthrough?: readonly string[];
}

/** The argv a turn spawns: launch or resume per `resume`, then the
 * passthrough tail after a bare separator. One owner, so the CLI's preview
 * and the runner's spawn agree by construction (RFC-02 change 10). */
export const buildSpawnArgv = (h: HarnessDescriptor, opts: SpawnArgvOptions): string[] => {
  assertIsolationCombination(h, opts);
  const base =
    opts.resume === undefined
      ? buildLaunchArgv(h, opts)
      : buildResumeArgv(h, { ...opts, sessionId: opts.resume });
  return opts.passthrough !== undefined && opts.passthrough.length > 0
    ? [...base, "--", ...opts.passthrough]
    : base;
};

export interface SessionOptions {
  readonly sessionId: string;
  readonly model?: string;
  /** Effort level, validated against the ladder that applies to the pick
   * (the model's own ladder where the harness constrains per model, else
   * the harness-wide one) - the same validation a one-shot turn applies.
   * No profile entry: a session without --effort runs at the harness's
   * own default effort, never a pinned one. */
  readonly effort?: string;
  /** Provider selector (pi). A harness with no provider selector refuses,
   * the same way a one-shot turn does. */
  readonly provider?: string;
  /** True when this argv should resume an existing conversation, false for a
   * fresh session. Controls which descriptor flag is rendered: resumeFlag
   * vs idFlag. Only consumers that alias --resume/--session-id set this. */
  readonly isResume?: boolean;
}

export const buildSessionArgv = (h: HarnessDescriptor, opts: SessionOptions): string[] => {
  if (!h.sessionMode) {
    const supported = Object.values(defaultDescriptors())
      .filter((d): d is HarnessDescriptor => d !== undefined && d.sessionMode !== null)
      .map((d) => d.name);
    throw new ArgvRefusalError({
      issue: "no-session-mode",
      harness: h.name,
      supported,
    });
  }
  refuseUnusableSessionId(h, opts.sessionId);
  const flag = opts.isResume ? h.sessionMode.resumeFlag : h.sessionMode.idFlag;
  const argv = [h.bin, ...h.sessionMode.flags, ...(flag !== null ? [flag, opts.sessionId] : [])];
  if (opts.model !== undefined) {
    const validated = validateModel(h, opts.model);
    if (!validated.ok) {
      const supported = [...h.vocabulary.models, ...Object.keys(h.vocabulary.aliases)];
      throw new ArgvRefusalError({
        issue: "unknown-model",
        harness: h.name,
        supported: supported.length ? supported : ["no curated models"],
        detail: opts.model,
      });
    }
    argv.push(h.vocabulary.modelFlag, validated.id);
  }
  if (opts.provider !== undefined || opts.effort !== undefined) {
    // Both dimensions render through the same code path a launch argv uses,
    // so the flag spelling and the refusal (with supportedBy) stay
    // identical. The model rides along INERT for rendering - it is not a
    // turnOptions key - but effort validation reads it, so a per-model
    // effort ladder (effortsByModel) constrains the session spawn exactly
    // as it constrains a one-shot turn.
    argv.push(
      ...renderTurnOptions(
        h,
        {
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        } as TurnOptions,
        "launch",
      ),
    );
  }
  return argv;
};

/** Canonicalize an argv into a last-wins flag map: `--flag=value` splits,
 * `--flag value` consumes the following non-flag token as its value, a flag
 * followed by another flag is boolean. Positional tokens are skipped, so a
 * value can never satisfy a boolean pin member. Aliases map onto canonical
 * spellings. Known limitation: a crafted argv giving a pin member as the
 * value of an unknown variadic flag can still false-positive - full CLI
 * grammar is unknowable from outside. */
const flagMapOf = (h: HarnessDescriptor, argv: readonly string[]): Map<string, string | true> => {
  const map = new Map<string, string | true>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("-")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      const name = token.slice(0, eq);
      map.set(h.output.flagAliases[name] ?? name, token.slice(eq + 1));
      continue;
    }
    const name = h.output.flagAliases[token] ?? token;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      map.set(name, next);
      i++;
    } else {
      map.set(name, true);
    }
  }
  return map;
};

const pinSatisfied = (
  pin: readonly string[],
  flags: ReadonlyMap<string, string | true>,
): boolean => {
  for (let i = 0; i < pin.length; i++) {
    const member = pin[i];
    if (member === undefined || !member.startsWith("-")) continue;
    const expected = pin[i + 1];
    const actual = flags.get(member);
    if (actual === undefined) return false;
    if (expected !== undefined && !expected.startsWith("-") && actual !== expected) {
      return false;
    }
  }
  return true;
};

/** The granularity an invocation will actually emit: pins are checked in
 * order, first fully-satisfied pin wins (every member present with its
 * pinned value, last occurrence winning like the CLIs themselves); an argv
 * satisfying no pin gets the floor. */
export const streamingGranularityOf = (
  h: HarnessDescriptor,
  argv: readonly string[],
): StreamingGranularity => {
  if (h.output.pins.length === 0) return h.output.floor;
  const flags = flagMapOf(h, argv);
  for (const pin of h.output.pins) {
    if (pinSatisfied(pin.flags, flags)) return pin.granularity;
  }
  return h.output.floor;
};
