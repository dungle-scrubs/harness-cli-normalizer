/**
 * E2E scenario suite: drives `hcn run` as a real process (the CLI the user
 * invokes, not the library seam) and asserts on its observable contract -
 * NDJSON events, exit codes, stderr. Phase 0 of the action plan builds this
 * runner with one baseline scenario (bare run per harness decodes clean);
 * each later phase appends its scenarios here.
 *
 * Differs from smoke-all.ts by testing the CLI surface end to end (process
 * spawn, arg parsing, rendering) rather than the execution layer directly.
 * Evidence -> .e2e/last-run.json. On-demand and nondeterministic (live model
 * turns): never part of the deterministic suite, run at every phase gate.
 *
 * Usage:
 *   bun scripts/e2e.ts                  # all scenarios, all harnesses
 *   bun scripts/e2e.ts --only baseline  # scenarios matching a substring
 *   bun scripts/e2e.ts --harness pi     # restrict harnesses
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "../src/execution/events.js";

const CLI_TIMEOUT_MS = 240_000;

interface ScenarioResult {
  scenario: string;
  harness: string;
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  eventCounts: Record<string, number>;
  failures: string[];
}

interface Scenario {
  name: string;
  phases: Array<"all" | "spawn-cheap">;
  run: (harness: string) => Promise<Omit<ScenarioResult, "scenario" | "harness" | "ok">>;
}

const HARNESS_BIN = process.execPath.includes("bun") ? process.execPath : "bun";
const CLI_ENTRY = new URL("../src/cli/index.ts", import.meta.url).pathname;

/** Run `hcn run <harness> ...` as a subprocess, collect NDJSON + exit code. */
const runCli = async (
  args: string[],
): Promise<{
  exitCode: number | null;
  events: HarnessEvent[];
  stderr: string;
  timedOut: boolean;
}> => {
  const proc = spawn(HARNESS_BIN, [CLI_ENTRY, "run", ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const events: HarnessEvent[] = [];
  let stderr = "";
  let stdoutBuf = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, CLI_TIMEOUT_MS);

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl = stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as HarnessEvent);
      } catch {
        // Non-JSON line on stdout in --json mode is a CLI contract violation;
        // record it as an error event so the assertion layer sees it.
        events.push({ kind: "error", message: `non-ndjson stdout: ${line}` });
      }
      nl = stdoutBuf.indexOf("\n");
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  return { exitCode, events, stderr, timedOut };
};

const countKinds = (events: HarnessEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
};

/** Baseline: bare run. The contract every phase must keep holding:
 * decodable NDJSON, identity announced, done with cause clean, exit 0. */
const baselineScenario: Scenario = {
  name: "baseline",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    const { exitCode, events, stderr, timedOut } = await runCli([
      harness,
      "--json",
      "--prompt",
      "Reply with the single word OK and nothing else.",
    ]);
    const durationMs = Date.now() - t0;
    const eventCounts = countKinds(events);

    if (timedOut) failures.push(`timed out after ${CLI_TIMEOUT_MS}ms`);
    const done = events.find(
      (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
    );
    if (!done) failures.push("no done event");
    else {
      if (done.cause !== "clean") failures.push(`done.cause=${done.cause}, expected clean`);
      if (done.exitCode !== 0) failures.push(`done.exitCode=${done.exitCode}, expected 0`);
    }
    if (!events.some((e) => e.kind === "identity")) {
      // limit/auth walls are terminal-but-valid outcomes in smoke; here a bare
      // run must at minimum announce identity or fail loudly with a reason.
      const failure = events.find((e) => e.kind === "failure");
      if (!failure) failures.push("no identity event and no failure to explain it");
    }
    if (exitCode !== 0 && !failures.some((f) => f.includes("cause="))) {
      failures.push(`process exit ${exitCode} with stderr: ${stderr.slice(0, 300)}`);
    }
    return { durationMs, exitCode, eventCounts, failures };
  },
};

const SCENARIOS: Scenario[] = [baselineScenario];

// ---- CLI arg parsing ----
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const onlyHarness = argv.includes("--harness") ? argv[argv.indexOf("--harness") + 1] : undefined;

const harnesses = onlyHarness ? [onlyHarness] : ["claude", "codex", "pi", "muse"];

const results: ScenarioResult[] = [];
for (const scenario of SCENARIOS) {
  if (only && !scenario.name.includes(only)) continue;
  for (const h of harnesses) {
    process.stdout.write(`e2e: ${scenario.name} / ${h} ... `);
    const r = await scenario.run(h);
    const full: ScenarioResult = {
      ...r,
      scenario: scenario.name,
      harness: h,
      ok: r.failures.length === 0,
    };
    results.push(full);
    process.stdout.write(full.ok ? `ok (${full.durationMs}ms)\n` : `FAIL\n`);
    for (const f of full.failures) process.stdout.write(`      ${f}\n`);
  }
}

mkdirSync(".e2e", { recursive: true });
writeFileSync(".e2e/last-run.json", JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exit(1);
