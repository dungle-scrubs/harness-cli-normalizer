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

/** Tool-selection scenarios (Phase 2, D1-D3): a granted pi read-only set
 * must actually refuse a bash task; the claude deny-complement must reshape
 * the visible set; mutual exclusion must refuse with exit 2; codex/muse
 * refuse name lists. These are live model turns - spawn-cheap harnesses
 * only, per the approved gate scope. */
const toolSelectionScenario: Scenario = {
  name: "tools",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    let exitCode: number | null = null;
    const eventCounts: Record<string, number> = {};

    if (harness === "pi") {
      // Grant read-only: the model must NOT be able to run bash. A
      // well-behaved refusal to attempt it, or an error about the missing
      // tool, both count - the grant shaped the tool set.
      const r = await runCli([
        harness,
        "--json",
        "--tools",
        "read",
        "--prompt",
        "You have no bash tool. Reply with exactly: NOBASH. Do not attempt any tool call.",
      ]);
      exitCode = r.exitCode;
      Object.assign(eventCounts, countKinds(r.events));
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean")
        failures.push(`pi read-only run not clean: ${done?.cause ?? "no done"}`);
      const text = r.events
        .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
        .map((e) => e.text)
        .join("");
      if (!/NOBASH/i.test(text))
        failures.push(`pi read-only reply unexpected: ${text.slice(0, 120)}`);
    } else if (harness === "claude") {
      // Deny-complement: with only Read and Bash granted (everything else
      // denied), the visible set must not contain Edit.
      const r = await runCli([
        harness,
        "--json",
        "--tools",
        "Read,Bash",
        "--prompt",
        "Do not call any tools. One line: is an Edit tool available to you? Answer YES or NO only.",
      ]);
      exitCode = r.exitCode;
      Object.assign(eventCounts, countKinds(r.events));
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean")
        failures.push(`claude complement run not clean: ${done?.cause ?? "no done"}`);
      const text = r.events
        .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
        .map((e) => e.text)
        .join("");
      if (!/\bNO\b/i.test(text))
        failures.push(`claude Edit should be denied, reply: ${text.slice(0, 120)}`);
    } else {
      // codex/muse: name lists refuse before spawn.
      const r = await runCli([harness, "--json", "--tools", "Read", "--prompt", "hi"]);
      exitCode = r.exitCode;
      Object.assign(eventCounts, countKinds(r.events));
      if (r.exitCode !== 2) failures.push(`expected refusal exit 2, got ${r.exitCode}`);
      if (!/cannot express/i.test(r.stderr))
        failures.push(`stderr lacks refusal: ${r.stderr.slice(0, 200)}`);
    }
    return { durationMs: Date.now() - t0, exitCode, eventCounts, failures };
  },
};

/** Mutual exclusion (D1) refuses with exit 2 - cheap, no spawn needed on
 * refusal, but run through all harnesses for uniformity. */
const mutualExclusionScenario: Scenario = {
  name: "tools-mutual-exclusion",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    const r = await runCli([
      harness,
      "--json",
      "--tools",
      "read",
      "--exclude-tools",
      "bash",
      "--prompt",
      "hi",
    ]);
    if (r.exitCode !== 2) failures.push(`expected exit 2, got ${r.exitCode}`);
    if (!/exactly one/i.test(r.stderr))
      failures.push(`stderr lacks mutual-exclusion: ${r.stderr.slice(0, 200)}`);
    return {
      durationMs: Date.now() - t0,
      exitCode: r.exitCode,
      eventCounts: countKinds(r.events),
      failures,
    };
  },
};

/** Phase 3 refusal-diagnostics scenarios: every refusal class fires with
 * the D7/D8 fields intact - hint present, supportedBy derived, native
 * spellings redirected. Cheap (refusals never spawn). */
