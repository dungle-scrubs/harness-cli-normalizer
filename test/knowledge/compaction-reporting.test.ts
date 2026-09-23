import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { contentEventsOf } from "../../src/interpretation/content.js";
import { resolveEffectiveOptions } from "../../src/interpretation/resolve-options.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

/**
 * ADR 0009 / #243. `compactionReporting` exists so silence is never read
 * as "no compaction happened". Codex and cursor both compact and both say
 * nothing hcn can read; a caller has to be able to tell that apart from a
 * quiet run on a harness that does report.
 */

const ALL: readonly HarnessDescriptor[] = [
  claudeCode,
  codexCli,
  piCli,
  museCode,
  cursorCli,
  antigravityCli,
];

describe("compactionReporting", () => {
  test("every harness states its reporting, or null where nothing carries it", () => {
    const byName = Object.fromEntries(ALL.map((h) => [h.name, h.compactionReporting]));
    expect(byName).toEqual({
      claude: { source: "stream", states: ["started", "compacted", "failed"], tokens: true },
      pi: {
        source: "stream",
        states: ["started", "compacted", "failed", "aborted"],
        tokens: true,
      },
      antigravity: { source: "stream", states: ["compacted"], tokens: false },
      muse: {
        source: "view",
        states: ["compacted", "noop", "failed", "aborted"],
        tokens: true,
      },
      // Both compact natively. Neither reports it on a channel hcn reads.
      codex: null,
      cursor: null,
    });
  });

  test("a harness that declares reporting also declares that it compacts", () => {
    // The reverse does not hold: codex and cursor compact and report
    // nothing, which is the whole reason this field is separate from
    // nativeContextManagement.
    for (const h of ALL) {
      if (h.compactionReporting !== null) expect(h.nativeContextManagement).not.toBeNull();
    }
    expect(codexCli.nativeContextManagement).not.toBeNull();
    expect(cursorCli.nativeContextManagement).not.toBeNull();
  });

  test("the declared states are the states that harness's decoder can actually produce", () => {
    // A declared state the decoder never emits would be a promise the
    // stream does not keep. These are the records each probe captured.
    const stateOf = (name: Parameters<typeof contentEventsOf>[0], record: unknown): string[] =>
      contentEventsOf(name, record)
        .filter((e) => e.kind === "compaction")
        .map((e) => (e.kind === "compaction" ? e.state : ""));

    expect(stateOf("claude", { type: "system", subtype: "status", status: "compacting" })).toEqual([
      "started",
    ]);
    expect(stateOf("claude", { type: "system", subtype: "compact_boundary" })).toEqual([
      "compacted",
    ]);
    expect(stateOf("pi", { type: "compaction_start", reason: "threshold" })).toEqual(["started"]);
    expect(stateOf("pi", { type: "compaction_end", reason: "threshold", aborted: true })).toEqual([
      "aborted",
    ]);
    expect(
      stateOf("antigravity", {
        event: "step_update",
        step_update: { step_type: "checkpoint", state: "DONE" },
      }),
    ).toEqual(["compacted"]);
    // Antigravity declares no token support, and its record carries none.
    expect(antigravityCli.compactionReporting?.tokens).toBe(false);
  });

  test("the reporting fact rides the identity capabilities for every harness", () => {
    for (const h of ALL) {
      expect(capabilitiesOf(h, "", "headless-turn").compactionReporting).toEqual(
        h.compactionReporting,
      );
    }
  });

  test("a silent harness writes no per-run divergence line for compaction", () => {
    // A `divergence:` line names a key the CALLER asked for and the
    // harness could not render. Nobody asks for compaction reporting, so
    // a line here would print on every codex and cursor run - including
    // every run where nothing compacted at all. Pinned at the source: the
    // option resolver never produces an unrenderable entry for it.
    for (const h of [codexCli, cursorCli]) {
      const resolved = resolveEffectiveOptions(h, { prompt: "hi" }, {});
      const keys = resolved.unrenderable.map((entry) => entry.key);
      expect(keys.some((key) => /compact/i.test(key))).toBe(false);
    }
    // And the writer itself has no compaction arm to reach: a divergence
    // line can only name an unrenderable option key.
    const source = readFileSync(new URL("../../src/cli/provenance.ts", import.meta.url), "utf8");
    expect(/compact/i.test(source)).toBe(false);
  });
});
