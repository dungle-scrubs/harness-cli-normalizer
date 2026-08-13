/**
 * Small dimension accessors: one interpretation function per PLAN 3.1
 * dimension whose value is a direct descriptor lookup. They exist so every
 * dimension has a single named owner in the interpretation layer - callers
 * never reach into descriptor internals.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export const stdinPolicyOf = (h: HarnessDescriptor): "inherit" | "close-required" => h.stdin;

export const toolsFlagOf = (h: HarnessDescriptor): string | null => h.launch.toolsFlag;

export const autonomyFlagOf = (h: HarnessDescriptor): string | null =>
  h.autonomy === null ? null : h.autonomy.flag;
