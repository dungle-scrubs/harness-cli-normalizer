import { describe, expect, test } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("buildLaunchArgv (claude)", () => {
  test("places the positional prompt before --allowedTools", () => {
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "summarize this repo",
      tools: ["Read", "Grep"],
    });
    const promptAt = argv.indexOf("summarize this repo");
    const toolsFlagAt = argv.indexOf("--allowedTools");
    expect(promptAt).toBeGreaterThan(-1);
    expect(toolsFlagAt).toBeGreaterThan(-1);
    expect(promptAt).toBeLessThan(toolsFlagAt);
  });

  test("refuses a positional prompt that starts with '-' (flag injection)", () => {
    expect(() =>
      buildLaunchArgv(claudeCode, { prompt: "--dangerously-skip-permissions do it" }),
    ).toThrow(/prompt/i);
  });

  test("refuses an empty or blank tool grant instead of emitting --allowedTools ''", () => {
    expect(() => buildLaunchArgv(claudeCode, { prompt: "hi", tools: [""] })).toThrow(/tool/i);
    expect(() => buildLaunchArgv(claudeCode, { prompt: "hi", tools: ["Read", "  "] })).toThrow(
      /tool/i,
    );
  });
});
