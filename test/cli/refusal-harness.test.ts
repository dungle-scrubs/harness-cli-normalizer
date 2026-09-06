/**
 * RFC-02 change 11: a refusal names a harness only when one was chosen.
 * Refusals raised while parsing, before any harness is known, carry no
 * harness and their message carries no harness fragment; the timeout
 * refusal names its own option.
 */
import { describe, expect, test } from "vitest";
import { parseEnvEntries, parseRunExtra, resolvePrompt } from "../../src/cli/args.js";
import { ArgvRefusalError, buildRefusalMessage } from "../../src/interpretation/refusal.js";

const caught = (work: () => unknown): ArgvRefusalError => {
  try {
    work();
  } catch (e) {
    if (e instanceof ArgvRefusalError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("refusals before a harness is chosen", () => {
  test("the harness field is absent, not a placeholder", () => {
    expect(caught(() => parseEnvEntries(["NOEQUALS"])).harness).toBeUndefined();
    expect(caught(() => resolvePrompt({})).harness).toBeUndefined();
    expect(caught(() => parseRunExtra({ timeout: "abc" })).harness).toBeUndefined();
    expect(caught(() => parseRunExtra({ resume: "a", "session-id": "b" })).harness).toBeUndefined();
  });

  test("the message carries no harness fragment when none was chosen", () => {
    const message = buildRefusalMessage("invalid-option-value", undefined, "questions", undefined, [
      "ask",
      "assume",
      "none",
    ]);
    expect(message).not.toMatch(/\bon claude\b/);
    expect(message).toContain('invalid value for option "questions"');
    expect(caught(() => parseEnvEntries(["NOEQUALS"])).message).not.toMatch(/claude/);
  });

  test("the message still names the harness when one was chosen", () => {
    expect(buildRefusalMessage("invalid-option-value", "pi", "effort")).toContain("on pi");
  });

  test("the timeout refusal names option timeout", () => {
    expect(caught(() => parseRunExtra({ timeout: "-1" })).option).toBe("timeout");
  });
});
