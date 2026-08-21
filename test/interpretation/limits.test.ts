import { describe, expect, test } from "vitest";
import {
  detectAuthFailure,
  detectLimit,
  detectLimitInLine,
} from "../../src/interpretation/limits.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { museCode } from "../../src/knowledge/muse.js";

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
