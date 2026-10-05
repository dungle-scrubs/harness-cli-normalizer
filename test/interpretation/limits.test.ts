import { describe, expect, test } from "vitest";
import {
  detectAuthFailureInLine,
  detectLimitInLine,
  detectTransportInLine,
  detectTrustRefusal,
  detectUnavailableInLine,
} from "../../src/interpretation/limits.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("detectLimitInLine (claude)", () => {
  test("recognizes the real claude limit walls, code only", () => {
    expect(detectLimitInLine(claudeCode, "You've hit your session limit · resets 6:30pm")).toBe(
      "session-limit",
    );
    expect(
      detectLimitInLine(claudeCode, "You've hit your weekly limit · resets 2am (Asia/Bangkok)"),
    ).toBe("weekly-limit");
    expect(detectLimitInLine(claudeCode, "Usage limit reached")).toBe("usage-limit");
  });

  test("returns the code alone - never the matched line (D-005: no content rides along)", () => {
    const detected = detectLimitInLine(
      claudeCode,
      "secret prompt text you've hit your usage limit",
    );
    expect(detected).toBe("usage-limit");
    expect(typeof detected).toBe("string");
  });

  test("a clean line detects nothing - crash and clean exit are not limits", () => {
    expect(detectLimitInLine(claudeCode, "all done")).toBeNull();
    expect(detectLimitInLine(claudeCode, "goodbye")).toBeNull();
    expect(detectLimitInLine(claudeCode, "TypeError: x is not a function")).toBeNull();
  });

  test("structured output lines never read as a wall", () => {
    expect(detectLimitInLine(claudeCode, "You've hit your weekly limit · resets 2am")).toBe(
      "weekly-limit",
    );
    expect(detectLimitInLine(claudeCode, '{"type":"token","text":"hi"}')).toBeNull();
  });
});

describe("detectAuthFailureInLine (claude)", () => {
  test("auth walls classify separately from usage limits - the remedy differs", () => {
    expect(detectAuthFailureInLine(claudeCode, "OAuth session expired")).toBe("expired");
    expect(detectAuthFailureInLine(claudeCode, "Not logged in. Please run /login")).toBe(
      "not-logged-in",
    );
    expect(detectAuthFailureInLine(claudeCode, "Invalid API key")).toBe("invalid-key");
    expect(detectAuthFailureInLine(claudeCode, "You've hit your usage limit")).toBeNull();
  });
});

