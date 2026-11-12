/**
 * RFC-05 Phase 4: cursor refusal pins at the argv seam. Tools selection
 * refuses (flags are null like codex/muse) with the cursor access hint; the
 * SDK session builds the worker argv (#440) and the no-session-mode refusal
 * belongs to muse. Sandbox launch/resume refusal plus profile-tier divergence
 * live in plan-turn-cursor; passthrough placement (prompt-joins refusal
 * included) lives in argv-passthrough-placement.
 *
 * Review of #440: an SDK-backed session refuses every dimension it cannot
 * express - through the same shared validators a native session uses, before
 * the worker marker renders - so the refusal shape matches codex, the
 * harness with no session permission dimension at all.
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
  test("--tools refuses with the access hint, not the codex fallback", () => {
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

  test("session permission options refuse through the shared session refusal (#440 review)", () => {
    // Every dimension a native session renders through
    // renderSessionPermissions; cursor's SDK session has no such dimension,
    // so each refuses with the same shape codex refuses with (issue, option,
    // supported harnesses, detail) - before the worker marker can render.
    for (const [label, options] of [
      ["access", { access: "read" }],
      ["tools", { tools: ["read"] }],
      ["excludeTools", { excludeTools: ["shell"] }],
      ["autonomy", { autonomy: true }],
      ["discovery.tools", { discovery: { tools: false } }],
    ] as const) {
      const err = refusalOf(() =>
        buildSessionArgv(cursorCli, {
          sessionId: "agent-0199a4c5-1111-4222-8333-444455556666",
          ...options,
        }),
      );
      expect(err.issue, label).toBe("unsupported-option");
      expect(err.option, label).toBe(label);
      expect(err.supported, label).toEqual(["claude", "pi"]);
      expect(err.message, label).toContain("the session spawn carries no permission dimension");
    }
  });

  test("a session skills selection refuses through the shared skills owner (#440 review)", () => {
    const err = refusalOf(() =>
      buildSessionArgv(cursorCli, {
        sessionId: "agent-0199a4c5-1111-4222-8333-444455556666",
        skills: { picks: ["/root/wayfinder"], known: ["wayfinder"] },
      }),
    );
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("skills");
  });

  test("nativeApprovals refuses on the session with no declared channel (#440 review)", () => {
    const err = refusalOf(() =>
      buildSessionArgv(cursorCli, {
        sessionId: "agent-0199a4c5-1111-4222-8333-444455556666",
        nativeApprovals: true,
      }),
    );
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("nativeApprovals");
    expect(err.message).toContain("declares no session permission channel");
  });

  test("a session setting-source selection refuses through the shared validator (#457/#440)", () => {
    const err = refusalOf(() =>
      buildSessionArgv(cursorCli, {
        sessionId: "agent-0199a4c5-1111-4222-8333-444455556666",
        settingSources: ["user"],
      }),
    );
    expect(err.issue).toBe("unsupported-option");
    expect(err.option).toBe("settingSources");
  });
});