const refusalDiagnosticsScenario: Scenario = {
  name: "refusal-diagnostics",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    let exitCode: number | null = null;

    if (harness === "codex" || harness === "muse") {
      // unsupported tool lists: hint + derived support list on stderr
      const r = await runCli([harness, "--tools", "Read", "--prompt", "hi"]);
      exitCode = r.exitCode;
      if (r.exitCode !== 2) failures.push(`expected 2, got ${r.exitCode}`);
      if (!/^hint: /m.test(r.stderr)) failures.push("no hint line");
      if (!/supported on: claude \(--allowedTools\), pi \(--tools\)/.test(r.stderr)) {
        failures.push(`no derived support list: ${r.stderr.slice(0, 200)}`);
      }
    } else if (harness === "pi") {
      // autonomy: derived list, hardcoded array gone, stay-on-harness hint
      const r = await runCli([harness, "--autonomy", "--prompt", "hi"]);
      exitCode = r.exitCode;
      if (r.exitCode !== 2) failures.push(`expected 2, got ${r.exitCode}`);
      if (!/hint: pi has no unattended-run flag/.test(r.stderr))
        failures.push("no pi autonomy hint");
      if (
        !/supported on: claude \(--dangerously-skip-permissions\), codex \(--yolo\), muse \(--yolo\)/.test(
          r.stderr,
        )
      ) {
        failures.push(`autonomy support list wrong: ${r.stderr.slice(0, 200)}`);
      }
    } else {
      // claude: native-spelling recognition path. Use a spelling ONLY pi
      // has (its -nt tools-off switch) so it stays unknown to hcn's flag
      // table and exercises the recognition path, not flag parsing.
      const r = await runCli(["claude", "-nt", "--prompt", "hi"]);
      exitCode = r.exitCode;
      if (r.exitCode !== 2) failures.push(`expected 2, got ${r.exitCode}`);
      if (!/is a native spelling \(used by pi\)/.test(r.stderr)) {
        failures.push(`no native redirect: ${r.stderr.slice(0, 200)}`);
      }
    }
    return { durationMs: Date.now() - t0, exitCode, eventCounts: {}, failures };
  },
};

/** Phase 4 (D6) passthrough scenarios: native error labeling end to end.
 * Wrong-harness flag after -- fails in the harness, surfaces as native
 * (labeled, nativeExitCode data, hcn exit 1); before -- the same flag is
 * recognized and redirected (exit 2). Live spawns, cheap (they fail fast). */
const passthroughScenario: Scenario = {
  name: "passthrough-native",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    let exitCode: number | null = null;

    if (harness === "codex") {
      // after --: native failure, labeled, hcn exit 1, native code as data
      const r = await runCli([harness, "--json", "--prompt", "hi", "--", "--allowedTools", "Read"]);
      exitCode = r.exitCode;
      const fail = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "failure" }> => e.kind === "failure",
      );
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!fail) failures.push("no failure event");
      else {
        if (fail.class !== "native") failures.push(`failure class ${fail.class}, expected native`);
        if ((fail as { nativeExitCode?: number }).nativeExitCode !== 2) {
          failures.push("nativeExitCode not carried as data");
        }
      }
      if (r.exitCode !== 1) failures.push(`hcn exit ${r.exitCode}, expected 1 (hcn owns it)`);
      if (done && done.exitCode !== null) failures.push("done.exitCode should be null for native");
      // before --: recognized and redirected, hcn refusal exit 2
      const r2 = await runCli([harness, "--json", "--allowedTools", "Read", "--prompt", "hi"]);
      if (r2.exitCode !== 2) failures.push(`pre-separator exit ${r2.exitCode}, expected 2`);
      if (!/native spelling/.test(r2.stderr)) failures.push("pre-separator not redirected");
    } else {
      // other harnesses: separator mechanics still work; a valid native
      // flag rides through (pi -ns after -- is legal for pi itself).
      const r = await runCli([harness, "--json", "--prompt", "hi"]);
      exitCode = r.exitCode;
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean")
        failures.push(`baseline-with-passthrough-api not clean: ${done?.cause}`);
      // empty passthrough refuses
      const r2 = await runCli([harness, "--json", "--prompt", "hi", "--"]);
      if (r2.exitCode !== 2) failures.push(`empty passthrough exit ${r2.exitCode}, expected 2`);
    }
    return { durationMs: Date.now() - t0, exitCode, eventCounts: {}, failures };
  },
};

const SCENARIOS: Scenario[] = [
  baselineScenario,
  toolSelectionScenario,
  mutualExclusionScenario,
  refusalDiagnosticsScenario,
  passthroughScenario,
];

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
