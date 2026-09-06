/**
 * RFC-02 fix R2: on codex, the access preset on a resumed turn renders
 * through the sandbox_mode config spelling. `codex exec resume` rejects
 * --sandbox (verified 0.147.0) and enforces -c sandbox_mode (issue #72),
 * so the launch spelling on resume was a native error waiting to happen.
 */
import { describe, expect, test } from "vitest";
import { buildResumeArgv } from "../../src/interpretation/argv.js";
import { codexCli } from "../../src/knowledge/codex.js";

const SESSION_ID = "0199a4c5-1111-2222-3333-444455556666";

describe("R2: codex access on resume", () => {
  test("read renders -c sandbox_mode, never --sandbox", () => {
    const argv = buildResumeArgv(codexCli, { prompt: "hi", sessionId: SESSION_ID, access: "read" });
    expect(argv).not.toContain("--sandbox");
    expect(argv).toContain("-c");
    expect(argv).toContain('sandbox_mode="read-only"');
  });

  test("write renders -c sandbox_mode with the workspace-write value", () => {
    const argv = buildResumeArgv(codexCli, {
      prompt: "hi",
      sessionId: SESSION_ID,
      access: "write",
    });
    expect(argv).not.toContain("--sandbox");
    expect(argv).toContain('sandbox_mode="workspace-write"');
  });
});
