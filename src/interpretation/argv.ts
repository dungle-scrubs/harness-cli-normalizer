/**
 * Argv construction: pure functions turning a descriptor + launch options
 * into the exact argv a spawner would exec. Ordering rules (positional
 * prompt before tool grants) live here so no caller re-derives them.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

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