// F-21: one representative line per matcher entry, for all four descriptors
const limitCases: Array<{ descriptor: typeof claudeCode; code: string; line: string }> = [
  // claude-specific limits
  {
    descriptor: claudeCode,
    code: "session-limit",
    line: "You've hit your session limit · resets 6:30pm",
  },
  {
    descriptor: claudeCode,
    code: "weekly-limit",
    line: "You've hit your weekly limit · resets 2am (Asia/Bangkok)",
  },
  // shared limits - claude
  {
    descriptor: claudeCode,
    code: "usage-limit",
    line: "You've hit your usage limit - please wait",
  },
  { descriptor: claudeCode, code: "usage-limit", line: "Usage limit reached - please try later" },
  {
    descriptor: claudeCode,
    code: "credits",
    line: "Purchase more credits to continue using this model",
  },
  {
    descriptor: claudeCode,
    code: "quota",
    line: "quota exceeded: you have exceeded your current quota",
  },
  { descriptor: claudeCode, code: "rate-limit", line: "Error 429: too many requests" },
  { descriptor: claudeCode, code: "rate-limit", line: "Too Many Requests - backing off" },
  { descriptor: claudeCode, code: "rate-limit", line: "rate limit hit - retry after 60s" },
  { descriptor: claudeCode, code: "rate-limit", line: "Retry-After: 120" },
  // shared limits - codex
  { descriptor: codexCli, code: "usage-limit", line: "You've hit your usage limit" },
  { descriptor: codexCli, code: "usage-limit", line: "Usage limit exceeded for this hour" },
  { descriptor: codexCli, code: "credits", line: "Insufficient credits - please purchase more" },
  { descriptor: codexCli, code: "quota", line: "resource_exhausted: quota exceeded" },
  { descriptor: codexCli, code: "rate-limit", line: "429 rate limit" },
  { descriptor: codexCli, code: "rate-limit", line: "Too Many Requests" },
  { descriptor: codexCli, code: "rate-limit", line: "rate limited by provider" },
  { descriptor: codexCli, code: "rate-limit", line: "Retry-After header present" },
  // shared limits - pi
  { descriptor: piCli, code: "usage-limit", line: "You've hit your usage limit" },
  { descriptor: piCli, code: "usage-limit", line: "usage limit reached" },
  { descriptor: piCli, code: "credits", line: "Out of credits - recharge required" },
  { descriptor: piCli, code: "quota", line: "Exceeded your current quota for this project" },
  { descriptor: piCli, code: "rate-limit", line: "HTTP 429" },
  { descriptor: piCli, code: "rate-limit", line: "Too Many Requests" },
  { descriptor: piCli, code: "rate-limit", line: "rate limiting in effect" },
  { descriptor: piCli, code: "rate-limit", line: "Retry-After: 30" },
  // shared limits - muse
  { descriptor: museCode, code: "usage-limit", line: "You've hit your usage limit" },
  { descriptor: museCode, code: "usage-limit", line: "usage limit exceeded" },
  { descriptor: museCode, code: "credits", line: "purchase more credits" },
  { descriptor: museCode, code: "quota", line: "quota exceeded" },
  { descriptor: museCode, code: "rate-limit", line: "status code 429" },
  { descriptor: museCode, code: "rate-limit", line: "Too Many Requests" },
  { descriptor: museCode, code: "rate-limit", line: "rate limit" },
  { descriptor: museCode, code: "rate-limit", line: "Retry-After" },
];

const authCases: Array<{ descriptor: typeof claudeCode; kind: string; line: string }> = [
  // claude-specific auth
  { descriptor: claudeCode, kind: "expired", line: "OAuth session expired - please re-auth" },
  { descriptor: claudeCode, kind: "expired", line: "Failed to authenticate with Anthropic" },
  { descriptor: claudeCode, kind: "not-logged-in", line: "Not logged in. Please run /login" },
  // shared auth - claude
  { descriptor: claudeCode, kind: "expired", line: "401 Unauthorized: token invalid" },
  { descriptor: claudeCode, kind: "invalid-key", line: "Invalid API key - check your settings" },
  // codex auth
  { descriptor: codexCli, kind: "not-logged-in", line: "Please run codex login to authenticate" },
  { descriptor: codexCli, kind: "expired", line: "401 unauthorized - session expired" },
  { descriptor: codexCli, kind: "invalid-key", line: "invalid api key" },
  // pi auth (shared only)
  { descriptor: piCli, kind: "expired", line: "401 Unauthorized" },
  { descriptor: piCli, kind: "invalid-key", line: "Invalid API key" },
  // muse auth (shared only)
  { descriptor: museCode, kind: "expired", line: "401 unauthorized" },
  { descriptor: museCode, kind: "invalid-key", line: "invalid api key" },
];

describe("F-21: matcher coverage - one line per limitMatcher entry", () => {
  test.each(limitCases)("$descriptor.name $code matches: $line", ({ descriptor, code, line }) => {
    expect(detectLimitInLine(descriptor, line)).toBe(code);
  });
});

