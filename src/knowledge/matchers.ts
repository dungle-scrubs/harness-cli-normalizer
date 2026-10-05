/**
 * Wall phrasings every harness shares. v1 applied every pattern to every
 * harness deliberately - a muse turn dying on "You've hit your usage limit"
 * or a provider 401 must classify no matter which CLI printed it. Each
 * descriptor spreads these after its harness-specific phrasings.
 */
import type {
  AuthMatcher,
  LimitMatcher,
  TransportMatcher,
  UnavailableMatcher,
} from "./descriptor.js";

/** Bounds on a matcher, enforced wherever one is compiled - the limits
 * scanner and the override loader alike (RFC-02 change 9). They keep a
 * crafted override file from DoS'ing the compiler or the scanner; the
 * input window, not pattern analysis, is the backtracking bound. */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_MATCHERS_PER_KIND = 64;
/** The only flags a matcher may carry. `g` and `y` are stateful and
 * would make `test()` order-dependent. */
export const MATCHER_FLAGS = "imsu";

/** Compile one matcher under the bounds. Throws a plain Error naming the
 * violated bound; loaders wrap it in their own refusal type. */
export const compileMatcher = (pattern: string, flags: string | undefined): RegExp => {
  const f = flags ?? "i";
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern over ${MAX_PATTERN_LENGTH} characters`);
  }
  if (pattern.length === 0) {
    throw new Error("pattern must not be empty");
  }
  if (f.includes("g") || f.includes("y")) {
    throw new Error(`flags must not contain g or y (got ${JSON.stringify(f)})`);
  }
  for (const ch of f) {
    if (!MATCHER_FLAGS.includes(ch)) {
      throw new Error(`flag ${JSON.stringify(ch)} outside ${MATCHER_FLAGS}`);
    }
  }
  try {
    return new RegExp(pattern, f);
  } catch (e) {
    throw new Error(`uncompilable pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`);
  }
};

export const SHARED_LIMIT_MATCHERS: ReadonlyArray<LimitMatcher> = [
  // "You have hit your ChatGPT usage limit (pro plan)." - pi's openai-codex
  // rendering of the backend 429 (issue #325): spelled out, with a product
  // word before the noun.
  {
    pattern: "you(?:['’]?ve| have) hit your (?:\\w+ )?usage limit",
    flags: "i",
    code: "usage-limit",
  },
  // "The Token Plan usage limit has been reached." - MiniMax plan wall riding
  // in a provider 429 body (issue #322): the auxiliary verbs sit between the
  // noun phrase and the verdict verb.
  { pattern: "usage limit (?:has been )?(?:reached|exceeded)", flags: "i", code: "usage-limit" },
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
  // Underscore and hyphen forms ride inside provider error payloads, not
  // prose: "error":{"type":"rate_limit_error"} (issue #322). Wall-eligible
  // input only (stderr, non-JSON tails, terminal error messages), so a
  // payload type name is a wall claim, not chatter.
  { pattern: "rate[_ -]?limit(?:ed|ing)?", flags: "i", code: "rate-limit" },
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
  // Issue #342: provider WebSocket close phrasings. Pi prints
  // "WebSocket closed <code>[ <reason>]", "WebSocket closed", and
  // "WebSocket stream closed before response.completed". Codex 0.160.0
  // prints "websocket closed by server before response.completed" and
  // "realtime websocket closed: code=<n>". The `ws` library prints
  // "WebSocket is not open: readyState <n> (<STATE>)". The codeless forms
  // are anchored to the start of a line or an error colon, or need a
  // close continuation, so model prose that mentions a WebSocket (a
  // "WebSocket closed handler") stays a work verdict. Codes 1000, 1002,
  // 1003, 1008, 1009 and 1010 are a normal close or an endpoint refusing
  // the traffic, not a dropped connection, and are NOT matched here.
  {
    pattern:
      "\\bwebsocket(?: connection| stream)? closed\\W+(?:with )?(?:(?:close )?code\\W*)?10(?:0[16]|1[123])\\b",
    flags: "i",
  },
  {
    pattern: "(?:^|:\\s*)websocket(?: connection| stream)? closed\\s*$",
    flags: "im",
  },
  {
    pattern:
      "\\bwebsocket(?: connection| stream)? closed\\s+(?:before|unexpectedly|abnormally|without\\b|by\\s+(?:the\\s+)?(?:server|peer|remote|provider)\\b)",
    flags: "i",
  },
  {
    pattern: "(?:^|:\\s*)websocket is not open(?:\\s*$|:\\s*readystate\\b)",
    flags: "im",
  },
  // Issue #346: pi's openai-codex provider over WebSocket reports a
  // mid-response close as `WebSocket idle timeout after <n>ms` and a
  // connection failure as `WebSocket connect timeout after <n>ms`; codex
  // prints `stream disconnected before completion: <cause>` once its own
  // stream retries run out. `failureFromTerminalError` checks auth and
  // limit walls before transport, so a codex disconnect whose cause is a
  // 401 stays auth, not transport.
  {
    pattern: "\\bwebsocket (?:idle|connect) timeout after \\d+\\s*ms\\b",
    flags: "i",
  },
  { pattern: "\\bstream disconnected before completion:", flags: "i" },
];

export const SHARED_UNAVAILABLE_MATCHERS: ReadonlyArray<UnavailableMatcher> = [
  { pattern: "model_not_found", flags: "i" },
  { pattern: "invalid model identifier", flags: "i" },
  { pattern: "model[^.]{0,60}not found", flags: "i" },
  { pattern: "no such model", flags: "i" },
  { pattern: "unknown model", flags: "i" },
  { pattern: "model[^.]{0,60}(?:is not|isn't) loaded", flags: "i" },
  { pattern: "model[^.]{0,60}does not exist", flags: "i" },
  { pattern: "not a valid (?:downloaded )?model", flags: "i" },
  // Issue #343: pi's openai-codex provider reports `The '<id>' model is
  // not supported when using Codex with a ChatGPT account.`
  { pattern: "\\bmodel is not supported\\b", flags: "i" },
];
