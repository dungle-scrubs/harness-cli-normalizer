/**
 * Wall phrasings every harness shares. v1 applied every pattern to every
 * harness deliberately - a muse turn dying on "You've hit your usage limit"
 * or a provider 401 must classify no matter which CLI printed it. Each
 * descriptor spreads these after its harness-specific phrasings.
 */
import type { AuthMatcher, LimitMatcher } from "./descriptor.js";

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
  { pattern: "429", flags: "i", code: "rate-limit" },
  { pattern: "Too Many Requests", flags: "i", code: "rate-limit" },
  { pattern: "rate limit(?:ed|ing)?", flags: "i", code: "rate-limit" },
  { pattern: "Retry-After", flags: "i", code: "rate-limit" },
];

export const SHARED_AUTH_MATCHERS: ReadonlyArray<AuthMatcher> = [
  { pattern: "401 unauthorized", flags: "i", kind: "expired" },
  { pattern: "invalid api key", flags: "i", kind: "invalid-key" },
];
