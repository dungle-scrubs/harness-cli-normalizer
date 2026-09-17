/**
 * RFC-05 Phase 4: cursor refusal pins at the argv seam. Tools selection
 * refuses (flags are null like codex/muse) with the cursor config-file
 * hint; session open refuses no-session-mode; explicit access values
 * refuse unsupported-option. Sandbox launch/resume refusal plus
 * profile-tier divergence live in plan-turn-cursor; passthrough placement
 * (prompt-joins refusal included) lives in argv-passthrough-placement.
 */
import { describe, expect, test } from "vitest";
import { buildLaunchArgv, buildSessionArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const refusalOf = (work: () => unknown): ArgvRefusalError => {
  try {
    work();
  } catch (err) {
    if (err instanceof ArgvRefusalError) return err;
    throw err;
  }
  throw new Error("expected an ArgvRefusalError");
};

describe("cursor refusals", () => {
  test("--tools refuses with the config-file hint, not the codex fallback", () => {
    const err = refusalOf(() => buildLaunchArgv(cursorCli, { prompt: "hi", tools: ["read"] }));
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("tools");
    expect(err.hint).toContain("config-file allow and deny lists");
  });

  test("--exclude-tools refuses with the same hint", () => {
    const err = refusalOf(() =>
      buildLaunchArgv(cursorCli, { prompt: "hi", excludeTools: ["shell"] }),
    );
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("excludeTools");
    expect(err.hint).toContain("config-file allow and deny lists");
  });

  test("session open refuses no-session-mode", () => {
    const err = refusalOf(() =>
      buildSessionArgv(cursorCli, { sessionId: "0199a4c5-1111-2222-3333-444455556666" }),
    );
    expect(err.issue).toBe("no-session-mode");
    expect(err.harness).toBe("cursor");
  });

  test("--access read refuses unsupported-option naming the expressible options", () => {
    // The house convention lists the harness's other expressible options
    // in supported (claude lists seven, cursor lists its one: effort).
    // The RFC Sandbox section says "empty supported"; the code follows
    // the convention instead. Recorded as an RFC difference, not changed.
    const err = refusalOf(() => buildLaunchArgv(cursorCli, { prompt: "hi", access: "read" }));
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("access");
    expect(err.supported).toEqual(["effort"]);
  });
});
