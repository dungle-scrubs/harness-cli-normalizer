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

describe("shared spawn-boundary guards", () => {
  test("buildResumeArgv refuses a flag-shaped prompt exactly like buildLaunchArgv", () => {
    expect(() =>
      buildResumeArgv(claudeCode, {
        sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
        prompt: "--dangerously-skip-permissions",
      }),
    ).toThrow(/prompt/i);
  });

  test("a comma inside one tool name is refused - it would silently split the grant", () => {
    expect(() =>
      buildLaunchArgv(claudeCode, { prompt: "hi", tools: ["Read,Write", "Grep"] }),
    ).toThrow(/tool/i);
  });

  test("a traversal-shaped session id never reaches argv", () => {
    expect(() =>
      buildResumeArgv(claudeCode, { sessionId: "../../../etc/passwd", prompt: "hi" }),
    ).toThrow(/session id/i);
  });

  test("validated model and autonomy selections are inserted by the builder, never appended by callers", () => {
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "hi",
      model: "opus",
      autonomy: true,
      tools: ["Read"],
    });
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(argv).toContain("--dangerously-skip-permissions");
    // The tools flags stay LAST so nothing after them can be swallowed; on
    // claude an include renders grant + deny-complement, and the final
    // pair is the disallow list.
    expect(argv[argv.length - 2]).toBe("--disallowedTools");
    expect(argv[argv.length - 1]).not.toContain("Read,");
    expect(argv[argv.length - 1]).toContain("Edit");
    expect(() => buildLaunchArgv(claudeCode, { prompt: "hi", model: "gpt-5.6-sol" })).toThrow(
      /model/i,
    );
  });
});
