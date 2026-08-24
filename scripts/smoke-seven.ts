/**
 * The seven-scenario real-harness compatibility smoke (M7.2, runner scope).
 * Runs each applicable scenario against every installed harness and prints
 * a matrix. On-demand, nondeterministic, never in the deterministic suite.
 * Evidence -> .smoke/seven.json.
 *
 * The scenarios live in lib/seven-scenarios.ts; check-harnesses runs the
 * same scenarios per drifted harness and reports them per descriptor claim.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";
import { type Cell, runScenarios, SCENARIOS } from "./lib/seven-scenarios.js";

delete process.env.HERDR_ENV;

const HARNESSES: HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];

const results: Record<string, Record<string, Cell>> = {};
for (const h of HARNESSES) {
  results[h.name] = await runScenarios(h);
}

// Render matrix.
const scenarioNames = SCENARIOS.map((s) => s.name);
const mark = (c: Cell): string => (c.status === "pass" ? "✓" : c.status === "skip" ? "–" : "✗");
console.log(`\n${"scenario".padEnd(22)}${HARNESSES.map((h) => h.name.padEnd(7)).join("")}`);
for (const s of scenarioNames) {
  console.log(
    `${s.padEnd(22)}${HARNESSES.map((h) => `${mark(results[h.name]?.[s] ?? { status: "fail", detail: "" })}      `).join("")}`,
  );
}

mkdirSync(".smoke", { recursive: true });
writeFileSync(
  ".smoke/seven.json",
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);

const cells = HARNESSES.flatMap((h) => scenarioNames.map((s) => results[h.name]?.[s]));
const failed = cells.filter((c) => c?.status === "fail").length;
const passed = cells.filter((c) => c?.status === "pass").length;
const skipped = cells.filter((c) => c?.status === "skip").length;
console.log(`\n${passed} pass, ${skipped} n/a, ${failed} fail`);
if (failed > 0) process.exit(1);
