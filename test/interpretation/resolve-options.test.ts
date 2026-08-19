/**
 * Phase 5: option resolution - the precedence chain and provenance.
 * args > user config > built-in profile; launch-only; skip-and-report for
 * unrenderable profile dimensions. Effort is the first ratified dimension.
 */
import { describe, expect, it } from "vitest";
import type { TurnOptions } from "../../src/interpretation/argv.js";
import { resolveEffectiveOptions } from "../../src/interpretation/resolve-options.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";
import { DEFAULT_TURN_PROFILE } from "../../src/knowledge/profile.js";

const base: TurnOptions = { prompt: "hi" };

describe("profile floor", () => {
  it("effort medium applied when nothing overrides", () => {
    const r = resolveEffectiveOptions(piCli, base, undefined);
    expect(r.options.effort).toBe("medium");
    expect(r.provenance).toContainEqual({ key: "effort", value: "medium", tier: "profile" });
    expect(r.unrenderable).toEqual([]);
  });

  it("all four harnesses express effort", () => {
    for (const h of [claudeCode, codexCli, piCli]) {
      const r = resolveEffectiveOptions(h, base, undefined);
      expect(r.options.effort).toBe("medium");
      expect(r.unrenderable).toEqual([]);
    }
  });
});

describe("precedence", () => {
  it("arg wins over config and profile", () => {
    const r = resolveEffectiveOptions(piCli, { ...base, effort: "max" }, { effort: "high" });
    expect(r.options.effort).toBe("max");
    expect(r.provenance).toContainEqual({ key: "effort", value: "max", tier: "arg" });
  });

  it("config wins over profile", () => {
    const r = resolveEffectiveOptions(piCli, base, { effort: "high" });
    expect(r.options.effort).toBe("high");
    expect(r.provenance).toContainEqual({ key: "effort", value: "high", tier: "user-config" });
  });

  it("config keys outside the profile pass through at their tier", () => {
    const r = resolveEffectiveOptions(piCli, base, { model: "zai/glm-5.2" });
    expect(r.options.model).toBe("zai/glm-5.2");
    expect(r.provenance).toContainEqual({
      key: "model",
      value: "zai/glm-5.2",
      tier: "user-config",
    });
  });

  it("arg also wins for non-profile keys", () => {
    const r = resolveEffectiveOptions(
      piCli,
      { ...base, model: "other/x" },
      { model: "zai/glm-5.2" },
    );
    expect(r.options.model).toBe("other/x");
    expect(r.provenance).toContainEqual({ key: "model", value: "other/x", tier: "arg" });
  });
});

describe("skip-and-report (unrenderable profile dimensions)", () => {
  it("a profile dimension the harness lacks is divergence, not refusal, not silence", () => {
    // Simulate a harness with no effort spec by shape: codex has effort, so
    // probe the mechanism through a descriptor clone lacking it.
    const noEffort = { ...piCli, turnOptions: { ...piCli.turnOptions } } as typeof piCli;
    delete (noEffort.turnOptions as Record<string, unknown>).effort;
    const r = resolveEffectiveOptions(noEffort, base, undefined);
    expect(r.options.effort).toBeUndefined();
    expect(r.unrenderable).toContain("effort");
    expect(r.provenance).toContainEqual({ key: "effort", value: "medium", tier: "harness" });
  });
});

describe("profile data", () => {
  it("contains only ratified dimensions", () => {
    expect(Object.keys(DEFAULT_TURN_PROFILE)).toEqual(["effort"]);
    expect(DEFAULT_TURN_PROFILE.effort).toBe("medium");
  });
});
