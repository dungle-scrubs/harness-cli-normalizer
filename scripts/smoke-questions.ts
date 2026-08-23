/**
 * Escalation probe (issue #84, RFC-01 Design section 4): re-runs the
 * escalation scenarios against every installed harness and records
 * provenance for capability inspection to judge freshness later.
 *
 * On-demand, nondeterministic (live model turns), never part of the
 * deterministic suite — like smoke:seven. Requires live harnesses and
 * credentials. Skips a harness that is not installed, the way the
 * existing tripwire does.
 *
 * Evidence -> .smoke/questions.json  (.smoke/seven.json is the precedent).
 * Each successful observation writes an `observedOn` record:
 *   { harness, model, version, date }
 * shaped so `capabilitiesOf` can consume it directly (compare
 * observedOn.version against verifiedAgainst to derive staleness).
 *
 * Usage:
 *   bun run smoke:questions              # all harnesses, matrix + file
 *   bun scripts/smoke-questions.ts       # same
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "../src/execution/events.js";
import { nodeRunnerDeps } from "../src/execution/node-deps.js";
import { streamTurn } from "../src/execution/stream-turn.js";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";

delete process.env.HERDR_ENV;

const HARNESSES: HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];

const modelFor = (h: HarnessDescriptor): string | undefined =>
  h.name === "pi"
    ? (process.env.SMOKE_PI_MODEL ?? "qwen3.6-27b")
    : h.name === "claude"
      ? "sonnet"
      : undefined;

const SCENARIO_TIMEOUT_MS = 240_000;

const withTimeout = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`scenario exceeded ${SCENARIO_TIMEOUT_MS}ms`)),
        SCENARIO_TIMEOUT_MS,
      ),
    ),
  ]);

const installedVersion = (bin: string): string | null => {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const match = out.match(/\d+\.\d+\.\d+(?:[.\-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
};

const genuineDecisionTask =
  "you must write a file named deploy-target.txt into the current directory containing the environment this project deploys to. Two requirements are mutually exclusive and nothing in this directory says which applies: (a) the file must name the staging environment, or (b) it must name the production environment. The choice changes the file's contents and is not recoverable later without redoing the work. Decide whether to ask.";

const collect = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

type Provenance = {
  harness: string;
  model: string;
  version: string;
  date: string;
};

type Cell = {
  status: "pass" | "fail" | "skip";
  observedOn?: Provenance;
  detail: string;
};

const probeAsk = async (h: HarnessDescriptor, version: string): Promise<Cell> => {
  const model = modelFor(h) ?? "";
  const events = await collect(
    streamTurn(
      h,
      {
        prompt: genuineDecisionTask,
        cwd: process.cwd(),
        ...(model ? { model } : {}),
      },
      nodeRunnerDeps(),
    ),
  );
  const question = events.find((e) => e.kind === "question");
  const done = events.find((e) => e.kind === "done");
  if (!question) {
    const text = events
      .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
      .map((e) => e.text)
      .join("")
      .slice(0, 120);
    return {
      status: "fail",
      detail: `no question event (done=${done?.kind === "done" ? done.cause : "none"}): ${text}`,
    };
  }
  if (done?.kind !== "done" || done.cause !== "awaiting-input") {
    return {
      status: "fail",
      detail: `question present but done.cause=${done?.kind === "done" ? done.cause : "none"}`,
    };
  }
  const observedOn: Provenance = {
    harness: h.name,
    model,
    version,
    date: new Date().toISOString().slice(0, 10),
  };
  return { status: "pass", observedOn, detail: `question "${question.question.slice(0, 30)}"` };
};

const results: Record<string, Cell> = {};

for (const h of HARNESSES) {
  const version = installedVersion(h.bin);
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
  const r = results[h.name]!;
  const mark = r.status === "pass" ? "✓" : r.status === "skip" ? "–" : "✗";
  const ver = installedVersion(h.bin) ?? "?";
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
console.log("This is part of the version-bump ritual (AGENTS.md).");
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
