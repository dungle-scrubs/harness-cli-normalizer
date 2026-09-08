import { describe, expect, test } from "vitest";
import { validateEffort, validateModel } from "../../src/interpretation/vocabulary.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";

describe("Codex Astra vocabulary", () => {
  test("accepts Astra with its documented effort ladder", () => {
    expect(validateModel(codexCli, "gpt-6-astra")).toEqual({ ok: true, id: "gpt-6-astra" });
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(validateEffort(codexCli, effort, "gpt-6-astra")).toEqual({ ok: true, id: effort });
    }
    expect(validateEffort(codexCli, "minimal", "gpt-6-astra").ok).toBe(false);
    expect(validateEffort(codexCli, "ultra", "gpt-6-astra").ok).toBe(false);
  });
});

describe("validateModel / validateEffort (claude)", () => {
  test("accepts full ids and resolves aliases to the harness's own spelling", () => {
    expect(validateModel(claudeCode, "claude-opus-5")).toEqual({ ok: true, id: "claude-opus-5" });
    expect(validateModel(claudeCode, "opus")).toEqual({ ok: true, id: "claude-opus-5" });
    expect(validateModel(claudeCode, "fable")).toEqual({ ok: true, id: "claude-fable-5-1" });
    expect(validateModel(claudeCode, "claude-fable-5")).toEqual({ ok: true, id: "claude-fable-5" });
  });

  test("rejects unknown model spellings with the vocabulary in the message", () => {
    const result = validateModel(claudeCode, "gpt-5.6-sol");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/opus/);
  });

  test("validates effort against the claude ladder", () => {
    expect(validateEffort(claudeCode, "high")).toEqual({ ok: true, id: "high" });
    expect(validateEffort(claudeCode, "turbo").ok).toBe(false);
  });
});
