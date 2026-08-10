/**
 * Argv construction: pure functions turning a descriptor + launch options
 * into the exact argv a spawner would exec. Ordering rules (positional
 * prompt before tool grants) and the spawn-boundary refusals live here so
 * no caller re-derives them.
 */
import type { HarnessDescriptor, StreamingGranularity } from "../knowledge/descriptor.js";
import { assertUsableSessionId } from "./session-id.js";
import { validateModel } from "./vocabulary.js";

/** Raised when launch options would corrupt or subvert the spawned argv. */
export class ArgvRefusalError extends Error {
  constructor(
    readonly issue: string,
    message: string,
  ) {
    super(message);
    this.name = "ArgvRefusalError";
  }
}

/** One guard for every builder that places a positional prompt. Selector
 * hygiene (session ids) lives in session-id.ts; model selectors go through
 * validateModel - both refuse, never sanitize. */
const assertCleanPrompt = (h: HarnessDescriptor, prompt: string): void => {
  if (prompt.startsWith("-")) {
    throw new ArgvRefusalError(
      "prompt-flag-injection",
      `positional prompt may not start with '-'; it would be parsed as a flag by ${h.bin}`,
    );
  }
};

export interface TurnOptions {
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly autonomy?: boolean;
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
    if (!validated.ok) throw new ArgvRefusalError("unknown-model", validated.reason);
    tail.push(h.vocabulary.modelFlag, validated.id);
  }
  if (opts.autonomy === true) {
    if (h.autonomy === null) {
      throw new ArgvRefusalError("no-autonomy-mode", `${h.bin} has no unattended-run flag`);
    }
    tail.push(h.autonomy.flag);
  }
  if (opts.tools !== undefined && h.launch.toolsFlag !== null) {
    if (opts.tools.length === 0 || opts.tools.some((t) => t.trim() === "" || t.includes(","))) {
      throw new ArgvRefusalError(
        "invalid-tool-grant",
        `tool grant for ${h.bin} contains an empty entry or a comma; a blank ${h.launch.toolsFlag} value grants nothing detectable, and a comma inside one name silently splits the grant`,
      );
    }
    tail.push(h.launch.toolsFlag, opts.tools.join(","));
  }
  return tail;
};

export const buildLaunchArgv = (h: HarnessDescriptor, opts: LaunchOptions): string[] => [
  h.bin,
  ...h.launch.baseFlags,
  ...turnTail(h, opts),
];

export const buildResumeArgv = (h: HarnessDescriptor, opts: ResumeOptions): string[] => {
  assertUsableSessionId(opts.sessionId);
  // Both styles reduce to `<token> <id>`: a flag (`--resume <id>`) or a
  // subcommand word (`resume <id>`); the style field documents which.
  return [h.bin, h.resume.flag, opts.sessionId, ...h.launch.baseFlags, ...turnTail(h, opts)];
};

export interface SessionOptions {
  readonly sessionId: string;
}

export const buildSessionArgv = (h: HarnessDescriptor, opts: SessionOptions): string[] => {
  if (!h.sessionMode) {
    throw new ArgvRefusalError(
      "no-session-mode",
      `${h.bin} declares no persistent headless session mode`,
    );
  }
  assertUsableSessionId(opts.sessionId);
  return [
    h.bin,
    ...h.launch.baseFlags,
    ...h.sessionMode.flags,
    h.sessionMode.idFlag,
    opts.sessionId,
  ];
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

/** The granularity an invocation will actually emit: token only when every
 * pin member is present with the pinned value (last occurrence wins, like
 * the CLIs themselves). */
export const streamingGranularityOf = (
  h: HarnessDescriptor,
  argv: readonly string[],
): StreamingGranularity => {
  const flags = flagMapOf(h, argv);
  const pin = h.output.tokenFlagSet;
  for (let i = 0; i < pin.length; i++) {
    const member = pin[i];
    if (member === undefined || !member.startsWith("-")) continue;
    const expected = pin[i + 1];
    const actual = flags.get(member);
    if (actual === undefined) return h.output.fallback;
    if (expected !== undefined && !expected.startsWith("-") && actual !== expected) {
      return h.output.fallback;
    }
  }
  return "token";
};
