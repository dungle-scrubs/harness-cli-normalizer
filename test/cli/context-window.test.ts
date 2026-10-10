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
  test("native auto-compaction spelling redirects to the usable normalized flag", async () => {
    const outcome = await planTurn(
      claudeCode,
      ["hi", "--autocompact", "150000"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.message).toContain("--context-window");
    expect(outcome.refusal.message).not.toContain("--contextWindow");
  });

  test("Claude rejects sub-minimum windows from either config tier", async () => {
    const config = parseUserConfig('{"version":1,"contextWindow":99999}');
    for (const tier of ["user", "project"] as const) {
      const outcome = await planTurn(
        claudeCode,
        ["hi"],
        { command: "run" },
        {
          ...deps,
          loadUserConfig: () => ({ config: tier === "user" ? config : {} }),
          loadProjectConfig: () =>
            tier === "project" ? { config, path: "/project/.hcn/config.json" } : null,
        },
      );
      expect(outcome).toMatchObject({
        kind: "refusal",
        refusal: {
          issue: "invalid-option-value",
          option: "contextWindow",
          supported: ["[100000, 1000000] integer"],
        },
      });
    }
  });

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
  test("other harnesses report profile divergence and refuse explicit windows naming the supporters", async () => {
    for (const harness of [piCli, museCode]) {
      const bare = await planTurn(harness, ["hi"], { command: "run" }, deps);
      expect(bare.kind).toBe("plan");
      if (bare.kind === "plan")
        expect(bare.plan.unrenderable).toContainEqual({ key: "contextWindow", tier: "profile" });
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
          supportedBy: [
            { harness: "claude", spelling: "--autocompact" },
            { harness: "codex", spelling: "-c" },
            { harness: "popeye", spelling: "--context-window" },
          ],
        },
      });
    }
  });
  test("claude renders native --autocompact on launch and resume, never from the profile", async () => {
    for (const resume of [[], ["--resume", "0199a4c5-1111-2222-3333-444455556666"]]) {
      const outcome = await planTurn(
        claudeCode,
        ["hi", "--context-window", "150000", ...resume],
        { command: "run" },
        deps,
      );
      expect(outcome.kind).toBe("plan");
      if (outcome.kind !== "plan") continue;
      expect(outcome.plan.argv).toContain("--autocompact");
      expect(outcome.plan.argv[outcome.plan.argv.indexOf("--autocompact") + 1]).toBe("150000");
    }
    const bare = await planTurn(claudeCode, ["hi"], { command: "run" }, deps);
    expect(bare.kind).toBe("plan");
    if (bare.kind === "plan") {
      expect(bare.plan.argv).not.toContain("--autocompact");
      expect(bare.plan.unrenderable).not.toContainEqual({ key: "contextWindow", tier: "profile" });
      expect(bare.plan.provenance).toContainEqual({
        key: "contextWindow",
        value: "none (native auto-compaction threshold keeps its harness default)",
        tier: "harness",
      });
    }
  });
  test("claude windows refuse outside 100000-1000000 with the supported range", async () => {
    for (const value of ["99999", "1000001", "1.5", "Infinity", "nope", ""]) {
      const outcome = await planTurn(
        claudeCode,
        ["hi", `--context-window=${value}`],
        { command: "run" },
        deps,
      );
      expect(outcome).toMatchObject({
        kind: "refusal",
        refusal: {
          issue: "invalid-option-value",
          option: "contextWindow",
          supported: ["[100000, 1000000] integer"],
        },
      });
    }
  });
  test("claude honors arg, project, user precedence for the compaction threshold", async () => {
    const user = parseUserConfig('{"version":1,"contextWindow":400000}');
    const project = parseUserConfig('{"version":1,"contextWindow":300000}');
    for (const [args, projectConfig, expected, tier] of [
      [[], null, 400000, "user-config"],
      [[], { config: project, path: "/project/.hcn/config.json" }, 300000, "project-config"],
      [
        ["--context-window", "150000"],
        { config: project, path: "/project/.hcn/config.json" },
        150000,
        "arg",
      ],
    ] as const) {
      const outcome = await planTurn(
        claudeCode,
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
      const at = outcome.plan.argv.indexOf("--autocompact");
      expect(at).toBeGreaterThan(-1);
      expect(outcome.plan.argv[at + 1]).toBe(String(expected));
      expect(outcome.plan.provenance).toContainEqual({
        key: "contextWindow",
        tier,
        value: expected,
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
