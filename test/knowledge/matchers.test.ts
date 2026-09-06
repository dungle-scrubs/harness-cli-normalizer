/**
 * RFC-02 change 9: one matcher compiler and one set of bounds in the
 * knowledge layer, used by both the limits scanner and the override
 * loader. The bounds are the defence against a crafted override file
 * causing catastrophic backtracking, so they must not fork.
 */
import { describe, expect, test } from "vitest";
import {
  HARNESS_MODES,
  RESUME_ON_MISSING,
  STREAMING_GRANULARITIES,
} from "../../src/knowledge/descriptor.js";
import {
  compileMatcher,
  MATCHER_FLAGS,
  MAX_MATCHERS_PER_KIND,
  MAX_PATTERN_LENGTH,
} from "../../src/knowledge/matchers.js";

describe("compileMatcher", () => {
  test("compiles a pattern with the case-insensitive default", () => {
    const re = compileMatcher("rate limit", undefined);
    expect(re.test("RATE LIMIT hit")).toBe(true);
    expect(re.flags).toBe("i");
  });

  test("refuses a pattern over the length bound", () => {
    expect(MAX_PATTERN_LENGTH).toBe(200);
    expect(() => compileMatcher("a".repeat(201), "i")).toThrow(/200/);
  });

  test("refuses sticky and global flags, and any flag outside the permitted set", () => {
    expect(MATCHER_FLAGS).toBe("imsu");
    expect(() => compileMatcher("x", "g")).toThrow(/g or y/);
    expect(() => compileMatcher("x", "y")).toThrow(/g or y/);
    expect(() => compileMatcher("x", "d")).toThrow(/outside imsu/);
  });

  test("refuses an uncompilable pattern with the engine's message", () => {
    expect(() => compileMatcher("(", "i")).toThrow(/uncompilable/);
  });

  test("the per-kind count bound is one number", () => {
    expect(MAX_MATCHERS_PER_KIND).toBe(64);
  });
});

describe("closed descriptor vocabularies are runtime arrays", () => {
  test("harness modes, streaming granularities, and resume-on-missing are declared once", () => {
    expect([...HARNESS_MODES]).toEqual(["headless-turn", "headless-session", "interactive"]);
    expect([...STREAMING_GRANULARITIES]).toEqual(["token", "message", "none"]);
    expect([...RESUME_ON_MISSING]).toEqual(["error", "create"]);
    expect(Object.isFrozen(HARNESS_MODES)).toBe(true);
  });
});
