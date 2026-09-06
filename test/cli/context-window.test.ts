import { describe, expect, test } from "vitest";
import { parseUserConfig } from "../../src/cli/config.js";
import type { PlanDeps } from "../../src/cli/plan-turn.js";
import { planTurn } from "../../src/cli/plan-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const deps: PlanDeps = {
  listKnownSkills: () => [],
  loadProjectConfig: () => null,
  loadUserConfig: () => ({ config: {} }),
  readPrompt: async () => ({ prompt: "hi", source: "positional" }),
  resolveSkillNames: () => [],
};

describe("context window", () => {
  test("invalid windows refuse before spawn with the supported range", async () => {
    for (const value of ["0", "-1", "1.5", "272001", "Infinity", "nope", ""]) {
      const outcome = await planTurn(
        codexCli,
        ["hi", `--context-window=${value}`],
        { command: "run" },
        deps,
      );
      expect(outcome).toMatchObject({
        kind: "refusal",
        refusal: {
          issue: "invalid-option-value",
          option: "contextWindow",
          supported: ["[1, 272000] integer"],
        },
      });
    }
  });
  test("other harnesses report profile divergence and refuse explicit windows naming Codex", async () => {
    for (const harness of [claudeCode, piCli, museCode]) {
      const bare = await planTurn(harness, ["hi"], { command: "run" }, deps);
      expect(bare.kind).toBe("plan");
      if (bare.kind === "plan") expect(bare.plan.unrenderable).toContain("contextWindow");
      const explicit = await planTurn(
        harness,
        ["hi", "--context-window", "100000"],
        { command: "run" },
        deps,
      );
      expect(explicit).toMatchObject({
        kind: "refusal",
        refusal: {
          issue: "unsupported-option",
          option: "contextWindow",
          supportedBy: [{ harness: "codex", spelling: "-c" }],
        },
      });
    }
  });
  test("config windows follow arg, project, user, then profile precedence", async () => {
    const user = parseUserConfig('{"version":1,"contextWindow":200000}');
    const project = parseUserConfig('{"version":1,"contextWindow":150000}');
    for (const [args, projectConfig, expected, tier] of [
      [[], null, 200000, "user-config"],
      [[], { config: project, path: "/project/.hcn/config.json" }, 150000, "project-config"],
      [
        ["--context-window", "100000"],
        { config: project, path: "/project/.hcn/config.json" },
        100000,
        "arg",
      ],
    ] as const) {
      const outcome = await planTurn(
        codexCli,
        ["hi", ...args],
        { command: "run" },
        {
          ...deps,
          loadProjectConfig: () => projectConfig,
          loadUserConfig: () => ({ config: user }),
        },
      );
      expect(outcome.kind).toBe("plan");
      if (outcome.kind !== "plan") continue;
      expect(outcome.plan.argv).toContain(`model_context_window=${expected}`);
      expect(outcome.plan.provenance).toContainEqual({
        key: "contextWindow",
        tier,
        value: expected,
      });
    }
  });
  test("an explicit window overrides the profile on launch and renders on resume", async () => {
    for (const resume of [[], ["--resume", "0199a4c5-1111-2222-3333-444455556666"]]) {
      const outcome = await planTurn(
        codexCli,
        ["hi", "--context-window", "100000", ...resume],
        { command: "run" },
        deps,
      );
      expect(outcome.kind).toBe("plan");
      if (outcome.kind !== "plan") continue;
      expect(
        outcome.plan.argv.filter((token) => token.startsWith("model_context_window=")),
      ).toEqual(["model_context_window=100000"]);
    }
  });
  test("a bare Codex launch sets a numeric 272k window and reports its profile source", async () => {
    const outcome = await planTurn(codexCli, ["hi"], { command: "run" }, deps);
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const argv = outcome.plan.argv;
    expect(argv.filter((token) => token.startsWith("model_context_window="))).toEqual([
      "model_context_window=272000",
    ]);
    expect(argv[argv.indexOf("model_context_window=272000") - 1]).toBe("-c");
    expect(outcome.plan.provenance).toContainEqual({
      key: "contextWindow",
      tier: "profile",
      value: 272000,
    });
  });
});
