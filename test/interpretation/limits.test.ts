import { describe, expect, test } from "vitest";
import {
  detectAuthFailure,
  detectAuthFailureInLine,
  detectLimit,
  detectLimitInLine,
  detectTransportInLine,
  detectUnavailableInLine,
} from "../../src/interpretation/limits.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("detectLimit (claude)", () => {
  test("recognizes the real claude limit walls, scanning bottom-up, code only", () => {
    expect(detectLimit(claudeCode, "blah\nYou've hit your session limit · resets 6:30pm")).toBe(
      "session-limit",
    );
    expect(
      detectLimit(claudeCode, "You've hit your weekly limit · resets 2am (Asia/Bangkok)"),
    ).toBe("weekly-limit");
    expect(detectLimit(claudeCode, "Usage limit reached")).toBe("usage-limit");
  });

  test("returns the code alone - never the matched line (D-005: no content rides along)", () => {
    const detected = detectLimit(claudeCode, "secret prompt text you've hit your usage limit");
    expect(detected).toBe("usage-limit");
    expect(typeof detected).toBe("string");
  });

  test("a clean transcript detects nothing - crash and clean exit are not limits", () => {
    expect(detectLimit(claudeCode, "all done\ngoodbye")).toBeNull();
    expect(detectLimit(claudeCode, "TypeError: x is not a function")).toBeNull();
  });

  test("per-line entry point serves streaming readers", () => {
    expect(detectLimitInLine(claudeCode, "You've hit your weekly limit · resets 2am")).toBe(
      "weekly-limit",
    );
    expect(detectLimitInLine(claudeCode, '{"type":"token","text":"hi"}')).toBeNull();
  });

  test("batch scan is bounded to the tail - a wall buried 10k lines up is out of scope", () => {
    const buried = `You've hit your usage limit\n${"noise line\n".repeat(10_000)}`;
    expect(detectLimit(claudeCode, buried)).toBeNull();
  });
});

describe("detectAuthFailure (claude)", () => {
  test("auth walls classify separately from usage limits - the remedy differs", () => {
    expect(detectAuthFailure(claudeCode, "OAuth session expired")).toBe("expired");
    expect(detectAuthFailure(claudeCode, "Not logged in. Please run /login")).toBe("not-logged-in");
    expect(detectAuthFailure(claudeCode, "Invalid API key")).toBe("invalid-key");
    expect(detectAuthFailure(claudeCode, "You've hit your usage limit")).toBeNull();
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
  ];
  test.each(positives)("positive $desc: $line", ({ line }) => {
    expect(detectTransportInLine(line)).toBe(true);
  });

  const negatives = ["port 5020", "elapsed 502ms", "read 5030 bytes"] as const;
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
  ];
  test.each(positives)("positive $desc: $line", ({ line }) => {
    expect(detectUnavailableInLine(line)).toBe(true);
  });

  const negatives = ["model answered", "found 3 models"] as const;
  test.each(negatives)("negative %s is not unavailable", (line) => {
    expect(detectUnavailableInLine(line)).toBe(false);
  });
});
