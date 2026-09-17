/**
 * RFC-05 Phase 3: cursor joins post-`--` tokens into the positional prompt
 * as text (probe 41), so any non-empty passthrough tail refuses before
 * spawn with unsupported-passthrough. Descriptor-driven (launch
 * passthrough "prompt-joins"); the four existing harnesses declare no
 * behavior and keep passing tails through.
 */
import { describe, expect, test } from "vitest";
import { ArgvRefusalError, buildSpawnArgv } from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

describe("buildSpawnArgv cursor passthrough", () => {
  test("a non-empty tail refuses unsupported-passthrough naming the tokens", () => {
    let caught: ArgvRefusalError | null = null;
    try {
      buildSpawnArgv(cursorCli, { prompt: "hi", passthrough: ["--trust"] });
    } catch (err) {
      caught = err as ArgvRefusalError;
    }
    expect(caught).toBeInstanceOf(ArgvRefusalError);
    expect(caught?.issue).toBe("unsupported-passthrough");
    expect(caught?.harness).toBe("cursor");
    expect(caught?.supported).toEqual([]);
    expect(caught?.message).toContain("--trust");
  });

  test("the hint and message derive from the descriptor's name and bin", () => {
    // L5: no hardcoded harness or binary words in descriptor-driven paths.
    let caught: ArgvRefusalError | null = null;
    try {
      buildSpawnArgv(cursorCli, { prompt: "hi", passthrough: ["--trust"] });
    } catch (err) {
      caught = err as ArgvRefusalError;
    }
    expect(caught?.hint).toContain(cursorCli.name);
    expect(caught?.message).toContain(cursorCli.bin);
  });

  test("an empty tail still builds cursor argv", () => {
    const argv = buildSpawnArgv(cursorCli, { prompt: "hi", passthrough: [] });
    expect(argv).not.toContain("--");
  });

  test("other harnesses keep passing tails through after --", () => {
    const argv = buildSpawnArgv(claudeCode, { prompt: "hi", passthrough: ["--native-flag"] });
    expect(argv.at(-1)).toBe("--native-flag");
  });
});
