/**
 * Wall phrasings every harness shares. v1 applied every pattern to every
 * harness deliberately - a muse turn dying on "You've hit your usage limit"
 * or a provider 401 must classify no matter which CLI printed it. Each
 * descriptor spreads these after its harness-specific phrasings.
 */
import type { AuthFailureKind, LimitCode } from "./descriptor.js";

export const SHARED_LIMIT_MATCHERS: ReadonlyArray<readonly [RegExp, LimitCode]> = [
  [/you'?ve hit your usage limit/i, "usage-limit"],
  [/usage limit (?:reached|exceeded)/i, "usage-limit"],
  [/purchase more credits|insufficient credits|out of credits/i, "credits"],
  [/resource_exhausted|quota exceeded|exceeded your current quota/i, "quota"],
];

export const SHARED_AUTH_MATCHERS: ReadonlyArray<readonly [RegExp, AuthFailureKind]> = [
  [/401 unauthorized/i, "expired"],
  [/invalid api key/i, "invalid-key"],
];
