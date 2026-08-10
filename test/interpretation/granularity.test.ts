import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildSessionArgv,
  streamingGranularityOf,
} from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("streamingGranularityOf (claude)", () => {
  test("session argv (full stream-json flag set) is token granularity", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: "abc-123" });
    expect(streamingGranularityOf(claudeCode, argv)).toBe("token");
  });

  test("bare -p launch argv is none - a reader cannot manufacture deltas", () => {
    const argv = buildLaunchArgv(claudeCode, { prompt: "hi" });
    expect(streamingGranularityOf(claudeCode, argv)).toBe("none");
  });

  test("a partial flag set does not count as token", () => {
    expect(
      streamingGranularityOf(claudeCode, ["claude", "-p", "--output-format", "stream-json"]),
    ).toBe("none");
  });
});
