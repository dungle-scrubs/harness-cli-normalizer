import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildSessionArgv,
  streamingGranularityOf,
} from "../../src/interpretation/argv.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("streamingGranularityOf (claude)", () => {
  test("session argv (full stream-json flag set) is token granularity", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: "abc-123" });
    expect(streamingGranularityOf(claudeCode, argv)).toBe("token");
  });

  test("a literal bare -p argv is none - a reader cannot manufacture deltas", () => {
    expect(streamingGranularityOf(claudeCode, ["claude", "-p", "hi"])).toBe("none");
  });

  test("a partial flag set does not count as token", () => {
    expect(
      streamingGranularityOf(claudeCode, ["claude", "-p", "--output-format", "stream-json"]),
    ).toBe("none");
  });

  test("duplicate flags resolve last-wins, like the CLI itself", () => {
    const argv = [
      ...buildSessionArgv(claudeCode, { sessionId: "abc-123" }),
      "--output-format",
      "text",
    ];
    expect(streamingGranularityOf(claudeCode, argv)).toBe("none");
  });

  test("equals-form flags satisfy the pin (pasted shell history)", () => {
    expect(
      streamingGranularityOf(claudeCode, [
        "claude",
        "-p",
        "--output-format=stream-json",
        "--verbose",
        "--include-partial-messages",
      ]),
    ).toBe("token");
  });

  test("--print aliases -p", () => {
    expect(
      streamingGranularityOf(claudeCode, [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ]),
    ).toBe("token");
  });

  test("the capability claim and the built argv agree for every headless mode", () => {
    const modes = {
      "headless-turn": buildLaunchArgv(claudeCode, { prompt: "hi" }),
      "headless-session": buildSessionArgv(claudeCode, { sessionId: "abc-123" }),
    } as const;
    for (const [mode, argv] of Object.entries(modes)) {
      expect(
        capabilitiesOf(claudeCode, "claude-opus-5", mode as keyof typeof modes).streaming,
        `mode ${mode}`,
      ).toBe(streamingGranularityOf(claudeCode, argv));
    }
  });
});
