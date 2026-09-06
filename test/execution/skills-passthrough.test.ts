/**
 * RFC-02 fix R1: skill tokens are part of the argv the launch builder
 * returns, so they land before any passthrough separator. Before this the
 * runner appended them after `--`, handing claude's --settings to the
 * harness as a positional.
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

describe("R1: skill tokens render before the passthrough separator", () => {
  test("claude: --settings precedes -- and the passthrough tail stays last", async () => {
    const argv = await spawnedArgv(claudeCode, ["--native-flag", "value"]);
    const settingsAt = argv.indexOf("--settings");
    const separatorAt = argv.indexOf("--");
    expect(settingsAt).toBeGreaterThan(-1);
    expect(separatorAt).toBeGreaterThan(-1);
    expect(settingsAt).toBeLessThan(separatorAt);
    expect(argv.slice(separatorAt + 1)).toEqual(["--native-flag", "value"]);
  });

  test("codex: -c skills.config precedes --", async () => {
    const argv = await spawnedArgv(codexCli, ["--native-flag"]);
    const configAt = argv.findIndex((t) => t.startsWith("skills.config="));
    expect(configAt).toBeGreaterThan(-1);
    expect(configAt).toBeLessThan(argv.indexOf("--"));
  });
});
