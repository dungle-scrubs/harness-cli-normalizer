import { describe, expect, test } from "vitest";
import type { ExtensionProbeFn } from "../../src/cli/extension-gate.js";
import { gateExtensionOptions } from "../../src/cli/extension-gate.js";
import type { ExtensionProbeOutcome } from "../../src/execution/extension-probe.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";

/**
 * Map #300, ticket #307: the pre-spawn gate. Set option + declared probe ->
 * verify; absent extension or dead probe -> the exit-2
 * `extension-option-unavailable` refusal naming the extension and the
 * passthrough alternative; option unset or spec without a probe -> the
 * gate never fires (bare runs never spawn a probe).
 */

const outcome = (over: Partial<ExtensionProbeOutcome>): ExtensionProbeOutcome => ({
  ok: true,
  reason: "flag-present",
  providedBy: "subagent extension",
  probeShape: "pi --help",
  ...over,
});

const countingProbe = (
  result: ExtensionProbeOutcome,
): { fn: ExtensionProbeFn; callsOf: () => number } => {
  let calls = 0;
  const fn: ExtensionProbeFn = async () => {
    calls += 1;
    return result;
  };
  return { fn, callsOf: () => calls };
};

describe("gateExtensionOptions", () => {
  test("verified pass returns the record for the provenance line", async () => {
    const probe = countingProbe(outcome({}));
    const verified = await gateExtensionOptions(piCli, { agent: "dev-agent" }, {}, probe.fn);
    expect(probe.callsOf()).toBe(1);
    expect(verified).toEqual([
      { option: "agent", value: "dev-agent", providedBy: "subagent extension" },
    ]);
  });

  test("absent extension refuses with the new issue, naming it and the alternative", async () => {
    const probe = countingProbe(outcome({ ok: false, reason: "flag-absent", exitCode: 0 }));
    try {
      await gateExtensionOptions(piCli, { agent: "dev-agent" }, {}, probe.fn);
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ArgvRefusalError);
      const err = e as ArgvRefusalError;
      expect(err.issue).toBe("extension-option-unavailable");
      expect(err.harness).toBe("pi");
      expect(err.option).toBe("agent");
      expect(err.message).toContain("subagent extension absent");
      expect(err.supported?.[0]).toBe("install the subagent extension");
      expect(err.supported?.[1]).toContain("natively after --");
    }
  });

  test("a dead probe distinguishes itself in the detail (timeout)", async () => {
    const probe = countingProbe(outcome({ ok: false, reason: "timeout" }));
    await expect(gateExtensionOptions(piCli, { agent: "x" }, {}, probe.fn)).rejects.toThrow(
      /timed out/,
    );
  });

  test("option unset: the gate never probes (bare runs pay nothing)", async () => {
    const probe = countingProbe(outcome({}));
    const verified = await gateExtensionOptions(piCli, {}, {}, probe.fn);
    expect(probe.callsOf()).toBe(0);
    expect(verified).toEqual([]);
  });

  test("spec without a probe: never gated, even with the option set", async () => {
    const probe = countingProbe(outcome({}));
    // antigravity has an agent spec with no probe; codex has no agent spec.
    for (const h of [antigravityCli, codexCli]) {
      const verified = await gateExtensionOptions(h, { agent: "x" }, {}, probe.fn);
      expect(verified).toEqual([]);
    }
    expect(probe.callsOf()).toBe(0);
  });
});
