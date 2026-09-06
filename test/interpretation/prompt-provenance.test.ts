/**
 * RFC-02 change 13: the prompt carries its own provenance. A plain string
 * is an implicit, positional prompt and gets the leading-dash guard; the
 * object form says it came from an explicit flag or file and bypasses it.
 * One accessor yields the text for the runner and for redaction; no
 * hidden field crosses the seam.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { buildLaunchArgv, promptTextOf } from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

describe("the prompt carries its own provenance", () => {
  test("an implicit prompt starting with a dash refuses; an explicit one passes", () => {
    expect(() => buildLaunchArgv(claudeCode, { prompt: "-x" })).toThrow(/prompt/i);
    const argv = buildLaunchArgv(claudeCode, { prompt: { text: "-x", explicit: true } });
    expect(argv).toContain("-x");
  });

  test("one accessor yields the text for either form", () => {
    expect(promptTextOf({ prompt: "hi" })).toBe("hi");
    expect(promptTextOf({ prompt: { text: "-x", explicit: true } })).toBe("-x");
  });

  test("redaction still masks the prompt slot when the object form is used", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const logged: Record<string, unknown>[] = [];
    const turn = streamTurn(
      claudeCode,
      { prompt: { text: "-x", explicit: true }, questions: "none" },
      {
        spawn: spawner.spawn,
        clock: new FakeClock(),
        signal: fakeSignal().signal,
        log: (e) => logged.push(e),
      },
    );
    proc.exit(0);
    for await (const _event of turn) {
      // drain
    }
    const spawn = logged.find((e) => e.event === "spawn");
    expect(spawn?.argv).toContain("[prompt:2ch]");
    expect(spawn?.argv).not.toContain("-x");
    expect(spawner.calls[0]?.argv).toContain("-x");
  });

  test("no double-underscore prompt field exists in source", () => {
    const src = join(import.meta.dirname, "../../src");
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        expect(readFileSync(full, "utf8"), `${full} carries a hidden prompt field`).not.toMatch(
          /__explicitPrompt/,
        );
      }
    };
    walk(src);
  });
});
