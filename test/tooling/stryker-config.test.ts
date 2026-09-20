import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const configUrl = new URL("../../stryker.config.mjs", import.meta.url).href;

interface ConfigProbe {
  readonly reportFileName: string;
  readonly threshold: number;
}

function loadConfig(args: readonly string[]): SpawnSyncReturns<string> {
  const program = `
    process.argv.push(...${JSON.stringify(args)});
    const { default: config } = await import(${JSON.stringify(configUrl)});
    process.stdout.write(JSON.stringify({
      reportFileName: config.jsonReporter.fileName,
      threshold: config.thresholds.break,
    }));
  `;

  return spawnSync("node", ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
}

describe("Stryker mutation lanes", () => {
  it.each([
    ["src/execution/failure.ts", "failure", 75],
    ["src/interpretation/argv.ts", "argv", 84],
    ["src/interpretation/content.ts", "content", 81],
    ["src/interpretation/session-input.ts", "session-input", 99],
  ])("maps %s to the reviewed %s lane", (mutatedFile, lane, threshold) => {
    const result = loadConfig(["--mutate", mutatedFile]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as ConfigProbe).toEqual({
      reportFileName: `reports/mutation/${lane}.json`,
      threshold,
    });
  });

  it.each([
    ["a bare invocation", []],
    ["an unknown target", ["--mutate", "src/interpretation/unknown.ts"]],
  ])("refuses %s before mutation starts", (_label, args) => {
    const result = loadConfig(args);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported Stryker mutation lane");
    expect(result.stderr).toContain("pnpm test:mutation:failure");
  });
});
