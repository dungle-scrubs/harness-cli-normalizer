import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";

/**
 * Gate 2->3 guard: every dimension of the PLAN.md 3.1 table has an owner on
 * the descriptor, and no dimension can be added or dropped unnoticed - the
 * key set is asserted exactly, so a descriptor change must update this map
 * of table dimension -> owning key.
 */
const DIMENSION_TO_KEY = {
  sessionId: "identity",
  resume: "resume",
  resumeLast: "resumeLast",
  provider: "turnOptions",
  effort: "turnOptions",
  model: "vocabulary",
  autonomy: "autonomy",
  tools: "tools",
  output: "output",
  sessionMode: "sessionMode",
  storePath: "store",
  presence: "presence",
  parseResume: "resume",
  argvOrder: "launch",
  limitMatchers: "limitMatchers",
  stdin: "stdin",
  contextHook: "contextHook",
  capabilities: "capabilities",
  discoveryFlags: "turnOptions",
  authWalls: "authMatchers",
} as const;

describe("descriptor dimension coverage (PLAN.md 3.1)", () => {
  test("the descriptor's key set is exactly the owners of the table dimensions", () => {
    const owningKeys = new Set<string>(Object.values(DIMENSION_TO_KEY));
    const metaKeys = new Set(["name", "bin", "verifiedAgainst", "versionSource"]);
    const actual = Object.keys(claudeCode)
      .filter((k) => !metaKeys.has(k))
      .sort();
    expect(actual).toEqual([...owningKeys].sort());
  });
});
