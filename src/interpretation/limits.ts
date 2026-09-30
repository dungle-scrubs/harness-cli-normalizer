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

/** A workspace-trust gate refusal (cursor): compiled under the same
 * matcher bounds as every other wall, so a crafted override cannot widen
 * it. Harnesses without trustMatchers never detect. */
export const detectTrustRefusal = (h: HarnessDescriptor, line: string): boolean =>
  h.trustMatchers !== undefined && detectPhraseInLine(h.trustMatchers, line);

/** A reset time stated in a limit wall's prose. */
export type ResetHint =
  | {
      readonly kind: "local-datetime";
      /** Calendar fields as printed (month 1-12, day 1-31, hour 0-23). */
      readonly year: number;
      readonly month: number;
      readonly day: number;
      readonly hour: number;
      readonly minute: number;
    }
  | { readonly kind: "local-time"; readonly hour: number; readonly minute: number }
  | { readonly kind: "relative"; readonly minutes: number };

/** No provider reset window outlives a week; a larger parsed count is a
 * misread, not a schedule. */
const MAX_RELATIVE_MINUTES = 7 * 24 * 60;

// Codex prints the reset through format_retry_timestamp: process-local
// time, minute precision, no zone. Full form: `%b %-d<ordinal>, %Y %-I:%M %p`.
const DATETIME_RESET =
  /try again at (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec) ([1-9]|1[0-9]|2[0-9]|3[01])(?:st|nd|rd|th), (\d{4}) ([1-9]|1[0-2]):([0-5]\d) (am|pm)(?=\.|$)/i;
// Same local calendar day: time only (`%-I:%M %p`). Tried after the full
// form, whose prefix it shares.
const TIME_RESET = /try again at ([1-9]|1[0-2]):([0-5]\d) (am|pm)(?=\.|$)/i;
// Pi's 429 rendering of the backend resets_at: minutes remaining at the
// moment pi rendered the message (Math.round), with or without the tilde.
const RELATIVE_RESET = /try again in ~?(\d{1,5}) min(?:s|utes)?(?=\.|$)/i;

const MONTH_NAMES: ReadonlyArray<string> = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** 12-hour clock to 0-23: 12 AM is midnight (0), 12 PM is noon (12). */
const hour24 = (hour: number, pm: boolean): number => (hour % 12) + (pm ? 12 : 0);

/** The reset time a limit wall states in its prose, if any. Codex prints
 * an absolute local timestamp (minute precision, no zone); pi prints
 * relative minutes. Everything else - `try again later`, a limit message
 * with no time stated - yields null; a reset is never guessed. */
export const resetHintInLine = (line: string): ResetHint | null => {
  const windowed = line.slice(0, WINDOW);
  const datetime = DATETIME_RESET.exec(windowed);
  if (datetime !== null) {
    return {
      kind: "local-datetime",
      year: Number(datetime[3]),
      month: MONTH_NAMES.indexOf((datetime[1] ?? "").toLowerCase()) + 1,
      day: Number(datetime[2]),
      hour: hour24(Number(datetime[4]), (datetime[6] ?? "").toLowerCase() === "pm"),
      minute: Number(datetime[5]),
    };
  }
  const time = TIME_RESET.exec(windowed);
  if (time !== null) {
    return {
      kind: "local-time",
      hour: hour24(Number(time[1]), (time[3] ?? "").toLowerCase() === "pm"),
      minute: Number(time[2]),
    };
  }
  const relative = RELATIVE_RESET.exec(windowed);
  if (relative !== null) {
    const minutes = Number(relative[1]);
    if (minutes > MAX_RELATIVE_MINUTES) return null;
    return { kind: "relative", minutes };
  }
  return null;
};

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : (MONTH_DAYS[month - 1] ?? 0);

/** UTC calendar date of an epoch-ms instant without touching Date's
 * impure side (civil_from_days, Howard Hinnant's date algorithms). */
const civilDateOf = (ms: number): { year: number; month: number; day: number } => {
  const z = Math.floor(ms / 86_400_000) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
};

const finitePositive = (ms: number): number | null => (Number.isFinite(ms) && ms > 0 ? ms : null);

/** Epoch ms for a hint. `now` is epoch ms; `utcOffsetMinutes(epochMs)` is
 * the local zone's offset east of UTC at that instant (+420 for +07:00).
 * Returns null when a local form cannot be resolved. A relative hint is
 * the upper bound of pi's rounded minutes (+30 s); a printed timestamp is
 * minute-truncated, so the wall resolves to the END of that minute - the
 * reset has certainly happened by then, never earlier. */
export const resolveResetHint = (
  hint: ResetHint,
  now: number,
  utcOffsetMinutes: ((epochMs: number) => number) | undefined,
): number | null => {
  if (hint.kind === "relative") return finitePositive(now + hint.minutes * 60_000 + 30_000);
  if (utcOffsetMinutes === undefined) return null;
  const today = civilDateOf(now + utcOffsetMinutes(now) * 60_000);
  const year = hint.kind === "local-datetime" ? hint.year : today.year;
  const month = hint.kind === "local-datetime" ? hint.month : today.month;
  const day = hint.kind === "local-datetime" ? hint.day : today.day;
  if (day > daysInMonth(year, month)) return null;
  const wallUtc = Date.UTC(year, month - 1, day, hint.hour, hint.minute);
  // One DST correction pass: the offset at the guessed instant can differ
  // from the offset at the wall (a transition inside that minute's zone
  // lookup), and the second lookup is the stable one.
  const guess = wallUtc - utcOffsetMinutes(wallUtc) * 60_000;
  return finitePositive(wallUtc - utcOffsetMinutes(guess) * 60_000 + 60_000);
};
