/**
 * Phase 5: option resolution - the precedence chain and provenance.
 * args > user config > built-in profile; launch-only; skip-and-report for
 * unrenderable profile dimensions. Effort is the first ratified dimension.
 */
import { describe, expect, it } from "vitest";
import type { TurnOptions } from "../../src/interpretation/argv.js";
import {
  type ConfigTiers,
  FloorExceededError,
  resolveEffectiveOptions,
} from "../../src/interpretation/resolve-options.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { DEFAULT_TURN_PROFILE } from "../../src/knowledge/profile.js";

const base: TurnOptions = { prompt: "hi" };

describe("profile floor", () => {
  it("effort medium applied when nothing overrides", () => {
    const r = resolveEffectiveOptions(piCli, base, undefined);
    expect(r.options.effort).toBe("medium");
    expect(r.provenance).toContainEqual({ key: "effort", value: "medium", tier: "profile" });
    // pi's only divergence is sandbox (codex-only dimension)
    expect(r.unrenderable).toEqual(["sandbox"]);
    expect(r.options.write).toBeUndefined(); // emit-nothing ratification (D9)
    expect(r.options.shell).toBeUndefined(); // (D10)
  });

  it("all four harnesses express effort", () => {
    for (const h of [claudeCode, codexCli, piCli]) {
      const r = resolveEffectiveOptions(h, base, undefined);
      expect(r.options.effort).toBe("medium");
    }
  });

  it("sandbox applies on codex, diverges elsewhere", () => {
    const rc = resolveEffectiveOptions(codexCli, base, undefined);
    expect(rc.options.sandbox).toBe("workspace-write");
    // D13: codex has no list surface - tools diverges
    expect(rc.unrenderable).toEqual(["tools"]);
    const rp = resolveEffectiveOptions(piCli, base, undefined);
    expect(rp.options.sandbox).toBeUndefined();
    expect(rp.unrenderable).toContain("sandbox");
    expect(rp.provenance).toContainEqual({
      key: "sandbox",
      value: "workspace-write",
      tier: "harness",
    });
  });

  it("autonomy false emits nothing (off is omission), and the profile records it", () => {
    const r = resolveEffectiveOptions(piCli, base, undefined);
    expect(r.options.autonomy).toBeUndefined();
    expect(r.provenance).toContainEqual({ key: "autonomy", value: false, tier: "profile" });
    // emit-nothing is expressible everywhere: no divergence for autonomy-off
    expect(r.unrenderable).not.toContain("autonomy");
  });

  it("discovery on maps to full-discovery defaults - no disabling flags emitted", () => {
    const r = resolveEffectiveOptions(piCli, base, undefined);
    expect(r.options.discovery).toBeUndefined();
    expect(r.provenance).toContainEqual({
      key: "discovery",
      value: { tools: true, instructionFiles: true, extensions: true, skills: true },
      tier: "profile",
    });
  });
});

