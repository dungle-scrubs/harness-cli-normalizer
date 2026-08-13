/**
 * Argv construction: pure functions turning a descriptor + launch options
 * into the exact argv a spawner would exec. Ordering rules (positional
 * prompt before tool grants) and the spawn-boundary refusals live here so
 * no caller re-derives them.
 */
import type { HarnessDescriptor, StreamingGranularity } from "../knowledge/descriptor.js";
import { ArgvRefusalError } from "./refusal.js";
import { assertUsableSessionId } from "./session-id.js";
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

export interface DiscoveryOptions {
  readonly tools?: boolean;
  readonly instructionFiles?: boolean;
  readonly extensions?: boolean;
  readonly skills?: boolean;
}

export interface TurnOptions {
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly autonomy?: boolean;
  readonly effort?: string;
  readonly sandbox?: string;
  readonly provider?: string;
  readonly discovery?: DiscoveryOptions;
  readonly write?: boolean;
  readonly shell?: boolean;
  readonly maxSteps?: number;
}

export interface ResumeOptions extends TurnOptions {
  readonly sessionId: string;
}

export type LaunchOptions = TurnOptions;

/** The shared tail of every headless-turn argv: prompt, stream flags, then
 * validated selections, with the variadic tools flag LAST and fed exactly
 * one joined token so nothing after it can be swallowed as a tool name. */
const turnTail = (h: HarnessDescriptor, opts: TurnOptions): string[] => {
  assertCleanPrompt(h, opts.prompt);
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
      throw new ArgvRefusalError({
        issue: "no-autonomy-mode",
        harness: h.name,
        supported: ["claude --dangerously-skip-permissions", "codex --yolo", "muse --yolo"],
      });
    }
    tail.push(h.autonomy.flag);
  }
  if (opts.tools !== undefined) {
    if (h.launch.toolsFlag === null) {
      throw new ArgvRefusalError({
        issue: "unsupported-option",
        harness: h.name,
        supported: ["--allowedTools is claude-only"],
        detail: "tools",
      });
    }
    if (opts.tools.length === 0 || opts.tools.some((t) => t.trim() === "" || t.includes(","))) {
      throw new ArgvRefusalError({
        issue: "invalid-tool-grant",
        harness: h.name,
        supported: ["non-empty, comma-free tool names"],
        detail: `tools=${JSON.stringify(opts.tools)}`,
      });
    }
    tail.push(h.launch.toolsFlag, opts.tools.join(","));
  }
  return tail;
};

export const buildLaunchArgv = (h: HarnessDescriptor, opts: LaunchOptions): string[] => [
  h.bin,
  ...h.launch.baseFlags,
  ...renderTurnOptions(h, opts, "launch"),
  ...turnTail(h, opts),
];

export const buildResumeArgv = (h: HarnessDescriptor, opts: ResumeOptions): string[] => {
  assertUsableSessionId(opts.sessionId);
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
}

export const buildSessionArgv = (h: HarnessDescriptor, opts: SessionOptions): string[] => {
  if (!h.sessionMode) {
    throw new ArgvRefusalError({
      issue: "no-session-mode",
      harness: h.name,
      supported: ["session is claude-only"],
    });
  }
  assertUsableSessionId(opts.sessionId);
  const argv = [
    h.bin,
    ...h.launch.baseFlags,
    ...h.sessionMode.flags,
    h.sessionMode.idFlag,
    opts.sessionId,
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
