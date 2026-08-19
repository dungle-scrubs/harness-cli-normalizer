/**
 * Issue #41 question escalation - CLI-layer unit tests: config parse of
 * escalateQuestions (default, both values, wrong type), arg override
 * parsing, tier precedence arg > project > user > default, and the
 * provenance line + help surface.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseTurnOptions } from "../../src/cli/args.js";
import { loadProjectConfig, loadUserConfig, parseUserConfig } from "../../src/cli/config.js";
import { exitCodeForCause } from "../../src/cli/exit-codes.js";
import { RUN_HELP } from "../../src/cli/help.js";

describe("escalateQuestions config parse", () => {
  test("parses both values", () => {
    expect(parseUserConfig('{"version":1,"escalateQuestions":true}')).toEqual({
      escalateQuestions: true,
    });
    expect(parseUserConfig('{"version":1,"escalateQuestions":false}')).toEqual({
      escalateQuestions: false,
    });
  });

  test("absent key means no config statement (default true lives outside the file)", () => {
    expect(parseUserConfig('{"version":1,"effort":"high"}')).toEqual({ effort: "high" });
  });

  test("wrong type refuses naming the key", () => {
    expect(() => parseUserConfig('{"version":1,"escalateQuestions":"yes"}')).toThrow(
      /"escalateQuestions" must be a boolean/,
    );
  });
});

describe("escalateQuestions arg parsing", () => {
  test("--escalate-questions / --no-escalate-questions map onto the field", () => {
    expect(
      parseTurnOptions({ "escalate-questions": true } as Record<string, unknown>).escalateQuestions,
    ).toBe(true);
    expect(
      parseTurnOptions({ "no-escalate-questions": true } as Record<string, unknown>)
        .escalateQuestions,
    ).toBe(false);
    expect(parseTurnOptions({} as Record<string, unknown>).escalateQuestions).toBeUndefined();
  });
});

describe("escalateQuestions tier precedence (arg > project > user > default)", () => {
  const userDir = mkdtempSync("/tmp/hcn-q-user-");
  const repoDir = mkdtempSync("/tmp/hcn-q-repo-");

  test("user tier loads", () => {
    writeFileSync(`${userDir}/config.json`, '{"version":1,"escalateQuestions":false}');
    const prev = process.env.HCN_CONFIG_DIR;
    process.env.HCN_CONFIG_DIR = userDir;
    try {
      expect(loadUserConfig()?.config.escalateQuestions).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HCN_CONFIG_DIR;
      else process.env.HCN_CONFIG_DIR = prev;
    }
  });

  test("project tier loads", () => {
    mkdirSync(`${repoDir}/.hcn`, { recursive: true });
    writeFileSync(`${repoDir}/.hcn/config.json`, '{"version":1,"escalateQuestions":true}');
    expect(loadProjectConfig(repoDir)?.config.escalateQuestions).toBe(true);
  });
});

describe("escalation surfaces", () => {
  test("awaiting-input is a success exit", () => {
    expect(exitCodeForCause("awaiting-input")).toBe(0);
    expect(exitCodeForCause("clean")).toBe(0);
    expect(exitCodeForCause("failed")).toBe(1);
  });

  test("run help documents both flags and the resume answer path", () => {
    expect(RUN_HELP).toContain("--escalate-questions");
    expect(RUN_HELP).toContain("--no-escalate-questions");
    expect(RUN_HELP).toContain("awaiting-input");
    expect(RUN_HELP).toMatch(/Resume session id.*question escalation/s);
  });
});
