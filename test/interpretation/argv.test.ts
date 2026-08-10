import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildResumeArgv,
  buildSessionArgv,
} from "../../src/interpretation/argv.js";
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

describe("buildResumeArgv (claude)", () => {
  test("resumes the caller-assigned id verbatim with --resume, no rotation handling", () => {
    const id = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    const argv = buildResumeArgv(claudeCode, { sessionId: id, prompt: "continue" });
    const at = argv.indexOf("--resume");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe(id);
    // A-005: resume never mints a new id, so there is nothing fork-shaped
    // in a plain resume - forking is only ever an explicit flag.
    expect(argv).not.toContain("--fork-session");
  });

  test("refuses a session id containing control characters (selector oracle)", () => {
    expect(() => buildResumeArgv(claudeCode, { sessionId: "abc\n--yolo", prompt: "hi" })).toThrow(
      /session/i,
    );
  });
});

describe("buildSessionArgv (claude)", () => {
  test("opens a persistent session with the A-001-verified stream-json flag set", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
    });
    for (const required of [
      "--input-format",
      "--output-format",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
    ]) {
      expect(argv).toContain(required);
    }
    expect(argv[argv.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("eb04301d-8756-4a8b-ae3e-aac0e71f7265");
  });
});
