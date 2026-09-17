/**
 * RFC-02 fix R1: skill tokens are part of the argv the launch builder
 * returns, so they land before the passthrough tail. Before this the
 * runner appended them after `--`, handing claude's --settings to the
 * harness as a positional. ADR 0003 renders no separator at all: the tail
 * sits at the descriptor placement (after-argv on both harnesses here).
 */
import { describe, expect, test } from "vitest";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const skills = { picks: ["/registry/hcn"], known: ["hcn", "other"] };

const spawnedArgv = async (
  h: typeof claudeCode,
  passthrough: readonly string[],
): Promise<readonly string[]> => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const turn = streamTurn(
    h,
    { prompt: "hi", skills, passthrough },
    { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
  );
  proc.exit(0);
  for await (const _event of turn) {
    // drain
  }
  return spawner.calls[0]?.argv ?? [];
};

describe("R1: skill tokens render before the passthrough tail", () => {
  test("claude: --settings precedes the tail and the tail stays last, no separator", async () => {
    const argv = await spawnedArgv(claudeCode, ["--native-flag", "value"]);
    expect(argv).not.toContain("--");
    const settingsAt = argv.indexOf("--settings");
    expect(settingsAt).toBeGreaterThan(-1);
    expect(argv.slice(-2)).toEqual(["--native-flag", "value"]);
    expect(settingsAt).toBeLessThan(argv.length - 2);
  });

  test("codex: -c skills.config precedes the tail, no separator", async () => {
    const argv = await spawnedArgv(codexCli, ["--native-flag"]);
    expect(argv).not.toContain("--");
    const configAt = argv.findIndex((t) => t.startsWith("skills.config="));
    expect(configAt).toBeGreaterThan(-1);
    expect(argv.at(-1)).toBe("--native-flag");
    expect(configAt).toBeLessThan(argv.length - 1);
  });
});
