import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const failureFor = (harness: string, value: string): Record<string, unknown> => {
  const dir = mkdtempSync(`${tmpdir()}/hcn-session-window-`);
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "session", harness, "--json", "--context-window", value],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          XDG_DATA_HOME: dir,
          HERDR_ENV: "",
        },
      },
    );
    expect(result.status).toBe(2);
    expect(result.error).toBeUndefined();
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)?.kind).toBe("closed");
    const failure = events.find((event) => event.kind === "failure");
    expect(failure).toBeDefined();
    if (failure === undefined) throw new Error("Expected failure event");
    return failure;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("hcn session --context-window", () => {
  test("out-of-range and non-integer values refuse with exit 2 before spawn", () => {
    for (const value of ["99999", "1000001", "1.5", "nope"]) {
      const failure = failureFor("claude", value);
      expect(failure.issue).toBe("invalid-option-value");
      expect(failure.option).toBe("contextWindow");
      expect(failure.supported).toEqual(["[100000, 1000000] integer"]);
    }
  });

  test("a session harness without the spec refuses instead of ignoring the flag", () => {
    const failure = failureFor("pi", "100000");
    expect(failure.issue).toBe("unsupported-option");
    expect(failure.option).toBe("contextWindow");
    expect(failure.supportedBy).toEqual([
      { harness: "claude", spelling: "--autocompact" },
      { harness: "codex", spelling: "-c" },
      { harness: "popeye", spelling: "--context-window" },
    ]);
  });
});