describe("F-21: matcher coverage - one line per authMatcher entry", () => {
  test.each(authCases)("$descriptor.name $kind matches: $line", ({ descriptor, kind, line }) => {
    expect(detectAuthFailureInLine(descriptor, line)).toBe(kind);
  });
});
describe("detectTransportInLine", () => {
  const positives: Array<{ line: string; desc: string }> = [
    { line: "Connection error.", desc: "connection error" },
    { line: "connect ECONNREFUSED 127.0.0.1:1234", desc: "ECONNREFUSED" },
    { line: "read ECONNRESET", desc: "ECONNRESET" },
    { line: "getaddrinfo ENOTFOUND registry.npmjs.org", desc: "ENOTFOUND" },
    { line: "query EAI_AGAIN example.com", desc: "EAI_AGAIN" },
    { line: "connect ETIMEDOUT 1.2.3.4:443", desc: "ETIMEDOUT" },
    { line: "fetch failed: network unreachable", desc: "fetch failed" },
    { line: "socket hang up", desc: "socket hang up" },
    { line: "network error while fetching", desc: "network error" },
    { line: "HTTP 503 Service Unavailable", desc: "service unavailable" },
    { line: "502 Bad Gateway", desc: "bad gateway via HTTP code" },
    { line: "bad gateway", desc: "bad gateway" },
    { line: "gateway time-out", desc: "gateway timeout" },
    { line: "gateway timeout", desc: "gateway timeout no hyphen" },
    { line: "HTTP 502 Bad Gateway", desc: "HTTP 502" },
    { line: "status code 503", desc: "status code 503" },
    { line: "code: 504", desc: "code 504" },
    {
      line: 'pi turn ended with stopReason error: 529 {"type":"error","error":{"type":"overloaded_error","message":"The server cluster is currently under high load. Please retry after a short wait and thank you for your patience. (2064) (529)"}}',
      desc: "issue #350: pi overloaded error",
    },
    {
      line: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      desc: "issue #350: API overloaded error",
    },
    {
      line: "HTTP 529",
      desc: "issue #350: HTTP 529",
    },

    // Issue #342: pi's openai-codex provider WebSocket close phrasings.
    // RFC 6455 codes 1001, 1006, 1011, 1012, 1013 are abnormal closes
    // (the provider killed the connection mid-response); a codeless
    // close is the provider hanging up before reporting one; "is not
    // open" is a use-after-close. Each phrasing pi prints carries its
    // own structure (bare code, "code <n>", "code=<n>", with a reason,
    // or no code at all).
    { line: "WebSocket closed 1001", desc: "WS close 1001 going away" },
    { line: "WebSocket closed 1006", desc: "WS close 1006 abnormal" },
    { line: "WebSocket closed 1011 internal error", desc: "WS close 1011 internal error" },
    { line: "WebSocket closed 1012", desc: "WS close 1012 service restart" },
    { line: "WebSocket closed 1013", desc: "WS close 1013 try again later" },
    { line: "websocket connection closed with code 1006", desc: "WS connection closed with code" },
    { line: "realtime websocket closed: code=1011", desc: "WS closed code=1011 colon form" },
    { line: "WebSocket closed", desc: "WS closed with no code" },
    {
      line: "WebSocket stream closed before response.completed",
      desc: "WS stream closed before response.completed",
    },
    { line: "WebSocket is not open: readyState 3 (CLOSED)", desc: "WS not open readyState 3" },
    // Issue #342: WebSocket abnormal-close phrasings.
    { line: "websocket closed abnormally", desc: "WS closed abnormally" },
    { line: "websocket closed without a close frame", desc: "WS closed without a close frame" },
    { line: "WebSocket closed\nabnormal closure", desc: "WS closed then abnormal on next line" },
    { line: "rpc failed: WebSocket closed", desc: "WS closed after an error colon" },
    // Codeless and "is not open" forms anchored so prose that mentions a
    // WebSocket does not match.
    { line: "pi turn ended with stopReason error: WebSocket closed", desc: "WS closed at EOL" },
    {
      line: "stream disconnected before completion: websocket closed by server before response.completed",
      desc: "WS closed by server",
    },
    { line: "websocket connection closed unexpectedly", desc: "WS connection closed unexpectedly" },
    { line: "WebSocket is not open", desc: "WS is not open at EOL" },
    // Issue #346: pi's openai-codex provider over WebSocket reports a
    // mid-response close as `WebSocket idle timeout after <n>ms` or
    // `WebSocket connect timeout after <n>ms`; the timeout figure rides
    // in errorMessage. A leading turn-ended prefix must not change the
    // classification: failureFromTerminalError sees only the message.
    {
      line: "pi turn ended with stopReason error: WebSocket idle timeout after 300000ms",
      desc: "issue #346: pi WS idle timeout, full pi errorMessage",
    },
    {
      line: "WebSocket idle timeout after 300000ms",
      desc: "issue #346: WS idle timeout, bare",
    },
    {
      line: "WebSocket connect timeout after 15000ms",
      desc: "issue #346: WS connect timeout",
    },
    // Issue #346: codex prints `stream disconnected before completion:
    // <cause>` once its own stream retries run out. The colon is the
    // anchor: an inner cause (auth, network, etc.) rides after it and
    // `failureFromTerminalError` resolves the more specific class first.
    {
      line: "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
      desc: "issue #346: codex stream disconnected with network cause",
    },
  ];
  test.each(positives)("positive $desc: $line", ({ line }) => {
    expect(detectTransportInLine(line)).toBe(true);
  });

  const negatives = [
    "processed 529 files",
    "the overloaded server case is handled in retry.ts",
    "port 5020",
    "elapsed 502ms",
    "read 5030 bytes",
    // Issue #342: deliberate close codes are not transport.
    "WebSocket closed 1002",
    "WebSocket closed 1003",
    "WebSocket closed 1010",
    "WebSocket closed 1000",
    "WebSocket closed 1008 policy violation",
    "WebSocket closed 1009 message too big",
    // A code that begins with the abnormal prefixes but is not in the set.
    "WebSocket closed 10120",
    // Anchored codeless forms: prose that mentions a WebSocket does not match.
    "I fixed it so the WebSocket closed",
    "the WebSocket closed by the client handler",
    "the WebSocket closed event fires twice",
    "the WebSocket is not open yet so I queued the message",
    "turn failed: error_max_turns (I did not finish implementing the WebSocket closed handler.)",
    "WebSocket is not open: see docs",
    "I checked that the websocket is not open",
    // Issue #346: even exact timeout/disconnect phrasings in prose stay
    // task unless they start a line or follow an error colon.
    "I did not finish fixing the client that reports `WebSocket idle timeout after 300000ms`.",
    "I added a websocket idle timeout setting",
    "the upload stream disconnected before completion: retrying",
    "the stream disconnected before completion of the upload",
  ] as const;
  test.each(negatives)("negative %s is not transport", (line) => {
    expect(detectTransportInLine(line)).toBe(false);
  });

  test("pi No API key found for google is not-logged-in", () => {
    expect(detectAuthFailureInLine(piCli, "No API key found for google.")).toBe("not-logged-in");
  });
});

