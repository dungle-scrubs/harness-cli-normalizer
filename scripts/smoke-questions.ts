/**
 * Escalation probe (issue #84, RFC-01 Design section 4): re-runs the
 * escalation scenario against every installed harness and records
 * provenance for capability inspection to judge freshness later.
 *
 * On-demand, nondeterministic (live model turns), never part of the
 * deterministic suite - like smoke:seven. Requires live harnesses and
 * credentials. Skips a harness that is not installed.
 *
 * Evidence -> .smoke/questions.json  (.smoke/seven.json is the precedent).
 * Each successful observation writes an `observedOn` record:
 *   { harness, model, version, date }
 * shaped so `capabilitiesOf` can consume it directly (compare
 * observedOn.version against verifiedAgainst to derive staleness).
 *
 * The probe lives in lib/question-probe.ts; check-harnesses runs it per
 * drifted harness and can write the record into the descriptor (--bump).
 *
 * Usage:
 *   bun run smoke:questions              # all harnesses, matrix + file
 *   bun scripts/smoke-questions.ts       # same
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";
import { installedVersion } from "./lib/harness-versions.js";
import { type ProbeCell, type Provenance, probeAsk } from "./lib/question-probe.js";
import { withTimeout } from "./lib/seven-scenarios.js";

delete process.env.HERDR_ENV;

const HARNESSES: HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];

const results: Record<string, ProbeCell> = {};
const versions: Record<string, string | null> = {};

for (const h of HARNESSES) {
  const version = installedVersion(h.bin);
  versions[h.name] = version;
  if (version === null) {
    results[h.name] = { status: "skip", detail: "not installed" };
    continue;
  }
  try {
    results[h.name] = await withTimeout(probeAsk(h, version));
  } catch (cause) {
    results[h.name] = { status: "fail", detail: String(cause).slice(0, 120) };
  }
}

// Render matrix
console.log(`\n${"harness".padEnd(9)}${"version".padEnd(12)}${"result".padEnd(8)}detail`);
for (const h of HARNESSES) {
  const r = results[h.name] ?? { status: "fail", detail: "no result" };
  const mark = r.status === "pass" ? "✓" : r.status === "skip" ? "–" : "✗";
  const ver = versions[h.name] ?? "?";
  console.log(`${h.name.padEnd(9)}${ver.padEnd(12)}${mark.padEnd(8)}${r.detail}`);
}

const observations: Record<string, Provenance | null> = {};
for (const [name, cell] of Object.entries(results)) {
  observations[name] = cell.observedOn ?? null;
}

mkdirSync(".smoke", { recursive: true });
writeFileSync(
  ".smoke/questions.json",
  JSON.stringify({ ranAt: new Date().toISOString(), results, observations }, null, 2),
);

console.log("\n--- Transcribe into descriptors ---");
console.log("Update each harness descriptor's escalation.observedOn to the values below,");
console.log("then bump verifiedAgainst to the installed version and re-capture fixtures.");
console.log("`bun run check:harnesses --bump` does the first two steps for you.");
for (const h of HARNESSES) {
  const obs = observations[h.name];
  if (obs) {
    console.log(
      `${h.name}: observedOn: { harness: "${obs.harness}", model: "${obs.model}", version: "${obs.version}", date: "${obs.date}" }`,
    );
    console.log(
      `  -> src/knowledge/${h.name === "claude" ? "claude-code" : h.name}.ts: escalation: { supported: true, observedOn: { harness: "${obs.harness}", model: "${obs.model}", version: "${obs.version}", date: "${obs.date}" } }`,
    );
  } else {
    console.log(`${h.name}: no observation (skipped/failed) - leave observedOn absent`);
  }
}

const failed = Object.values(results).filter((c) => c.status === "fail").length;
const passed = Object.values(results).filter((c) => c.status === "pass").length;
const skipped = Object.values(results).filter((c) => c.status === "skip").length;
console.log(`\n${passed} pass, ${skipped} skipped, ${failed} fail`);
if (failed > 0) process.exit(1);
