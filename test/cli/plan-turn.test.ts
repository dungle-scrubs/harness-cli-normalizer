/**
 * RFC-02 change 10: planTurn owns the parse-refuse-resolve-build protocol.
 * The argv it returns is the argv the runner spawns, for every harness,
 * skill tokens and passthrough included, so the inspect preview and the
 * run spawn line agree by construction.
 */
import { describe, expect, test } from "vitest";
import { resumeIdOf } from "../../src/cli/args.js";
import { type PlanDeps, planTurn } from "../../src/cli/plan-turn.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const deps: PlanDeps = {
  loadUserConfig: () => ({ config: { effort: "high" } }),
  loadProjectConfig: () => null,
  listKnownSkills: () => ["hcn", "other"],
  resolveSkillNames: (names) => names.map((n) => `/registry/${n}`),
  readPrompt: async (args) => ({
    prompt: args.promptFlag ?? args.positionalPrompt ?? "",
    source: args.promptFlag !== undefined ? "prompt-flag" : "positional",
  }),
};

const spawnedArgv = async (
  h: typeof claudeCode,
  options: Parameters<typeof streamTurn>[1],
): Promise<readonly string[]> => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const turn = streamTurn(h, options, {
    spawn: spawner.spawn,
    clock: new FakeClock(),
    signal: fakeSignal().signal,
  });
  proc.exit(0);
  for await (const _event of turn) {
    // drain
  }
  return spawner.calls[0]?.argv ?? [];
};

describe("planTurn", () => {
  test.each([claudeCode, codexCli, piCli, museCode])(
    "$name: the plan's argv is the argv the runner spawns",
    async (h) => {
      const args = ["--prompt", "hi", "--questions", "none", "--", "--native-flag"];
      if (h.skills !== null) args.unshift("--skills", "hcn");
      const outcome = await planTurn(h, args, { command: "run" }, deps);
      expect(outcome.kind).toBe("plan");
      if (outcome.kind !== "plan") return;
      const spawned = await spawnedArgv(h, outcome.plan.options);
      expect(spawned).toEqual(outcome.plan.argv);
      expect(outcome.plan.argv.at(-1)).toBe("--native-flag");
      expect(
        outcome.plan.provenance.some((p) => p.key === "effort" && p.tier === "user-config"),
      ).toBe(true);
    },
  );

  test("a resume plan carries no launch provenance but still resolves behaviour", async () => {
    const outcome = await planTurn(
      claudeCode,
      ["--prompt", "hi", "--resume", "0199a4c5-1111-2222-3333-444455556666"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    expect(outcome.plan.provenance).toEqual([]);
    expect(outcome.plan.behavior.questions).toEqual({ value: "ask", tier: "default" });
    expect(outcome.plan.argv).toContain("--resume");
  });

  test("a refusal comes back structured, with the json decision made", async () => {
    const outcome = await planTurn(
      claudeCode,
      ["--json", "--prompt", "hi", "--model", "no-such-model"],
      { command: "run" },
      deps,
    );
    expect(outcome).toMatchObject({
      kind: "refusal",
      wantJson: true,
      refusal: { issue: "unknown-model" },
    });
  });

  test("the resume alias check exists once and refuses both spellings together", () => {
    expect(resumeIdOf({ resume: "a" })).toBe("a");
    expect(resumeIdOf({ "session-id": "b" })).toBe("b");
    expect(() => resumeIdOf({ resume: "a", "session-id": "b" })).toThrow(/not both/);
  });
});
