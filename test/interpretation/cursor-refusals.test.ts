/**
 * RFC-05 Phase 4: cursor refusal pins at the argv seam. Tools selection
 * refuses (flags are null like codex/muse) with the cursor config-file
 * hint; session open refuses no-session-mode. Sandbox launch/resume refusal plus
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

  test("explicit sandbox still refuses, even though access read selects ask mode", () => {
    const err = refusalOf(() =>
      buildLaunchArgv(cursorCli, { prompt: "hi", sandbox: "workspace-write" }),
    );
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("sandbox");
    expect(err.supported).toEqual(["effort", "access"]);
  });
});
