/**
 * The memory dimension (ratified 2026-08-26): persistent cross-session
 * memory normalized OFF by the profile. claude renders a spawn env var
 * (live-verified 2.1.241: init memory_paths drops under the var), codex a
 * feature flag (live-verified 0.149.1 launch AND resume grammar), pi is
 * vacuously off (no built-in memory), muse cannot express it (refuses;
 * the documented exception).
 */
import { describe, expect, test } from "vitest";
import { buildLaunchArgv, buildResumeArgv, buildTurnEnv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import {
  resolveEffectiveOptions,
  resolveSessionMemory,
} from "../../src/interpretation/resolve-options.js";
import { supportedBy } from "../../src/interpretation/support.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";
import { piCli } from "../../src/knowledge/pi.js";

const claude = { ...claudeCode };
const codex = { ...codexCli };
const pi = { ...piCli };
const muse = { ...museCode };

describe("memory specs (descriptor facts)", () => {
  test("claude renders an env assignment, not argv tokens", () => {
    expect(claude.turnOptions.memory).toEqual({
      kind: "toggle",
      polarity: "disables",
      render: { kind: "env", name: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", value: "1" },
    });
  });

  test("codex renders the --disable memories flag pair", () => {
    expect(codex.turnOptions.memory).toEqual({
      kind: "toggle",
      polarity: "disables",
      render: { kind: "flag-list", flags: ["--disable", "memories"] },
    });
  });

  test("pi declares vacuous support with an empty flag list", () => {
    const mem = pi.turnOptions.memory as
      | {
          readonly kind: "toggle";
          readonly render: { readonly kind: string; readonly flags: readonly string[] };
        }
      | undefined;
    expect(mem?.render).toEqual({ kind: "flag-list", flags: [] });
  });

  test("muse declares no spec - the watched gap", () => {
    expect(muse.turnOptions.memory).toBeUndefined();
  });
});

describe("argv + env rendering", () => {
  test("claude memory:false leaves argv untouched and yields the env var", () => {
    const off = buildLaunchArgv(claude, { prompt: "hi", memory: false });
    const bare = buildLaunchArgv(claude, { prompt: "hi" });
    expect(off).toEqual(bare);
    expect(buildTurnEnv(claude, { memory: false }, "launch")).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });

  test("claude memory:true (opt back in) renders nothing", () => {
    const on = buildLaunchArgv(claude, { prompt: "hi", memory: true });
    const bare = buildLaunchArgv(claude, { prompt: "hi" });
    expect(on).toEqual(bare);
    expect(buildTurnEnv(claude, { memory: true }, "launch")).toEqual({});
  });

  test("codex memory:false adds --disable memories to the launch argv", () => {
    const argv = buildLaunchArgv(codex, { prompt: "hi", memory: false });
    const i = argv.indexOf("--disable");
    expect(i).toBeGreaterThan(0);
    expect(argv[i + 1]).toBe("memories");
    expect(buildTurnEnv(codex, { memory: false }, "launch")).toEqual({});
  });

  test("codex memory:false survives the resume grammar (live-verified 0.149.1)", () => {
    const id = "0b0b0b0b-1111-2222-3333-444444444444";
    const argv = buildResumeArgv(codex, { prompt: "hi", memory: false, sessionId: id });
    expect(argv).toContain("--disable");
    expect(argv[argv.indexOf("--disable") + 1]).toBe("memories");
  });

  test("codex memory:true renders nothing", () => {
    const on = buildLaunchArgv(codex, { prompt: "hi", memory: true });
    expect(on).not.toContain("--disable");
  });

  test("pi memory:false and memory:true both render nothing (vacuous)", () => {
    for (const memory of [false, true] as const) {
      expect(buildLaunchArgv(pi, { prompt: "hi", memory })).toEqual(
        buildLaunchArgv(pi, { prompt: "hi" }),
      );
      expect(buildTurnEnv(pi, { memory }, "launch")).toEqual({});
    }
  });

  test("muse memory:false refuses with hint and cross-harness support", () => {
    expect(() => buildLaunchArgv(muse, { prompt: "hi", memory: false })).toThrow(ArgvRefusalError);
    try {
      buildLaunchArgv(muse, { prompt: "hi", memory: false });
    } catch (e) {
      const err = e as ArgvRefusalError;
      expect(err.issue).toBe("unsupported-option");
      expect(err.option).toBe("memory");
      expect(err.hint).toContain("no CLI flag or config key");
      const spellings = err.supportedBy?.map((s) => s.harness);
      expect(spellings).toContain("claude");
      expect(spellings).toContain("codex");
    }
  });

  test("muse memory:true also refuses (absent-spec rule: any explicit value on an unexpressible dimension refuses, same as write/shell on claude)", () => {
    expect(() => buildLaunchArgv(muse, { prompt: "hi", memory: true })).toThrow(ArgvRefusalError);
  });
});

describe("profile default (memory off) through resolution", () => {
  test("claude bare run resolves memory:false from the profile", () => {
    const { options, provenance } = resolveEffectiveOptions(claude, { prompt: "hi" });
    expect(options.memory).toBe(false);
    expect(provenance).toContainEqual({
      key: "memory",
      value: false,
      tier: "profile",
    });
  });

  test("codex bare run resolves memory:false from the profile", () => {
    const { options } = resolveEffectiveOptions(codex, { prompt: "hi" });
    expect(options.memory).toBe(false);
  });

  test("pi bare run resolves memory:false (vacuously expressible)", () => {
    const { options, unrenderable } = resolveEffectiveOptions(pi, { prompt: "hi" });
    expect(options.memory).toBe(false);
    expect(unrenderable).not.toContain("memory");
  });

  test("muse bare run reports memory as divergence, never a refusal", () => {
    const { options, unrenderable, provenance } = resolveEffectiveOptions(muse, { prompt: "hi" });
    expect(options.memory).toBeUndefined();
    expect(unrenderable).toContain("memory");
    expect(provenance).toContainEqual({ key: "memory", value: false, tier: "harness" });
  });

  test("an explicit --memory arg opts back in over the profile", () => {
    const { options, provenance } = resolveEffectiveOptions(claude, {
      prompt: "hi",
      memory: true,
    });
    expect(options.memory).toBe(true);
    expect(provenance).toContainEqual({ key: "memory", value: true, tier: "arg" });
  });

  test("a user config memory:true overrides the profile", () => {
    const { options, provenance } = resolveEffectiveOptions(
      claude,
      { prompt: "hi" },
      { user: { memory: true } as never },
    );
    expect(options.memory).toBe(true);
    expect(provenance).toContainEqual({ key: "memory", value: true, tier: "user-config" });
  });
});

describe("support derivation", () => {
  test("claude spells the env assignment, codex the flag pair, pi the vacuous note", () => {
    const entries = supportedBy(defaultDescriptors(), "memory");
    const byName = Object.fromEntries(entries.map((e) => [e.harness, e.spelling]));
    expect(byName.claude).toBe("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
    expect(byName.codex).toBe("--disable memories");
    expect(byName.pi).toContain("no built-in memory");
    expect(byName.muse).toBeUndefined();
  });
});

describe("session memory precedence (resolveSessionMemory)", () => {
  test("arg beats both config tiers; project beats user; default is profile false", () => {
    expect(
      resolveSessionMemory(true, { user: { memory: false }, project: { memory: false } }),
    ).toEqual({
      memory: true,
      tier: "arg",
    });
    expect(
      resolveSessionMemory(undefined, { user: { memory: true }, project: { memory: false } }),
    ).toEqual({
      memory: false,
      tier: "project-config",
    });
    expect(resolveSessionMemory(undefined, { user: { memory: true } })).toEqual({
      memory: true,
      tier: "user-config",
    });
    expect(resolveSessionMemory(undefined, {})).toEqual({ memory: false, tier: "profile" });
  });
});
