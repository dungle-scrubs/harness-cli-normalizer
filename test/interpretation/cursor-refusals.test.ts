/**
 * RFC-05 Phase 4: cursor refusal pins at the argv seam. Tools selection
 * refuses (flags are null like codex/muse) with the cursor config-file
 * hint; the SDK session builds the worker argv (#440) and the
 * no-session-mode refusal belongs to muse. Sandbox launch/resume refusal plus
 * profile-tier divergence live in plan-turn-cursor; passthrough placement
 * (prompt-joins refusal included) lives in argv-passthrough-placement.
 */
import { describe, expect, test } from "vitest";
import { buildLaunchArgv, buildSessionArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";

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
    expect(err.hint).toContain("--access read");
  });

  test("--exclude-tools refuses with the same hint", () => {
    const err = refusalOf(() =>
      buildLaunchArgv(cursorCli, { prompt: "hi", excludeTools: ["shell"] }),
    );
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("excludeTools");
    expect(err.hint).toContain("--access read");
  });

  test("session open builds the worker argv; the no-session-mode refusal moved to muse (cursor gained an SDK session, #440)", () => {
    const argv = buildSessionArgv(cursorCli, {
      sessionId: "agent-0199a4c5-1111-4222-8333-444455556666",
      isResume: true,
    });
    expect(argv).toEqual(["hcn-cursor-sdk-worker"]);
    const err = refusalOf(() =>
      buildSessionArgv(museCode, { sessionId: "0199a4c5-1111-2222-3333-444455556666" }),
    );
    expect(err.issue).toBe("no-session-mode");
    expect(err.harness).toBe("muse");
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
