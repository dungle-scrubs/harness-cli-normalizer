/**
 * Wall phrasings every harness shares. v1 applied every pattern to every
 * harness deliberately - a muse turn dying on "You've hit your usage limit"
 * or a provider 401 must classify no matter which CLI printed it. Each
 * descriptor spreads these after its harness-specific phrasings.
 */
import type { AuthMatcher, LimitMatcher, TransportMatcher } from "./descriptor.js";

export const SHARED_LIMIT_MATCHERS: ReadonlyArray<LimitMatcher> = [
  { pattern: "you'?ve hit your usage limit", flags: "i", code: "usage-limit" },
  { pattern: "usage limit (?:reached|exceeded)", flags: "i", code: "usage-limit" },
  {
    pattern: "purchase more credits|insufficient credits|out of credits",
    flags: "i",
    code: "credits",
  },
  {
    pattern: "resource_exhausted|quota exceeded|exceeded your current quota",
    flags: "i",
    code: "quota",
  },
  // Rate-limit patterns are last so a line with both a usage wall and a 429 keeps usage-limit (first-match-wins, documented cost)
  // 429 only next to an HTTP status word: a bare digit run inside an id, a
  // byte count, or a timing must never read as a wall. "429 Too Many
  // Requests" is covered by the next matcher.
  {
    pattern: "\\b(?:HTTP|status(?:[_ ]?code)?|code)\\b\\W*[:=]?\\W*429\\b",
    flags: "i",
    code: "rate-limit",
  },
  { pattern: "Too Many Requests", flags: "i", code: "rate-limit" },
  { pattern: "rate limit(?:ed|ing)?", flags: "i", code: "rate-limit" },
  { pattern: "Retry-After", flags: "i", code: "rate-limit" },
];

export const SHARED_AUTH_MATCHERS: ReadonlyArray<AuthMatcher> = [
  { pattern: "401 unauthorized", flags: "i", kind: "expired" },
  { pattern: "invalid api key", flags: "i", kind: "invalid-key" },
];

export const SHARED_TRANSPORT_MATCHERS: ReadonlyArray<TransportMatcher> = [
  { pattern: "connection error", flags: "i" },
  { pattern: "ECONNREFUSED", flags: "i" },
  { pattern: "ECONNRESET", flags: "i" },
  { pattern: "ENOTFOUND", flags: "i" },
  { pattern: "EAI_AGAIN", flags: "i" },
  { pattern: "ETIMEDOUT", flags: "i" },
  { pattern: "fetch failed", flags: "i" },
  { pattern: "socket hang up", flags: "i" },
  { pattern: "network error", flags: "i" },
  { pattern: "service unavailable", flags: "i" },
  { pattern: "bad gateway", flags: "i" },
  { pattern: "gateway time-?out", flags: "i" },
  { pattern: "\\b(?:HTTP|status(?:[_ ]?code)?|code)\\b\\W*[:=]?\\W*50[234]\\b", flags: "i" },
];
