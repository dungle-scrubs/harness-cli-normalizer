/**
 * RFC-05 Phase 2: cursor effort renders in-model (zero tokens of its own).
 * turn-options.ts validates the effort WORD against the union ladder only;
 * family lookup lives in resolveEffortSlug, and the plan-turn resolve step
 * (Phase 3) owns slug replacement.
 */
import { describe, expect, test } from "vitest";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { renderTurnOptions } from "../../src/interpretation/turn-options.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

describe("renderTurnOptions effort-in-model (cursor)", () => {
  test("a known effort word emits zero tokens", () => {
    const rendered = renderTurnOptions(cursorCli, { prompt: "hi", effort: "high" }, "launch");
    expect(rendered.tokens).toEqual([]);
  });

  test("an unknown word refuses unknown-effort with the union ladder", () => {
    try {
      renderTurnOptions(cursorCli, { prompt: "hi", effort: "bogus" }, "launch");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgvRefusalError);
      expect((err as ArgvRefusalError).issue).toBe("unknown-effort");
      expect((err as ArgvRefusalError).supported).toContain("high");
      return;
    }
    throw new Error("expected unknown-effort refusal");
  });
});
