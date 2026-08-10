/**
 * Limit detection: pure classification of harness output against the
 * descriptor's limit matchers. Scans bottom-up because the wall is virtually
 * always the last thing a dying turn printed. Deliberately limits-only:
 * crashes and clean exits are exit-cause classification, not limits.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface DetectedLimit {
  readonly code: string;
  readonly message: string;
}

export const detectLimit = (h: HarnessDescriptor, output: string): DetectedLimit | null => {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    for (const [pattern, code] of h.limitMatchers) {
      if (pattern.test(line)) return { code, message: line };
    }
  }
  return null;
};
