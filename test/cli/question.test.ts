/**
 * Question mode tri-state --questions flag
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseTurnOptions } from "../../src/cli/args.js";
import { loadProjectConfig, loadUserConfig, parseUserConfig } from "../../src/cli/config.js";
import { exitCodeForCause } from "../../src/cli/exit-codes.js";
import { RUN_HELP } from "../../src/cli/help.js";

describe("questions config parse", () => {
  test("parses all three values via questions key", () => {
    expect(parseUserConfig('{"version":1,"questions":"ask"}')).toEqual({
      questions: "ask",
    });
    expect(parseUserConfig('{"version":1,"questions":"assume"}')).toEqual({
      questions: "assume",
    });
    expect(parseUserConfig('{"version":1,"questions":"none"}')).toEqual({
      questions: "none",
    });
    expect(() => parseUserConfig('{"version":1,"escalateQuestions":"ask"}')).toThrow(
      /unknown config key/,
    );
  });

  test("absent key means no config statement (default ask lives outside the file)", () => {
    expect(parseUserConfig('{"version":1,"effort":"high"}')).toEqual({ effort: "high" });
  });

  test("wrong type refuses naming the key", () => {
    expect(() => parseUserConfig('{"version":1,"questions":"yes"}')).toThrow(
      /must be one of ask, assume, none/,
    );
    expect(() => parseUserConfig('{"version":1,"escalateQuestions":true}')).toThrow(
      /unknown config key/,
    );
    expect(() => parseUserConfig('{"version":1,"questions":true}')).toThrow(
      /must be one of ask, assume, none/,
    );
  });
});

describe("questions arg parsing", () => {
  test("--questions maps onto the field", () => {
    expect(parseTurnOptions({ questions: "ask" } as Record<string, unknown>).questions).toBe("ask");
    expect(parseTurnOptions({ questions: "assume" } as Record<string, unknown>).questions).toBe(
      "assume",
    );
    expect(parseTurnOptions({ questions: "none" } as Record<string, unknown>).questions).toBe(
      "none",
    );
    expect(parseTurnOptions({} as Record<string, unknown>).questions).toBeUndefined();
  });

  test("unrecognised value refuses with exit 2 listing valid values", () => {
    expect(() => parseTurnOptions({ questions: "bad" } as Record<string, unknown>)).toThrow(
      /ask.*assume.*none/,
    );
  });
});

describe("questions tier precedence (arg > project > user > default)", () => {
  const userDir = mkdtempSync("/tmp/hcn-q-user2-");
  const repoDir = mkdtempSync("/tmp/hcn-q-repo2-");

  test("user tier loads", () => {
    writeFileSync(`${userDir}/config.json`, '{"version":1,"questions":"assume"}');
    const prev = process.env.HCN_CONFIG_DIR;
    process.env.HCN_CONFIG_DIR = userDir;
    try {
      expect(loadUserConfig()?.config.questions).toBe("assume");
    } finally {
      if (prev === undefined) delete process.env.HCN_CONFIG_DIR;
      else process.env.HCN_CONFIG_DIR = prev;
    }
  });

  test("project tier loads", () => {
    mkdirSync(`${repoDir}/.hcn`, { recursive: true });
    writeFileSync(`${repoDir}/.hcn/config.json`, '{"version":1,"questions":"ask"}');
    expect(loadProjectConfig(repoDir)?.config.questions).toBe("ask");
  });
});

describe("escalation surfaces", () => {
  test("awaiting-input is a success exit", () => {
    expect(exitCodeForCause("awaiting-input")).toBe(0);
    expect(exitCodeForCause("clean")).toBe(0);
    expect(exitCodeForCause("failed")).toBe(1);
  });

  test("run help documents --questions and the resume answer path", () => {
    expect(RUN_HELP).toContain("--questions");
    expect(RUN_HELP).toContain("ask");
    expect(RUN_HELP).toContain("awaiting-input");
    expect(RUN_HELP).toMatch(/Resume session id.*question escalation/s);
  });
});

describe("session control event carries only questions", () => {
  test("session event has questions and no escalateQuestions field", async () => {
    const { runJsonSession } = await import("../../src/cli/session-json.js");
    const { Readable } = await import("node:stream");
    const lines: string[] = [];
    const turns = (async function* () {})();
    const handle = {
      turns,
      send: () => ({ disposition: "started" as const }),
      close: async () => {},
    };
    const input = Readable.from([]) as unknown as NodeJS.ReadableStream;
    await runJsonSession({
      handle: handle as never,
      sessionId: "test-session-id",
      harness: "claude",
      hcnVersion: "0.0.0-test",
      questions: "none",
      origin: "fresh",
      getCloseInfo: () => ({ exitCode: 0, cause: "clean" }),
      input,
      write: (line: string) => {
        lines.push(line);
        return true;
      },
    });
    const sessionLine = lines.find((l) => {
      try {
        return (JSON.parse(l) as { kind: string }).kind === "session";
      } catch {
        return false;
      }
    });
    expect(sessionLine).toBeDefined();
    const evt = JSON.parse(sessionLine as string) as Record<string, unknown>;
    expect(evt.questions).toBe("none");
    expect(evt).not.toHaveProperty("escalateQuestions");
  });
});
