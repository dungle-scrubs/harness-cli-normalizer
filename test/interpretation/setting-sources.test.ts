/**
 * Issue #457: `--setting-sources` on claude runs and sessions - the
 * descriptor-owned render (an explicit selection replaces the session
 * default `project`; a bare run renders nothing, as it always has), the
 * validation (non-empty, known values, no repeats), the refusal on other
 * harnesses, and the mutual exclusion with `--no-extensions`, whose only
 * claude spelling is the same native flag pinned to `project`.
 */
import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildResumeArgv,
  buildSessionArgv,
  buildSpawnArgv,
  validateSettingSources,
} from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

describe("issue #457: run renders an explicit selection only", () => {
  test("a bare launch argv is unchanged - no setting-sources flag", () => {
    const argv = buildLaunchArgv(claudeCode, { prompt: "hi" });
    expect(argv).not.toContain("--setting-sources");
    expect(argv).toEqual([
      "claude",
      "-p",
      "hi",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
  });

  test("an explicit selection appends the flag with the joined list", () => {
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "hi",
      settingSources: ["user", "project", "local"],
    });
    expect(argv.slice(-2)).toEqual(["--setting-sources", "user,project,local"]);
  });

  test("the resume grammar renders it too", () => {
    const argv = buildResumeArgv(claudeCode, {
      sessionId: sid,
      prompt: "hi",
      settingSources: ["user"],
    });
    expect(argv.slice(-2)).toEqual(["--setting-sources", "user"]);
  });

  test("a rejected selection refuses before any argv", () => {
    for (const bad of [["nope"], ["user", "user"], []]) {
      expect(() => buildSpawnArgv(claudeCode, { prompt: "hi", settingSources: bad })).toThrow(
        /setting-sources|settingSources/,
      );
    }
  });
});

describe("issue #457: sessions render the default or the replacement", () => {
  test("without a selection the argv is byte for byte the curated default", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid });
    expect(argv).toEqual([
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "project",
      "--session-id",
      sid,
    ]);
  });

  test("an explicit selection replaces the default in place", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: sid,
      settingSources: ["user", "project", "local"],
    });
    expect(argv.slice(8, 10)).toEqual(["--setting-sources", "user,project,local"]);
    expect(argv).toHaveLength(12);
  });

  test("a rejected selection refuses before any session argv", () => {
    expect(() =>
      buildSessionArgv(claudeCode, { sessionId: sid, settingSources: ["user", "user"] }),
    ).toThrow(/repeated value/);
  });
});

describe("issue #457: other harnesses refuse the option", () => {
  test("pi has no setting-sources flag and refuses with claude as support", () => {
    expect(() => validateSettingSources(piCli, ["user"])).toThrow(/no setting-sources flag/);
    expect(() => buildSpawnArgv(piCli, { prompt: "hi", settingSources: ["user"] })).toThrow(
      /supported: claude/,
    );
    expect(() => buildSessionArgv(piCli, { sessionId: sid, settingSources: ["user"] })).toThrow(
      /no setting-sources flag/,
    );
  });
});

describe("issue #457: --setting-sources refuses with --no-extensions on claude", () => {
  test("both select the same native flag's value differently", () => {
    expect(() =>
      buildSpawnArgv(claudeCode, {
        prompt: "hi",
        settingSources: ["user"],
        discovery: { extensions: false },
      }),
    ).toThrow(/--no-extensions pins them to project/);
  });

  test("the facet alone still renders its own spelling", () => {
    const argv = buildSpawnArgv(claudeCode, {
      prompt: "hi",
      discovery: { extensions: false },
    });
    expect(argv).toContain("--setting-sources");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project");
  });
});
