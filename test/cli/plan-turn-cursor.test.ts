/**
 * RFC-05 Phase 3: the plan-turn effort resolve step. Whenever arg-tier
 * --effort is present on a cursor launch or resume, or a model from any
 * tier is present without effort, the model resolves through
 * resolveEffortSlug and opts.model is replaced with the slug before
 * buildSpawnArgv. A bare stem with no effort refuses unknown-model with
 * its row; a full slug with no effort passes through with argv and
 * provenance unchanged. On launch the supplying provenance entry is
 * rewritten to the slug (tier untouched), or an arg-tier model entry is
 * appended when none exists; on resume provenance stays absent.
 */
import { describe, expect, test } from "vitest";
import { type PlanDeps, planTurn } from "../../src/cli/plan-turn.js";
import { resolveEffectiveOptions } from "../../src/interpretation/resolve-options.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const deps: PlanDeps = {
  loadUserConfig: () => null,
  loadProjectConfig: () => null,
  listKnownSkills: () => [],
  resolveSkillNames: (names) => [...names],
  readPrompt: async (args) => ({
    prompt: args.promptFlag ?? args.positionalPrompt ?? "",
    source: args.promptFlag !== undefined ? "prompt-flag" : "positional",
  }),
};

describe("planTurn cursor effort resolve step", () => {
  test("launch: arg stem plus arg effort renders the resolved slug and appends an arg-tier model entry", async () => {
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--model", "gpt-5.2", "--effort", "high"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const modelAt = outcome.plan.argv.indexOf("--model");
    expect(modelAt).toBeGreaterThanOrEqual(0);
    expect(outcome.plan.argv[modelAt + 1]).toBe("gpt-5.2-high");
    expect(outcome.plan.provenance).toContainEqual({
      key: "model",
      value: "gpt-5.2-high",
      tier: "arg",
    });
  });

  test("launch: arg effort against a config-tier model rewrites that entry, tier untouched", async () => {
    const withModel: PlanDeps = {
      ...deps,
      loadUserConfig: () => ({ config: { model: "gpt-5.2" } }),
    };
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--effort", "high"],
      { command: "run" },
      withModel,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const modelAt = outcome.plan.argv.indexOf("--model");
    expect(outcome.plan.argv[modelAt + 1]).toBe("gpt-5.2-high");
    expect(outcome.plan.provenance).toContainEqual({
      key: "model",
      value: "gpt-5.2-high",
      tier: "user-config",
    });
  });

  test("resume: model plus effort resolves with no provenance", async () => {
    const outcome = await planTurn(
      cursorCli,
      [
        "--prompt",
        "hi",
        "--resume",
        "0199a4c5-1111-2222-3333-444455556666",
        "--model",
        "gpt-5.2",
        "--effort",
        "high",
      ],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const modelAt = outcome.plan.argv.indexOf("--model");
    expect(outcome.plan.argv[modelAt + 1]).toBe("gpt-5.2-high");
    expect(outcome.plan.provenance).toEqual([]);
  });

  test("resume: effort with no model refuses unknown-effort", async () => {
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--resume", "0199a4c5-1111-2222-3333-444455556666", "--effort", "high"],
      { command: "run" },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "refusal", refusal: { issue: "unknown-effort" } });
  });

  test("launch: a thinking stem plus effort resolves through its own row", async () => {
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--model", "claude-opus-4-8-thinking", "--effort", "low"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const modelAt = outcome.plan.argv.indexOf("--model");
    expect(outcome.plan.argv[modelAt + 1]).toBe("claude-opus-4-8-thinking-low");
  });

  test("launch: a bare stem with no effort refuses unknown-model with the stem row", async () => {
    // M2: without --effort the model must still run through the resolver
    // so the refusal names the stem's 5 row slugs, not all 223.
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--model", "claude-opus-4-8"],
      {
        command: "run",
      },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "refusal", refusal: { issue: "unknown-model" } });
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.supported).toEqual([
      "claude-opus-4-8-low",
      "claude-opus-4-8-medium",
      "claude-opus-4-8-high",
      "claude-opus-4-8-xhigh",
      "claude-opus-4-8-max",
    ]);
  });

  test("launch: a full slug with no effort leaves argv and provenance unchanged", async () => {
    // N5: the resolve step also runs when a model is present without
    // effort, but a slug that already pins effort passes through
    // untouched: no rewritten model, no appended provenance entry.
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--model", "claude-opus-4-8-high"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const modelAt = outcome.plan.argv.indexOf("--model");
    expect(modelAt).toBeGreaterThanOrEqual(0);
    expect(outcome.plan.argv[modelAt + 1]).toBe("claude-opus-4-8-high");
    expect(outcome.plan.provenance.some((p) => p.key === "model")).toBe(false);
  });

  test("launch: a variant slug plus conflicting effort refuses invalid-option-value", async () => {
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--model", "gpt-5.2-high", "--effort", "low"],
      { command: "run" },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "refusal", refusal: { issue: "invalid-option-value" } });
  });

  test("launch: arg effort against a config-tier bare-only model refuses unknown-effort", async () => {
    const withBareModel: PlanDeps = {
      ...deps,
      loadUserConfig: () => ({ config: { model: "auto" } }),
    };
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--effort", "high"],
      { command: "run" },
      withBareModel,
    );
    expect(outcome).toMatchObject({ kind: "refusal", refusal: { issue: "unknown-effort" } });
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.supported).toEqual([]);
  });

  test("explicit --sandbox refuses unsupported-option on launch and resume", async () => {
    const launch = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--sandbox", "read-only"],
      { command: "run" },
      deps,
    );
    expect(launch).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
    const resume = await planTurn(
      cursorCli,
      [
        "--prompt",
        "hi",
        "--resume",
        "0199a4c5-1111-2222-3333-444455556666",
        "--sandbox",
        "read-only",
      ],
      { command: "run" },
      deps,
    );
    expect(resume).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
  });

  test("profile-tier sandbox diverges instead of refusing", () => {
    const r = resolveEffectiveOptions(cursorCli, { prompt: "hi" }, {});
    expect(r.unrenderable).toContainEqual({ key: "sandbox", tier: "profile" });
    expect(r.options.sandbox).toBeUndefined();
  });

  test("config-tier access read refuses unsupported-option, never diverges to a wide run", async () => {
    // H1: a read-only project or user policy must refuse like an arg-tier
    // value, not drop to divergence while argv ends in --force.
    const withProjectAccess: PlanDeps = {
      ...deps,
      loadProjectConfig: () => ({ config: { access: "read" } }),
    };
    const project = await planTurn(
      cursorCli,
      ["--prompt", "hi"],
      { command: "run" },
      withProjectAccess,
    );
    expect(project).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
    const withUserAccess: PlanDeps = {
      ...deps,
      loadUserConfig: () => ({ config: { access: "read" } }),
    };
    const user = await planTurn(cursorCli, ["--prompt", "hi"], { command: "run" }, withUserAccess);
    expect(user).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
    const withProjectWrite: PlanDeps = {
      ...deps,
      loadProjectConfig: () => ({ config: { access: "write" } }),
    };
    const write = await planTurn(
      cursorCli,
      ["--prompt", "hi"],
      { command: "run" },
      withProjectWrite,
    );
    expect(write).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
  });

  test("explicit --access refuses unsupported-option on launch and resume", async () => {
    // Launch must refuse, not diverge: a restriction request must never
    // degrade to a full-default run. Resume refuses through the renderer.
    const launch = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--access", "read"],
      { command: "run" },
      deps,
    );
    expect(launch).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
    const resume = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--resume", "0199a4c5-1111-2222-3333-444455556666", "--access", "read"],
      { command: "run" },
      deps,
    );
    expect(resume).toMatchObject({ kind: "refusal", refusal: { issue: "unsupported-option" } });
  });
});
