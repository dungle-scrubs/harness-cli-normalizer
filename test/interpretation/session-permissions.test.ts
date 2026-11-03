/**
 * Issue #443: the permission dimensions a session spawn accepts, at the
 * builder level.
 *
 * A session renders them through the owners a one-shot turn uses - the
 * tool selection renderer, the turn-option renderer and the descriptor's
 * autonomy flag - so the native spelling and the refusal are the same
 * ones a turn produces. The phase is RESUME for both, so a bare session
 * renders no launch default, and a dimension the harness cannot express
 * refuses instead of being dropped.
 */
import { describe, expect, test } from "vitest";
import { buildSessionArgv } from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

describe("session permission dimensions (issue #443)", () => {
  test("a tool grant renders the same tokens a one-shot turn renders", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid, tools: ["read"] });
    expect(flagValue(argv, "--allowedTools")).toBe("Read");
    // claude's include flag grants without restricting, so the complement
    // rides beside it - the shape the run path renders too.
    expect(flagValue(argv, "--disallowedTools")).toContain("Bash");
  });

  test("an exclude list renders the deny list", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid, excludeTools: ["shell"] });
    expect(flagValue(argv, "--disallowedTools")).toBe("Bash");
  });

  test("the read access preset renders through the access owner", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid, access: "read" });
    expect(flagValue(argv, "--tools")).toBe("Read,Grep,Glob,WebFetch,WebSearch");
    expect(flagValue(argv, "--permission-mode")).toBe("dontAsk");
    expect(flagValue(argv, "--disallowedTools")).toBe("mcp__*");
  });

  test("the write access preset renders as the inline settings it is", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid, access: "write" });
    expect(flagValue(argv, "--permission-mode")).toBe("acceptEdits");
    expect(flagValue(argv, "--settings")).toContain('"sandbox"');
  });

  test("Claude session write access composes with selected skills in one settings object", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: sid,
      access: "write",
      skills: { picks: ["/registry/keep"], known: ["keep", "drop"] },
    });
    expect(argv.filter((token) => token === "--settings")).toHaveLength(1);
    expect(JSON.parse(flagValue(argv, "--settings") ?? "null")).toEqual({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        filesystem: { disabled: false },
      },
      skillOverrides: { drop: "off" },
    });
  });

  test("the pi read preset rides the tool list", () => {
    const argv = buildSessionArgv(piCli, { sessionId: sid, access: "read" });
    // The preset names the canonicals pi can express; the ones it cannot
    // (web-fetch, web-search) drop out, exactly as they do on a turn.
    expect(flagValue(argv, "--tools")).toBe("read,grep,find,ls");
  });

  test("an autonomy grant rides the descriptor's own flag", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid, autonomy: true });
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  test("autonomy:false is a no-op, exactly as it is on a turn", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid, autonomy: false });
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  test("pi has no unattended-run flag, so an autonomy grant refuses", () => {
    expect(() => buildSessionArgv(piCli, { sessionId: sid, autonomy: true })).toThrow(
      /no unattended-run flag/,
    );
  });

  test("the tools discovery facet renders where the harness has one", () => {
    const argv = buildSessionArgv(piCli, { sessionId: sid, discovery: { tools: false } });
    expect(argv).toContain("-nt");
  });

  test("claude has no tools-discovery toggle, so the facet refuses", () => {
    expect(() =>
      buildSessionArgv(claudeCode, { sessionId: sid, discovery: { tools: false } }),
    ).toThrow(/discovery facet/);
  });

  test("a session whose grammar carries no permission dimension refuses", () => {
    expect(() => buildSessionArgv(codexCli, { sessionId: sid, tools: ["read"] })).toThrow(
      /carries no permission dimension/,
    );
  });

  test("an include list and an exclude list refuse each other", () => {
    expect(() =>
      buildSessionArgv(claudeCode, { sessionId: sid, tools: ["read"], excludeTools: ["shell"] }),
    ).toThrow(/mutual exclusion/);
  });

  test("an access preset and a tool list refuse each other", () => {
    expect(() =>
      buildSessionArgv(claudeCode, { sessionId: sid, access: "read", tools: ["read"] }),
    ).toThrow(/mutual exclusion/);
  });

  test("an unknown tool name refuses instead of rendering something else", () => {
    expect(() => buildSessionArgv(claudeCode, { sessionId: sid, tools: ["bogus"] })).toThrow(
      /unknown tool name/,
    );
  });

  test("the merged toolMap names the native tool", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: sid,
      tools: ["read"],
      toolMap: { claude: { read: { native: "MyRead", tier: "user-config" } } },
    });
    expect(flagValue(argv, "--allowedTools")).toBe("MyRead");
  });

  test("a bare session renders no permission dimension and no launch default", () => {
    const argv = buildSessionArgv(claudeCode, { sessionId: sid });
    for (const flag of [
      "--allowedTools",
      "--disallowedTools",
      "--tools",
      "--permission-mode",
      "--settings",
      "--dangerously-skip-permissions",
      "--sandbox",
    ]) {
      expect(argv, `a bare session must not render ${flag}`).not.toContain(flag);
    }
  });

  test("a permission grant rides a resumed session too", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: sid,
      isResume: true,
      tools: ["read"],
    });
    expect(flagValue(argv, "--resume")).toBe(sid);
    expect(flagValue(argv, "--allowedTools")).toBe("Read");
  });
});
