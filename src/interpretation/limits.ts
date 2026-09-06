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
 *
 * Matchers are serializable objects {pattern, flags, code/kind}; compilation
 * to RegExp happens here with bounded inputs (pattern length, count, flags)
 * and a WeakMap cache. The input window (first 4096 chars of a line), not
 * pattern analysis, is the backtracking bound - a malicious pattern could
 * otherwise catastrophically backtrack on a long line.
 */

import type {
  AuthFailureKind,
  AuthMatcher,
  HarnessDescriptor,
  LimitCode,
  LimitMatcher,
  PhraseMatcher,
} from "../knowledge/descriptor.js";
import {
  compileMatcher,
  MAX_MATCHERS_PER_KIND,
  SHARED_TRANSPORT_MATCHERS,
  SHARED_UNAVAILABLE_MATCHERS,
} from "../knowledge/matchers.js";

/** The pattern bounds live with the matchers in the knowledge layer
 * (compileMatcher); this is the per-line input window. */
const WINDOW = 4096;

// WeakMap cache: same matcher array instance reuses identical RegExp objects
const limitCache = new WeakMap<
  ReadonlyArray<LimitMatcher>,
  ReadonlyArray<readonly [RegExp, LimitCode]>
>();
const authCache = new WeakMap<
  ReadonlyArray<AuthMatcher>,
  ReadonlyArray<readonly [RegExp, AuthFailureKind]>
>();

export const compileLimitMatchers = (
  matchers: ReadonlyArray<LimitMatcher>,
): ReadonlyArray<readonly [RegExp, LimitCode]> => {
  const cached = limitCache.get(matchers);
  if (cached !== undefined) return cached;
  if (matchers.length > MAX_MATCHERS_PER_KIND) {
    throw new Error(`more than ${MAX_MATCHERS_PER_KIND} matchers per harness per kind`);
  }
  const compiled = matchers.map((m) => [compileMatcher(m.pattern, m.flags), m.code] as const);
  limitCache.set(matchers, compiled);
  return compiled;
};

export const compileAuthMatchers = (
  matchers: ReadonlyArray<AuthMatcher>,
): ReadonlyArray<readonly [RegExp, AuthFailureKind]> => {
  const cached = authCache.get(matchers);
  if (cached !== undefined) return cached;
  if (matchers.length > MAX_MATCHERS_PER_KIND) {
    throw new Error(`more than ${MAX_MATCHERS_PER_KIND} matchers per harness per kind`);
  }
  const compiled = matchers.map((m) => [compileMatcher(m.pattern, m.flags), m.kind] as const);
  authCache.set(matchers, compiled);
  return compiled;
};

const scanLine = <Code>(
  line: string,
  matchers: ReadonlyArray<readonly [RegExp, Code]>,
): Code | null => {
  const windowed = line.slice(0, WINDOW);
  for (let i = 0; i < matchers.length; i++) {
    const matcher = matchers[i];
    if (matcher?.[0].test(windowed)) return matcher[1];
  }
  return null;
};

/** Per-line entry point for streaming readers: O(1) per line, no rescans.
 * Both runners feed lines as they arrive; there is no batch form. */
export const detectLimitInLine = (h: HarnessDescriptor, line: string): LimitCode | null =>
  scanLine(line.trim(), compileLimitMatchers(h.limitMatchers));

export const detectAuthFailureInLine = (
  h: HarnessDescriptor,
  line: string,
): AuthFailureKind | null => scanLine(line.trim(), compileAuthMatchers(h.authMatchers));

const phraseCache = new WeakMap<ReadonlyArray<PhraseMatcher>, ReadonlyArray<RegExp>>();

const compilePhraseMatchers = (matchers: ReadonlyArray<PhraseMatcher>): ReadonlyArray<RegExp> => {
  const cached = phraseCache.get(matchers);
  if (cached !== undefined) return cached;
  if (matchers.length > MAX_MATCHERS_PER_KIND) {
    throw new Error(`more than ${MAX_MATCHERS_PER_KIND} matchers per harness per kind`);
  }
  const compiled = matchers.map((m) => compileMatcher(m.pattern, m.flags));
  phraseCache.set(matchers, compiled);
  return compiled;
};

const detectPhraseInLine = (matchers: ReadonlyArray<PhraseMatcher>, line: string): boolean => {
  const windowed = line.slice(0, WINDOW).trim();
  return compilePhraseMatchers(matchers).some((re) => re.test(windowed));
};

/** A network or gateway fault between the harness and its provider. */
export const detectTransportInLine = (line: string): boolean =>
  detectPhraseInLine(SHARED_TRANSPORT_MATCHERS, line);

/** A provider that answered but cannot serve the requested model. */
export const detectUnavailableInLine = (line: string): boolean =>
  detectPhraseInLine(SHARED_UNAVAILABLE_MATCHERS, line);
