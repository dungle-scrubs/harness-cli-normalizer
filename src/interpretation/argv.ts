/**
 * Argv construction: pure functions turning a descriptor + launch options
 * into the exact argv a spawner would exec. Ordering rules (positional
 * prompt before tool grants) and the spawn-boundary refusals live here so
 * no caller re-derives them.
 */
import type { HarnessDescriptor, StreamingGranularity } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { ArgvRefusalError } from "./refusal.js";
import { assertUsableSessionId, SESSION_ID_MAX, SessionIdRefusalError } from "./session-id.js";
import { renderSkillsSelection } from "./skills-selection.js";
import { supportedBy } from "./support.js";
import { renderToolSelection } from "./tool-selection.js";
import { renderTurnOptions } from "./turn-options.js";
import { validateModel } from "./vocabulary.js";

export type { RefusalIssue } from "./refusal.js";
export { ArgvRefusalError, buildRefusalMessage, REFUSAL_ISSUES } from "./refusal.js";

/** One guard for every builder that places a positional prompt. Selector
 * hygiene (session ids) lives in session-id.ts; model selectors go through
 * validateModel - both refuse, never sanitize. */
const assertCleanPrompt = (h: HarnessDescriptor, prompt: string): void => {
  if (prompt.startsWith("-")) {
    throw new ArgvRefusalError({
      issue: "prompt-flag-injection",
      harness: h.name,
      supported: ["prompt must not start with '-'"],
      detail: `it would be parsed as a flag by ${h.bin}`,
    });
  }
};

/**
 * Variant that allows a leading '-' when the caller explicitly opted in via
 * --prompt / --prompt-file. The positional guard still applies for implicit
 * positional prompts, but an explicit opt-in bypasses it so `hcn run --prompt "-bad"`
 * succeeds while `hcn run "-bad"` refuses. The caller must set
 * `__explicitPrompt: true` on the options object when the prompt came from an
 * explicit flag.
 */
const assertCleanPromptMaybe = (h: HarnessDescriptor, prompt: string, explicit?: boolean): void => {
  if (explicit) return;
  assertCleanPrompt(h, prompt);
};

export interface DiscoveryOptions {
  readonly tools?: boolean;
  readonly instructionFiles?: boolean;
  readonly extensions?: boolean;
  readonly skills?: boolean;
}

export interface TurnOptions {
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  /** Caller-directed skills allowlist: resolved absolute paths, one per
   * skill. Rendering: pi loads each via --skill with discovery off;
   * claude turns off the complement via skillOverrides settings; codex
   * and muse refuse (structural - no per-skill surface). */
  readonly skills?: readonly string[];
  readonly model?: string;
  readonly autonomy?: boolean;
  readonly effort?: string;
  readonly sandbox?: string;
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
  /** issue #41: question escalation - a BEHAVIOR INSTRUCTION, not a turn
   * option. It never renders into any harness argv; the CLI layer turns
   * it into the prompt preamble and arms question-block detection.
   * Undefined means the default: true. */
  readonly escalateQuestions?: boolean;
  /** Internal: set by CLI when prompt came from --prompt/--prompt-file to bypass leading '-' guard */
  readonly __explicitPrompt?: boolean;
  /** toolMap extensible vocabulary per harness (issue toolMap) */
  readonly toolMap?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly access?: "read" | "write";
}

export interface ResumeOptions extends TurnOptions {
  readonly sessionId: string;
}

export type LaunchOptions = TurnOptions;

/** The shared tail of every headless-turn argv: prompt, stream flags, then
 * validated selections, with the variadic tools flag LAST and fed exactly
 * one joined token so nothing after it can be swallowed as a tool name. */
const turnTail = (h: HarnessDescriptor, opts: TurnOptions): string[] => {
  assertCleanPromptMaybe(h, opts.prompt, opts.__explicitPrompt);
  const tail = [opts.prompt, ...h.launch.streamFlags];
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
    const perHarnessMap = opts.toolMap?.[h.name];
    const rendered = renderToolSelection(h, {
      include: opts.tools,
      exclude: opts.excludeTools,
      toolMap: perHarnessMap,
    });
    tail.push(...rendered.tokens);
  }
  if (opts.skills !== undefined && opts.skills.length > 0) {
    tail.push(...renderSkillsSelection(h, opts.skills));
  }
  return tail;
};

export const buildLaunchArgv = (h: HarnessDescriptor, opts: LaunchOptions): string[] => [
  h.bin,
  ...h.launch.baseFlags,
  ...renderTurnOptions(h, opts, "launch"),
  ...turnTail(h, opts),
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
    ...renderTurnOptions(h, opts, "resume"),
    ...turnTail(h, opts),
  ];
};

export interface SessionOptions {
  readonly sessionId: string;
  readonly model?: string;
  /** Provider selector (pi). A harness with no provider selector refuses,
   * the same way a one-shot turn does. */
  readonly provider?: string;
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
  const argv = [
    h.bin,
    ...h.sessionMode.flags,
    // idFlag null = the harness refuses unknown ids and mints its own
    // (pi rpc); the caller-side sessionId stays a correlation handle.
    ...(h.sessionMode.idFlag !== null ? [h.sessionMode.idFlag, opts.sessionId] : []),
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
    argv.push(h.vocabulary.modelFlag, validated.id);
  }
  if (opts.provider !== undefined) {
    // One dimension, rendered by the same code path a launch argv uses, so
    // the flag spelling and the refusal (with supportedBy) stay identical.
    argv.push(...renderTurnOptions(h, { provider: opts.provider } as TurnOptions, "launch"));
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
