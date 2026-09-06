/**
 * RFC-02 change 3: the access preset is one spec kind on every descriptor,
 * phase-aware, with a `claims` field that makes the sandbox exclusivity
 * descriptor data instead of a harness-name branch. Includes fix R2: on
 * codex, access on a resumed turn renders through the sandbox_mode config
 * spelling that `codex exec resume` accepts.
 */
import { describe, expect, test } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { resolveEffectiveOptions } from "../../src/interpretation/resolve-options.js";
import { supportedBy } from "../../src/interpretation/support.js";
import * as toolSelection from "../../src/interpretation/tool-selection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import * as descriptor from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("one access spec", () => {
  test("every harness that expresses access declares the one kind", () => {
    for (const h of [claudeCode, codexCli, piCli, museCode]) {
      expect(h.turnOptions.access?.kind).toBe("access");
    }
    expect(claudeCode.turnOptions.access).toMatchObject({
      renders: { read: "tool-preset", write: null },
    });
    expect(piCli.turnOptions.access).toMatchObject({
      renders: { read: "tool-preset", write: null },
    });
    expect(museCode.turnOptions.access).toMatchObject({ renders: { write: null } });
  });

  test("codex's access claims the sandbox turn option as data", () => {
    const spec = codexCli.turnOptions.access;
    expect(spec?.kind === "access" ? spec.claims : undefined).toBe("sandbox");
    for (const h of [claudeCode, piCli, museCode]) {
      const s = h.turnOptions.access;
      expect(s?.kind === "access" ? s.claims : "absent").toBeUndefined();
    }
  });

  test("codex access on launch keeps the flag spelling, exactly once", () => {
    const launch = buildLaunchArgv(codexCli, { prompt: "hi", access: "read" });
    expect(launch.filter((t) => t === "--sandbox")).toHaveLength(1);
    expect(launch).toContain("read-only");
  });

  test("the claimed option refuses an explicit value alongside access, by data", () => {
    expect(() =>
      resolveEffectiveOptions(codexCli, { prompt: "hi", access: "read", sandbox: "read-only" }),
    ).toThrow(ArgvRefusalError);
    // A harness whose access claims nothing has no such rule to apply.
    const r = resolveEffectiveOptions(museCode, { prompt: "hi", access: "read" });
    expect(r.options.access).toBe("read");
  });

  test("support spellings for access are unchanged", () => {
    expect(supportedBy(defaultDescriptors(), "access")).toEqual([
      { harness: "claude", spelling: "--allowedTools" },
      { harness: "codex", spelling: "--sandbox" },
      { harness: "pi", spelling: "--tools" },
      { harness: "muse", spelling: "--disable-write" },
    ]);
  });

  test("the second renderer and the two uncalled render helpers are gone", () => {
    expect("renderAccessPreset" in toolSelection).toBe(false);
    expect("getOptionRender" in descriptor).toBe(false);
    expect("resolveResumeRender" in descriptor).toBe(false);
  });
});