describe("rate-limit 429 anchor", () => {
  const positives = [
    "HTTP 429",
    "status 429",
    "status: 429",
    "status_code=429",
    "statusCode: 429",
    "code 429",
    "error code: 429",
    "429 Too Many Requests",
    "Request failed with status code 429",
  ] as const;

  const negatives = [
    "task_id d3665fd8-fd23-4297-ab53-4528fc517db3",
    "read 4291 bytes from cache",
    "elapsed 1429ms",
    "port 4290",
    "session 429abc",
  ] as const;

  test.each(positives)("positive %s is rate-limit", (line) => {
    expect(detectLimitInLine(claudeCode, line)).toBe("rate-limit");
  });

  test.each(negatives)("negative %s is not rate-limit", (line) => {
    expect(detectLimitInLine(claudeCode, line)).toBeNull();
  });

  test("shared matcher applies to every harness (muse)", () => {
    expect(detectLimitInLine(museCode, "HTTP 429")).toBe("rate-limit");
    expect(detectLimitInLine(museCode, "read 4291 bytes from cache")).toBeNull();
  });
});

describe("detectUnavailableInLine", () => {
  const positives: Array<{ line: string; desc: string }> = [
    {
      line: '400: {"message":"Invalid model identifier \\"unsloth/qwen3.6-27b-mlx\\". Please specify a valid downloaded model (e.g., qwen3.6-35b-a3b-ud-mlx, qwen3.8-27b-mlx, qwen/qwen3-vl-8b@4bit).","type":"invalid_request_error","param":"model","code":"model_not_found"}',
      desc: "exact pi errorMessage with model_not_found",
    },
    { line: "model_not_found", desc: "model_not_found" },
    { line: "Invalid model identifier", desc: "invalid model identifier" },
    { line: "model xyz not found", desc: "model not found bounded" },
    { line: "no such model", desc: "no such model" },
    { line: "unknown model", desc: "unknown model" },
    { line: "model foo is not loaded", desc: "model is not loaded" },
    { line: "model foo isn't loaded", desc: "model isn't loaded" },
    { line: "model foo does not exist", desc: "model does not exist" },
    { line: "not a valid model", desc: "not a valid model" },
    { line: "not a valid downloaded model", desc: "not a valid downloaded model" },
    {
      line: "the model said not found in file",
      desc: "model said not found in file - bounded window",
    },
    // Issue #343: pi's openai-codex provider refuses a model with "model
    // is not supported when using Codex with a ChatGPT account". The full
    // pi errorMessage rides in stopReason error (issue repro: 0.9.4,
    // pi 1.0.2, model "no-such-model-xyz", provider openai-codex).
    {
      line: "pi turn ended with stopReason error: Codex error: The 'gpt-x' model is not supported when using Codex with a ChatGPT account.",
      desc: "issue #343: pi openai-codex 'model is not supported' wall",
    },
  ];
  test.each(positives)("positive $desc: $line", ({ line }) => {
    expect(detectUnavailableInLine(line)).toBe(true);
  });

  const negatives = [
    "model answered",
    "found 3 models",
    // Issue #343: keep option-level refusals (an unsupported reasoning
    // effort, an unsupported tool) out of the unavailable class - the
    // quoted model id must directly precede "model is not supported".
    "Reasoning effort 'high' for this model is not supported.",
    "reasoning effort is not supported",
    "the tool is not supported in this model",
    // antigravity's invalid-model-selection error mentions the model
    // name on both sides of an effort refusal; the effort is the
    // unavailable subject, not the model, so the message stays task.
    'invalid model selection (--model "definitely-not-an-antigravity-model" --effort "medium"): --effort is not supported for model "definitely-not-an-antigravity-model"',
  ] as const;
  test.each(negatives)("negative %s is not unavailable", (line) => {
    expect(detectUnavailableInLine(line)).toBe(false);
  });
});

describe("issue #198: codex usage wall with U+2019", () => {
  const wall =
    "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 24th, 2026 7:24 AM.";

  test("curly apostrophe detects usage-limit (first match wins over credits)", () => {
    expect(wall).toContain("’ve");
    expect(detectLimitInLine(codexCli, wall)).toBe("usage-limit");
  });

  test("ASCII form still detects usage-limit", () => {
    expect(detectLimitInLine(codexCli, wall.replace("’", "'"))).toBe("usage-limit");
  });
});

describe("detectTrustRefusal (cursor)", () => {
  test("names the probe-01 trust gate stderr, case-insensitively", () => {
    expect(detectTrustRefusal(cursorCli, "Workspace Trust Required")).toBe(true);
    expect(detectTrustRefusal(cursorCli, "workspace trust required")).toBe(true);
    expect(detectTrustRefusal(cursorCli, "all done")).toBe(false);
  });

  test("harnesses without trustMatchers never detect", () => {
    expect(detectTrustRefusal(piCli, "Workspace Trust Required")).toBe(false);
  });
});
