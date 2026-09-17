/**
 * RFC-05 Phase 2: resolveEffortSlug, the one owner of the cursor
 * effort-into-model rule. First match wins; model checks run before
 * effort checks. Refusals surface as structured ArgvRefusalErrors for
 * the plan-turn resolve step (Phase 3) to surface like any argv refusal.
 */
import { describe, expect, test } from "vitest";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { resolveEffortSlug } from "../../src/interpretation/vocabulary.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const slug = (model?: string, effort?: string): string | undefined =>
  resolveEffortSlug(cursorCli, model, effort);

const refusalOf = (model?: string, effort?: string): ArgvRefusalError => {
  try {
    slug(model, effort);
  } catch (err) {
    if (err instanceof ArgvRefusalError) return err;
    throw err;
  }
  throw new Error(`expected refusal for model=${model} effort=${effort}`);
};

describe("resolveEffortSlug", () => {
  test("a stem plus effort resolves through the row", () => {
    expect(slug("claude-opus-4-8", "high")).toBe("claude-opus-4-8-high");
  });

  test("a bare slug that is also a stem key resolves, not passes through", () => {
    expect(slug("gpt-5.2", "high")).toBe("gpt-5.2-high");
    expect(slug("gpt-5.2", "medium")).toBe("gpt-5.2");
  });

  test("an effort the stem lacks refuses unknown-effort with the stem ladder", () => {
    const err = refusalOf("kimi-k3", "medium");
    expect(err.issue).toBe("unknown-effort");
    expect(err.supported).toEqual(["low", "high", "max"]);
  });

  test("a variant slug passes through on the same effort, conflicts refuse", () => {
    expect(slug("gpt-5.2-high", "high")).toBe("gpt-5.2-high");
    const err = refusalOf("gpt-5.2-high", "low");
    expect(err.issue).toBe("invalid-option-value");
    expect(err.supported).toEqual(["high"]);
  });

  test("a -fast twin pins effort like a plain variant, no reattach", () => {
    expect(slug("gpt-5.2-high-fast", "high")).toBe("gpt-5.2-high-fast");
    const err = refusalOf("gpt-5.2-high-fast", "low");
    expect(err.issue).toBe("invalid-option-value");
    expect(err.supported).toEqual(["high"]);
  });

  test("a -fast slug of nothing resolvable refuses unknown-effort empty", () => {
    const err = refusalOf("composer-2.5-fast", "high");
    expect(err.issue).toBe("unknown-effort");
    expect(err.supported).toEqual([]);
  });

  test("a bare-only model takes no effort", () => {
    const err = refusalOf("auto", "high");
    expect(err.issue).toBe("unknown-effort");
    expect(err.supported).toEqual([]);
    expect(slug("auto", undefined)).toBe("auto");
  });

  test("effort with no model from any tier refuses unknown-effort", () => {
    const err = refusalOf(undefined, "high");
    expect(err.issue).toBe("unknown-effort");
    expect(slug(undefined, undefined)).toBeUndefined();
  });

  test("a bare stem with no effort is not a selection", () => {
    const err = refusalOf("claude-opus-4-8", undefined);
    expect(err.issue).toBe("unknown-model");
    expect(err.supported).toContain("claude-opus-4-8-high");
    expect(err.supported).toHaveLength(5);
  });

  test("model checks run before effort checks: a typo refuses unknown-model", () => {
    const err = refusalOf("claud-opus-4-8-high", "high");
    expect(err.issue).toBe("unknown-model");
  });

  test("a word outside the union ladder refuses with the union", () => {
    const err = refusalOf("gpt-5.2", "extra-high");
    expect(err.issue).toBe("unknown-effort");
    expect(err.supported).toEqual(["minimal", "none", "low", "medium", "high", "xhigh", "max"]);
  });

  test("thinking stems resolve through their own rows", () => {
    expect(slug("claude-opus-4-8-thinking", "low")).toBe("claude-opus-4-8-thinking-low");
    expect(slug("gpt-5.5", "xhigh")).toBe("gpt-5.5-extra-high");
  });
});
