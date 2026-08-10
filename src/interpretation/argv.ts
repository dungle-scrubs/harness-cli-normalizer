/**
 * Argv construction: pure functions turning a descriptor + launch options
 * into the exact argv a spawner would exec. Ordering rules (positional
 * prompt before tool grants) live here so no caller re-derives them.
 */
import type { HarnessDescriptor, StreamingGranularity } from "../knowledge/descriptor.js";

/** The granularity an invocation will actually emit. Flag-set containment is
 * checked pairwise (`--flag value` pairs must appear adjacent) so a value
 * given to a different flag never satisfies the pin. */
export const streamingGranularityOf = (
  h: HarnessDescriptor,
  argv: readonly string[],
): StreamingGranularity => {
  const pin = h.output.tokenFlagSet;
  for (let i = 0; i < pin.length; i++) {
    const token = pin[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const at = argv.indexOf(token);
      if (at === -1) return h.output.fallback;
      const value = pin[i + 1];
      if (value !== undefined && !value.startsWith("--") && argv[at + 1] !== value) {
        return h.output.fallback;
      }
    }
  }
  return "token";
};

export interface LaunchOptions {
  readonly prompt: string;
  readonly tools?: readonly string[];
}

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

/** Selectors (session ids, model names, providers) travel as single argv
 * entries; control characters or leading dashes turn them into flags or
 * multi-line injection, so they are refused, never sanitized. */
const assertCleanSelector = (kind: string, value: string): void => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the oracle - they turn one selector into injected flags/lines
  if (value.trim() === "" || value.startsWith("-") || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ArgvRefusalError(
      `${kind}-selector-invalid`,
      `${kind} selector ${JSON.stringify(value)} contains control characters, is blank, or starts with '-'`,
    );
  }
};

export interface ResumeOptions {
  readonly sessionId: string;
  readonly prompt: string;
}

export const buildResumeArgv = (h: HarnessDescriptor, opts: ResumeOptions): string[] => {
  assertCleanSelector("session", opts.sessionId);
  // Both styles reduce to `<token> <id>`: a flag (`--resume <id>`) or a
  // subcommand word (`resume <id>`); the style field documents which.
  return [h.bin, h.resume.flag, opts.sessionId, ...h.launch.baseFlags, opts.prompt];
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
  assertCleanSelector("session", opts.sessionId);
  return [h.bin, "-p", ...h.sessionMode.flags, h.sessionMode.idFlag, opts.sessionId];
};

export const buildLaunchArgv = (h: HarnessDescriptor, opts: LaunchOptions): string[] => {
  if (opts.prompt.startsWith("-")) {
    throw new ArgvRefusalError(
      "prompt-flag-injection",
      `positional prompt may not start with '-'; it would be parsed as a flag by ${h.bin}`,
    );
  }
  const argv = [h.bin, ...h.launch.baseFlags, opts.prompt];
  if (opts.tools && h.launch.toolsFlag) {
    if (opts.tools.length === 0 || opts.tools.some((t) => t.trim() === "")) {
      throw new ArgvRefusalError(
        "empty-tool-grant",
        `tool grant for ${h.bin} contains an empty entry; an empty ${h.launch.toolsFlag} value grants nothing detectable and masks intent`,
      );
    }
    argv.push(h.launch.toolsFlag, opts.tools.join(","));
  }
  return argv;
};
