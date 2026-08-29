import { describe, expect, test } from "vitest";
import {
  ArgvRefusalError,
  buildLaunchArgv,
  buildResumeArgv,
  buildSessionArgv,
} from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("buildLaunchArgv (claude)", () => {
  test("places the positional prompt before --allowedTools", () => {
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "summarize this repo",
      tools: ["read", "grep"],
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
    expect(() => buildLaunchArgv(claudeCode, { prompt: "hi", tools: ["read", "  "] })).toThrow(
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

  test("pins the whole argv for claude (no extra flags)", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
    });
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
      "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
    ]);
  });

  test("pins the whole argv for pi as pi --mode rpc (no -p, no duplicated --mode)", () => {
    const argv = buildSessionArgv(piCli, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
    });
    expect(argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--session-id",
      "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
    ]);
  });
});

describe("buildSessionArgv effort", () => {
  test("claude renders the validated effort after the session id", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
      effort: "high",
    });
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(argv.indexOf("--effort")).toBeGreaterThan(
      argv.indexOf("eb04301d-8756-4a8b-ae3e-aac0e71f7265"),
    );
  });

  test("pi renders effort through its own flag (--thinking), its own ladder (off)", () => {
    const argv = buildSessionArgv(piCli, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
      effort: "off",
    });
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("off");
  });

  test("model and effort ride together: model flag first, effort validated after", () => {
    const argv = buildSessionArgv(claudeCode, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
      model: "opus",
      effort: "high",
    });
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("--effort"));
  });

  test("an off-ladder effort refuses with the harness ladder as the supported list", () => {
    let caught: unknown;
    try {
      buildSessionArgv(claudeCode, {
        sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
        effort: "off",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ArgvRefusalError);
    const err = caught as ArgvRefusalError;
    expect(err.issue).toBe("unknown-effort");
    expect(err.supported).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("effort and provider render in TURN_OPTION_KEYS order (effort first)", () => {
    const argv = buildSessionArgv(piCli, {
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
      effort: "high",
      provider: "lmstudio",
    });
    expect(argv.indexOf("--thinking")).toBeLessThan(argv.indexOf("--provider"));
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
      buildLaunchArgv(claudeCode, { prompt: "hi", tools: ["read,write", "grep"] }),
    ).toThrow(/tool/i);
  });

  test("a traversal-shaped session id never reaches argv", () => {
    expect(() =>
      buildResumeArgv(claudeCode, { sessionId: "../../../etc/passwd", prompt: "hi" }),
    ).toThrow(/session id/i);
  });

  test("a malformed resume id is a typed ArgvRefusalError, not a bare throw (F-01)", () => {
    for (const build of [
      () => buildResumeArgv(claudeCode, { sessionId: "../../etc/passwd", prompt: "hi" }),
      () => buildSessionArgv(claudeCode, { sessionId: "--dangerously-skip-permissions" }),
    ]) {
      let caught: unknown;
      try {
        build();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ArgvRefusalError);
      const err = caught as ArgvRefusalError;
      expect(err.issue).toBe("invalid-option-value");
      expect(err.harness).toBe("claude");
      expect(err.supported[0]).toMatch(/session id/);
    }
  });

  test("validated model and autonomy selections are inserted by the builder, never appended by callers", () => {
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "hi",
      model: "opus",
      autonomy: true,
      tools: ["read"],
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

describe("buildSessionArgv refuses no-session-mode harnesses (F-48)", () => {
  test("codex has no session mode - buildSessionArgv throws ArgvRefusalError no-session-mode", () => {
    let caught: unknown;
    try {
      buildSessionArgv(codexCli, { sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ArgvRefusalError);
    const err = caught as ArgvRefusalError;
    expect(err.issue).toBe("no-session-mode");
    expect(err.harness).toBe("codex");
    expect(err.supported.length).toBeGreaterThan(0);
    for (const name of err.supported) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toContain(" ");
    }
  });
});

describe("pi resume argv matches captured fixture (F-26)", () => {
  test("buildResumeArgv pi reproduces resume.argv.json with prompt substituted", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { piCli } = await import("../../src/knowledge/pi.js");
    const prompt = "Reply with only the codeword you were told.";
    const sessionId = "01a022e3-9afb-7ce5-88f5-07ad0e9ac8fa";
    // The captured argv carries --thinking high and --tools from the effective
    // config at capture time (fixture README: hcn inspect pi --argv --resume
    // <id> --prompt "..."); the interpretation test must include those to
    // reproduce the fixture. Minimal buildResumeArgv without them would omit
    // those flags.
    const expectedRaw = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../fixtures/pi-rpc-spike/06-resume-after-close/resume.argv.json",
        ),
        "utf8",
      ),
    ) as string[];
    const expected = expectedRaw.map((tok) => (tok === "[prompt:43ch]" ? prompt : tok));
    const argv = buildResumeArgv(piCli, {
      sessionId,
      prompt,
      effort: "high",
      tools: ["read", "shell", "edit", "write", "grep", "glob", "list"],
    });
    expect(argv).toEqual(expected);
  });
});

describe("buildSessionArgv resumeFlag vs idFlag (issue #97)", () => {
  test("a resuming session argv for claude never contains --session-id", () => {
    const id = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    const argv = buildSessionArgv(claudeCode, { sessionId: id, isResume: true });
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--session-id");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(id);
  });

  test("fresh session argv for claude still contains --session-id", () => {
    const id = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    const fresh = buildSessionArgv(claudeCode, { sessionId: id });
    expect(fresh).toContain("--session-id");
    expect(fresh).not.toContain("--resume");
  });

  test("pi resume and fresh both use --session-id (same flag)", () => {
    const id = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    const fresh = buildSessionArgv(piCli, { sessionId: id });
    const resumed = buildSessionArgv(piCli, { sessionId: id, isResume: true });
    expect(fresh).toContain("--session-id");
    expect(resumed).toContain("--session-id");
  });
});

describe("codex sandbox on resume renders as -c sandbox_mode (spike A-001, issue #72)", () => {
  const tid = "01a02f1a-ae41-7343-a9c8-e9241e75e073";

  test("renders the config-kv spelling, never --sandbox, which resume rejects", () => {
    const argv = buildResumeArgv(codexCli, { sessionId: tid, prompt: "hi", sandbox: "read-only" });
    expect(argv).toContain("-c");
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(argv).not.toContain("--sandbox");
  });

  test("is the same spelling the live spike proved enforced", () => {
    // test/fixtures/phase13-codex-sandbox-resume/: a thread that wrote under
    // workspace-write, resumed under -c sandbox_mode="read-only", could not
    // write; resumed again under workspace-write, wrote. Enforced, not merely
    // accepted - the descriptor's previous resumeRender: null understated it.
    const ro = buildResumeArgv(codexCli, { sessionId: tid, prompt: "p", sandbox: "read-only" });
    const rw = buildResumeArgv(codexCli, {
      sessionId: tid,
      prompt: "p",
      sandbox: "workspace-write",
    });
    expect(ro.indexOf("-c")).toBeGreaterThan(ro.indexOf("resume"));
    expect(rw).toContain('sandbox_mode="workspace-write"');
  });
});
