import { describe, expect, test } from "vitest";
import { parseResumeCommand } from "../../src/interpretation/parse-resume.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const uuid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

describe("parseResumeCommand (claude)", () => {
  test("round-trips {harness, sessionId, autonomy} from a pasted resume command", () => {
    expect(parseResumeCommand([claudeCode], `claude --resume ${uuid}`)).toEqual({
      harness: "claude",
      sessionId: uuid,
      autonomy: false,
    });
    expect(
      parseResumeCommand([claudeCode], `claude --resume ${uuid} --dangerously-skip-permissions`),
    ).toEqual({ harness: "claude", sessionId: uuid, autonomy: true });
  });

  test("tolerates what shell history actually carries", () => {
    expect(parseResumeCommand([claudeCode], `claude --resume "${uuid}"`)).toMatchObject({
      sessionId: uuid,
    });
    expect(
      parseResumeCommand([claudeCode], `/usr/local/bin/claude --resume ${uuid}`),
    ).toMatchObject({ harness: "claude" });
    expect(parseResumeCommand([claudeCode], `claude -r ${uuid}`)).toMatchObject({
      sessionId: uuid,
    });
    expect(parseResumeCommand([claudeCode], `claude --resume=${uuid}`)).toMatchObject({
      sessionId: uuid,
    });
  });

  test("an id-shaped token in prompt text is never returned as the session id (D-011)", () => {
    expect(parseResumeCommand([claudeCode], `claude -p "please --resume ${uuid} now"`)).toBeNull();
    const second = "11111111-2222-3333-4444-555555555555";
    expect(parseResumeCommand([claudeCode], `claude --resume ${uuid} ${second}`)).toBeNull();
  });

  test("ids that fail the harness id shape are refused, not guessed", () => {
    expect(parseResumeCommand([claudeCode], "claude --resume abc-123")).toBeNull();
    expect(parseResumeCommand([claudeCode], "claude --resume my project notes")).toBeNull();
  });

  test("returns null for commands that are not a known resume shape", () => {
    expect(parseResumeCommand([claudeCode], "claude -p 'hello'")).toBeNull();
    expect(parseResumeCommand([claudeCode], "vim notes.md")).toBeNull();
  });

  test("positional style anchors the resume word at position 1 exactly", () => {
    const museShaped = {
      ...claudeCode,
      bin: "muse",
      resume: {
        style: "positional" as const,
        flag: "resume",
        aliases: [],
        idShape: /^[a-z0-9-]{8,}$/,
        extraFlags: [],
        onMissing: "error" as const,
      },
    };
    expect(parseResumeCommand([museShaped], "muse resume abcd1234-session")).toMatchObject({
      sessionId: "abcd1234-session",
    });
    expect(parseResumeCommand([museShaped], 'muse -p "resume abcd1234-session"')).toBeNull();
  });
});
