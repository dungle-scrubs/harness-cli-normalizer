/**
 * Wall detection: pure classification of harness output against the
 * descriptor's limit and auth matchers. Returns the CODE, never the matched
 * line - the consumers of a detection are a retained record and a viewer
 * warning, and anything the harness printed on that line (a prompt, a
 * filename, a customer's name) must not ride along (v1 D-005: records carry
 * identifiers and outcomes, never content).
 *
 * Feed these wall-eligible output only - stderr and the non-JSON tail of a
 * dying turn - never assistant message content, where the model merely
 * TALKING about limits would match.
 */
import type { AuthFailureKind, HarnessDescriptor, LimitCode } from "../knowledge/descriptor.js";

/** Bottom-up batch scans stop after this many non-empty lines: the wall is
 * virtually always the last thing a dying turn printed, and an unbounded
 * scan over an accumulating session buffer is O(turns x output). */
const BATCH_SCAN_MAX_LINES = 200;

const scanLine = <Code>(
  line: string,
  matchers: ReadonlyArray<readonly [RegExp, Code]>,
): Code | null => {
  for (let i = 0; i < matchers.length; i++) {
    const matcher = matchers[i];
    if (matcher?.[0].test(line)) return matcher[1];
  }
  return null;
};

const scanTail = <Code>(
  output: string,
  matchers: ReadonlyArray<readonly [RegExp, Code]>,
): Code | null => {
  let end = output.length;
  let scanned = 0;
  while (end > 0 && scanned < BATCH_SCAN_MAX_LINES) {
    const start = output.lastIndexOf("\n", end - 1);
    const line = output.slice(start + 1, end).trim();
    end = start;
    if (line === "") continue;
    scanned++;
    const code = scanLine(line, matchers);
    if (code !== null) return code;
  }
  return null;
};

/** Per-line entry point for streaming readers: O(1) per line, no rescans. */
export const detectLimitInLine = (h: HarnessDescriptor, line: string): LimitCode | null =>
  scanLine(line.trim(), h.limitMatchers);

/** Batch convenience over a turn's tail, bounded and bottom-up. */
export const detectLimit = (h: HarnessDescriptor, output: string): LimitCode | null =>
  scanTail(output, h.limitMatchers);

export const detectAuthFailureInLine = (
  h: HarnessDescriptor,
  line: string,
): AuthFailureKind | null => scanLine(line.trim(), h.authMatchers);

export const detectAuthFailure = (h: HarnessDescriptor, output: string): AuthFailureKind | null =>
  scanTail(output, h.authMatchers);