describe("precedence", () => {
  it("arg wins over config and profile", () => {
    const r = resolveEffectiveOptions(
      piCli,
      { ...base, effort: "max" },
      { user: { effort: "high" } },
    );
    expect(r.options.effort).toBe("max");
    expect(r.provenance).toContainEqual({ key: "effort", value: "max", tier: "arg" });
  });

  it("config wins over profile", () => {
    const r = resolveEffectiveOptions(piCli, base, { user: { effort: "high" } });
    expect(r.options.effort).toBe("high");
    expect(r.provenance).toContainEqual({ key: "effort", value: "high", tier: "user-config" });
  });

  it("config keys outside the profile pass through at their tier", () => {
    const r = resolveEffectiveOptions(piCli, base, { user: { model: "zai/glm-5.2" } });
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
      { user: { model: "zai/glm-5.2" } },
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
  it("contains exactly the four ratified dimensions", () => {
    expect(Object.keys(DEFAULT_TURN_PROFILE)).toEqual([
      "effort",
      "sandbox",
      "discovery",
      "autonomy",
      "write",
      "shell",
      "tools",
    ]);
    expect(DEFAULT_TURN_PROFILE.effort).toBe("medium");
    expect(DEFAULT_TURN_PROFILE.sandbox).toBe("workspace-write");
    expect(DEFAULT_TURN_PROFILE.autonomy).toBe(false);
  });
});

describe("project tier (Phase 6)", () => {
  it("project beats user, arg beats both", () => {
    const r = resolveEffectiveOptions(piCli, base, {
      user: { effort: "high" },
      project: { effort: "low" },
    });
    expect(r.options.effort).toBe("low");
    expect(r.provenance).toContainEqual({ key: "effort", value: "low", tier: "project-config" });

    const r2 = resolveEffectiveOptions(
      piCli,
      { ...base, effort: "max" },
      {
        user: { effort: "high" },
        project: { effort: "low" },
      },
    );
    expect(r2.options.effort).toBe("max");
    expect(r2.provenance).toContainEqual({ key: "effort", value: "max", tier: "arg" });
  });

  it("non-overlapping keys from both tiers coexist", () => {
    const r = resolveEffectiveOptions(piCli, base, {
      user: { effort: "high" },
      project: { tools: ["read"] },
    });
    expect(r.options.effort).toBe("high");
    expect(r.options.tools).toEqual(["read"]);
  });

  it("the all-off workflow: project floor [] grants nothing and refuses excess args", () => {
    const r = resolveEffectiveOptions(piCli, base, { project: { tools: [] } });
    expect(r.options.tools).toEqual([]);
    try {
      resolveEffectiveOptions(
        piCli,
        { ...base, tools: ["read", "shell"] },
        { project: { tools: [] } },
      );
      expect.unreachable();
    } catch (e) {
      const err = e as FloorExceededError;
      expect(err).toBeInstanceOf(FloorExceededError);
      expect(err.excess).toEqual(["read", "shell"]);
      expect(err.floor).toEqual([]);
    }
  });

  it("floor caps arg grants; within-floor grants pass", () => {
    const r = resolveEffectiveOptions(
      piCli,
      { ...base, tools: ["read"] },
      {
        project: { tools: ["read", "grep", "glob", "list"] },
      },
    );
    expect(r.options.tools).toEqual(["read"]);
    try {
      resolveEffectiveOptions(
        piCli,
        { ...base, tools: ["read", "shell"] },
        {
          project: { tools: ["read", "grep"] },
        },
      );
      expect.unreachable();
    } catch (e) {
      expect((e as FloorExceededError).excess).toEqual(["shell"]);
      expect((e as FloorExceededError).floor).toEqual(["read", "grep"]);
    }
  });
});

describe("named toolsets (D5)", () => {
  const tiersWithSets = {
    user: { toolsets: { review: ["read", "grep"], wide: ["read", "shell"] } },
    project: { tools: ["read", "grep", "glob", "list"], toolsets: { review: ["read"] } },
  } as never as ConfigTiers;

  it("a bare --tools name expands to the set, project winning name collisions", () => {
    const r = resolveEffectiveOptions(piCli, { ...base, tools: ["review"] }, tiersWithSets);
    expect(r.options.tools).toEqual(["read"]); // project's review, not user's
  });

  it("expanded sets face the floor like literal lists", () => {
    // user's "wide" = read,shell; floor lacks shell -> refuses naming shell
    try {
      resolveEffectiveOptions(piCli, { ...base, tools: ["wide"] }, tiersWithSets);
      expect.unreachable();
    } catch (e) {
      expect((e as FloorExceededError).excess).toEqual(["shell"]);
    }
  });

  it("expansion recorded in provenance as the expanded list at arg tier", () => {
    const r = resolveEffectiveOptions(piCli, { ...base, tools: ["review"] }, tiersWithSets);
    expect(r.provenance).toContainEqual({ key: "tools", value: ["read"], tier: "arg" });
  });
});

describe("round 2 ratifications (D9-D12)", () => {
  it("write and shell true are emit-nothing everywhere - no divergence, no flags", () => {
    for (const h of [claudeCode, codexCli, piCli]) {
      const r = resolveEffectiveOptions(h, base, undefined);
      expect(r.options.write).toBeUndefined();
      expect(r.options.shell).toBeUndefined();
      expect(r.unrenderable).not.toContain("write");
      expect(r.unrenderable).not.toContain("shell");
      expect(r.provenance).toContainEqual({ key: "write", value: true, tier: "profile" });
      expect(r.provenance).toContainEqual({ key: "shell", value: true, tier: "profile" });
    }
  });

  it("profile carries no timeout and no maxSteps entry (opt-in only)", () => {
    expect("timeout" in DEFAULT_TURN_PROFILE).toBe(false);
    expect("maxSteps" in DEFAULT_TURN_PROFILE).toBe(false);
  });
});

describe("D13: tools all-known marker", () => {
  it("pi expands to the enabling include (dormant trio on)", () => {
    const r = resolveEffectiveOptions(piCli, base, undefined);
    expect(r.options.tools).toEqual(["read", "shell", "edit", "write", "grep", "glob", "list"]);
    expect(r.provenance).toContainEqual({
      key: "tools",
      value: ["read", "shell", "edit", "write", "grep", "glob", "list"],
      tier: "profile",
    });
  });

  it("claude is already-everything: emit nothing, record in provenance", () => {
    const r = resolveEffectiveOptions(claudeCode, base, undefined);
    expect(r.options.tools).toBeUndefined();
    expect(r.provenance).toContainEqual({
      key: "tools",
      value: "all known (already default)",
      tier: "profile",
    });
  });

  it("codex and muse report divergence (no list surface)", () => {
    const rc = resolveEffectiveOptions(codexCli, base, undefined);
    expect(rc.unrenderable).toContain("tools");
    const rm = resolveEffectiveOptions(museCode, base, undefined);
    expect(rm.unrenderable).toContain("tools");
  });

  it("project floor narrows the profile entry (precedence chain)", () => {
    const r = resolveEffectiveOptions(piCli, base, { project: { tools: ["read", "grep"] } });
    expect(r.options.tools).toEqual(["read", "grep"]);
    expect(r.provenance).toContainEqual({
      key: "tools",
      value: ["read", "grep"],
      tier: "project-config",
    });
  });
});

describe("discovery.tools off suppresses all-known expansion", () => {
  it("arg discovery.tools false skips profile tools and records provenance", () => {
    const r = resolveEffectiveOptions(piCli, { ...base, discovery: { tools: false } }, undefined);
    expect(r.options.tools).toBeUndefined();
    expect(r.provenance).toContainEqual({
      key: "tools",
      value: "none (discovery.tools off)",
      tier: "arg",
    });
  });

  it("project discovery.tools false skips profile tools with project-config tier", () => {
    const r = resolveEffectiveOptions(piCli, base, {
      project: { discovery: { tools: false } } as unknown as TurnOptions,
    });
    expect(r.options.tools).toBeUndefined();
    expect(r.provenance).toContainEqual({
      key: "tools",
      value: "none (discovery.tools off)",
      tier: "project-config",
    });
  });

  it("explicit tools from arg is not suppressed when discovery off", () => {
    const r = resolveEffectiveOptions(
      piCli,
      { ...base, discovery: { tools: false }, tools: ["read"] },
      undefined,
    );
    expect(r.options.tools).toEqual(["read"]);
  });
});
