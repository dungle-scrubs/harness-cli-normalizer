import { describe, expect, test } from "vitest";
import { detectLimit } from "../../src/interpretation/limits.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("detectLimit (claude)", () => {
  test("recognizes the real claude limit walls, scanning bottom-up", () => {
    expect(detectLimit(claudeCode, "blah\nYou've hit your session limit · resets 6:30pm")).toEqual({
      code: "session-limit",
      message: "You've hit your session limit · resets 6:30pm",
    });
    expect(
      detectLimit(claudeCode, "You've hit your weekly limit · resets 2am (Asia/Bangkok)"),
    ).toMatchObject({ code: "weekly-limit" });
    expect(detectLimit(claudeCode, "Usage limit reached")).toMatchObject({ code: "usage-limit" });
  });

  test("a clean transcript detects nothing - crash and clean exit are not limits", () => {
    expect(detectLimit(claudeCode, "all done\ngoodbye")).toBeNull();
    expect(detectLimit(claudeCode, "TypeError: x is not a function")).toBeNull();
  });
});
