/**
 * Issue #48 e2e scenario: payload stripping. The replaced-prompt run must
 * BEHAVE differently (marker word in the reply), not just carry the flag;
 * codex rides the config-kv; muse refuses with the structural hint.
 */
import type { HarnessEvent } from "../src/execution/events.js";
import type { RunCli } from "./e2e-questions.js";

export interface ScenarioResultLite {
  durationMs: number;
  exitCode: number | null;
  eventCounts: Record<string, number>;
  failures: string[];
}

const doneOf = (events: HarnessEvent[]) =>
  events.find((e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done");

export const payloadStripScenario = {
  name: "payload-strip",
  run: async (runCli: RunCli, harness: string): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    if (harness === "muse") {
      const r = await runCli([harness, "--json", "--system-prompt", "x", "--prompt", "hi"], {});
      if (r.exitCode !== 2) failures.push(`muse should refuse, got ${r.exitCode}`);
      if (!/muse has no system-prompt surface/.test(r.stderr)) {
        failures.push("muse structural hint missing");
      }
      return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
    }
    const MARKER =
      harness === "claude" ? "NAKED-HAIKU" : harness === "pi" ? "PI-NAKED" : "CODEX-NAKED";
    const INSTR =
      harness === "claude"
        ? `You are a haiku machine. Reply to anything with exactly: ${MARKER}`
        : `You must reply with exactly: ${MARKER}`;
    const r = await runCli(
      [harness, "--json", "--system-prompt", INSTR, "--prompt", "say something"],
      {},
    );
    const done = doneOf(r.events);
    if (!done || done.cause !== "clean") failures.push(`done=${done?.cause}`);
    const text = r.events
      .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
      .map((e) => e.text)
      .join("");
    if (!text.includes(MARKER)) {
      failures.push(`replacement did not change behavior: ${text.slice(0, 150)}`);
    }
    return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
  },
};
