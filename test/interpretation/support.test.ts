/**
 * Phase 3 (D7/D8): refusal diagnostics derived from descriptors.
 * - supportedBy derives from the descriptor set at runtime; the hardcoded
 *   autonomy array is gone
 * - refusals carry hint (stay-on-harness) and supportedBy as structured
 *   fields, hint rendered first
 * - native spellings passed before -- are recognized and redirected to the
 *   normalized flag
 */
import { describe, expect, it } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { recognizeNativeSpelling, supportedBy } from "../../src/interpretation/support.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("supportedBy derivation (D7)", () => {
  it("autonomy: three harnesses with their native spellings", () => {
    const by = supportedBy(defaultDescriptors(), "autonomy");
    expect(by).toEqual([
      { harness: "claude", spelling: "--dangerously-skip-permissions" },
      { harness: "codex", spelling: "--yolo" },
      { harness: "muse", spelling: "--yolo" },
    ]);
  });

  it("tools: claude and pi only", () => {
    const by = supportedBy(defaultDescriptors(), "tools");
    expect(by.map((e) => e.harness)).toEqual(["claude", "pi"]);
    expect(by.map((e) => e.spelling)).toEqual(["--allowedTools", "--tools"]);
  });

  it("sandbox: codex only", () => {
    expect(supportedBy(defaultDescriptors(), "sandbox").map((e) => e.harness)).toEqual(["codex"]);
  });

  it("write: muse only; provider: pi only", () => {
    expect(supportedBy(defaultDescriptors(), "write").map((e) => e.harness)).toEqual(["muse"]);
    expect(supportedBy(defaultDescriptors(), "provider").map((e) => e.harness)).toEqual(["pi"]);
  });
});

describe("refusals carry the structured fields (D8 order)", () => {
  it("no-autonomy on pi: derived support list, stay-on-harness hint", () => {
    try {
      buildLaunchArgv(piCli, { prompt: "hi", autonomy: true });
      expect.unreachable();
    } catch (e) {
      const r = e as ArgvRefusalError;
      expect(r).toBeInstanceOf(ArgvRefusalError);
      expect(r.issue).toBe("no-autonomy-mode");
      expect(r.supportedBy).toEqual([
        { harness: "claude", spelling: "--dangerously-skip-permissions" },
        { harness: "codex", spelling: "--yolo" },
        { harness: "muse", spelling: "--yolo" },
      ]);
      expect(r.hint).toMatch(/pi has no unattended-run flag/);
      // the hardcoded array is gone: supported comes from the derivation
      expect(r.supported).toContain("codex --yolo");
    }
  });

  it("tools on codex: support list plus a category-switch hint", () => {
    try {
      buildLaunchArgv(codexCli, { prompt: "hi", tools: ["read"] });
      expect.unreachable();
    } catch (e) {
      const r = e as ArgvRefusalError;
      expect(r.issue).toBe("unsupported-option");
      expect(r.option).toBe("tools");
      expect(r.supportedBy?.map((x) => x.harness)).toEqual(["claude", "pi"]);
      expect(r.hint).toMatch(/category switches via config keys/);
    }
  });

  it("tools on muse: support list plus a disable-flag hint", () => {
    try {
      buildLaunchArgv(defaultDescriptors().muse as never, { prompt: "hi", excludeTools: ["read"] });
      expect.unreachable();
    } catch (e) {
      const r = e as ArgvRefusalError;
      expect(r.supportedBy?.map((x) => x.harness)).toEqual(["claude", "pi"]);
      expect(r.hint).toMatch(/--disable-write/);
    }
  });
});

describe("native spelling recognition (D7 part B)", () => {
  it("claude's tool flag is recognized and maps to tools", () => {
    const r = recognizeNativeSpelling(defaultDescriptors(), "--allowedTools");
    expect(r?.option).toBe("tools");
    expect(r?.entries).toEqual([{ harness: "claude", spelling: "--allowedTools" }]);
  });

  it("pi's exclude flag maps to excludeTools", () => {
    const r = recognizeNativeSpelling(defaultDescriptors(), "--exclude-tools");
    expect(r?.option).toBe("excludeTools");
    expect(r?.entries.map((e) => e.harness)).toEqual(["pi"]);
  });

  it("unknown flags return null (keep plain error)", () => {
    expect(recognizeNativeSpelling(defaultDescriptors(), "--frobnicate")).toBeNull();
  });

  it("case-insensitive on claude's spelling", () => {
    const r = recognizeNativeSpelling(defaultDescriptors(), "--ALLOWEDTOOLS");
    expect(r?.option).toBe("tools");
  });

  it("claude effort flag recognized even though every harness has effort", () => {
    const r = recognizeNativeSpelling(defaultDescriptors(), "--effort");
    expect(r?.entries.map((e) => e.harness)).toContain("claude");
  });

  it("muse effort spelling recognized as muse's, not claude's", () => {
    const r = recognizeNativeSpelling(defaultDescriptors(), "--reasoning-effort");
    expect(r?.entries).toEqual([{ harness: "muse", spelling: "--reasoning-effort" }]);
  });
});
