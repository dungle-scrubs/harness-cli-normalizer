import { describe, expect, test } from "vitest";
import { parseResumeCommand } from "../../src/interpretation/parse-resume.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("parseResumeCommand (claude)", () => {
  test("round-trips {harness, sessionId, autonomy} from a pasted resume command", () => {
    expect(
      parseResumeCommand([claudeCode], "claude --resume eb04301d-8756-4a8b-ae3e-aac0e71f7265"),
    ).toEqual({
      harness: "claude",
      sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
      autonomy: false,
    });
    expect(
      parseResumeCommand([claudeCode], "claude --resume abc-123 --dangerously-skip-permissions"),
    ).toEqual({ harness: "claude", sessionId: "abc-123", autonomy: true });
  });

  test("returns null for commands that are not a known resume shape", () => {
    expect(parseResumeCommand([claudeCode], "claude -p 'hello'")).toBeNull();
    expect(parseResumeCommand([claudeCode], "vim notes.md")).toBeNull();
  });
});
