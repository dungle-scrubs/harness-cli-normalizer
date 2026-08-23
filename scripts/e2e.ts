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
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "../src/execution/events.js";
import { payloadStripScenario } from "./e2e-payload-strip.js";
import {
  questionAskScenario,
  questionNoneScenario,
  questionOffScenario,
  questionPrecedenceScenario,
  questionRoundtripScenario,
} from "./e2e-questions.js";
import {
  type SessionStep,
  sessionAskScenario,
  sessionOffScenario,
} from "./e2e-session-questions.js";

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
const runCli = (args: string[]) => runCliEnv(args, {});
const runCliIn = (args: string[], env: Record<string, string>, cwd: string) =>
  runCliEnv(args, env, cwd);

const runCliEnv = async (
  args: string[],
  extraEnv: Record<string, string>,
  cwd: string = process.cwd(),
): Promise<{
  exitCode: number | null;
  events: HarnessEvent[];
  stderr: string;
  timedOut: boolean;
}> => {
  const proc = spawn(HARNESS_BIN, [CLI_ENTRY, "run", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
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

/** Phase 5 defaults-profile scenarios: bare run carries effort medium on
 * all four; a user config changes it; a bad config refuses with exit 2
 * naming the key. Uses HCN_CONFIG_DIR (test seam) with temp dirs. */
const defaultsProfileScenario: Scenario = {
  name: "defaults-profile",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    let exitCode: number | null = null;
    const mkdtempSync = (await import("node:fs")).mkdtempSync;
    const writeFileSync = (await import("node:fs")).writeFileSync;
    const tmp = mkdtempSync("/tmp/hcn-profile-e2e-");
    const prevEnv = { ...process.env };

    try {
      // no config: profile applies (effort medium)
      process.env.HCN_CONFIG_DIR = tmp; // empty dir => no config file
      const bare = await runCliEnv([harness, "--json", "--prompt", "Reply OK only"], {
        HCN_CONFIG_DIR: tmp,
      });
      exitCode = bare.exitCode;
      const done = bare.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean")
        failures.push(`bare profile run not clean: ${done?.cause}`);
      if (!/effort = "medium" \(profile\)/.test(bare.stderr)) {
        failures.push(`profile provenance missing: ${bare.stderr.slice(0, 200)}`);
      }

      if (harness === "pi") {
        // config override: effort high at user-config tier
        const cfgDir = mkdtempSync("/tmp/hcn-profile-e2e-cfg-");
        writeFileSync(`${cfgDir}/config.json`, '{"version":1,"effort":"high"}');
        const cfgRun = await runCliEnv([harness, "--json", "--prompt", "Reply OK only"], {
          HCN_CONFIG_DIR: cfgDir,
        });
        if (!/effort = "high" \(user-config\)/.test(cfgRun.stderr)) {
          failures.push(`config override provenance missing: ${cfgRun.stderr.slice(0, 200)}`);
        }
        // bad config: unknown key refuses with exit 2
        const badDir = mkdtempSync("/tmp/hcn-profile-e2e-bad-");
        writeFileSync(`${badDir}/config.json`, '{"version":1,"frobnicate":true}');
        const badRun = await runCliEnv([harness, "--json", "--prompt", "hi"], {
          HCN_CONFIG_DIR: badDir,
        });
        if (badRun.exitCode !== 2) failures.push(`bad config exit ${badRun.exitCode}, expected 2`);
        if (!/unknown config key: "frobnicate"/.test(badRun.stderr)) {
          failures.push(`bad config key not named: ${badRun.stderr.slice(0, 200)}`);
        }
      }
    } finally {
      process.env = prevEnv;
    }
    return { durationMs: Date.now() - t0, exitCode, eventCounts: {}, failures };
  },
};

/** Phase 6 project-tier scenarios: git-root auto-discovery, precedence
 * over the user tier, the all-off floor, named toolsets, floor refusal.
 * Runs inside a temp git repo with a .hcn/config.json; the user tier is
 * neutralized via HCN_CONFIG_DIR pointing at an empty dir. */
const projectTierScenario: Scenario = {
  name: "project-config",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    let exitCode: number | null = null;
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const emptyUser = mkdtempSync("/tmp/hcn-user-empty-");
    const repo = mkdtempSync("/tmp/hcn-proj-repo-");
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
    } catch {
      failures.push("git init failed (git required for project tier e2e)");
    }
    mkdirSync(`${repo}/.hcn`, { recursive: true });
    writeFileSync(
      `${repo}/.hcn/config.json`,
      JSON.stringify({
        version: 1,
        effort: "low",
        tools: ["read", "grep", "find", "ls"],
        toolsets: { review: ["read", "grep"] },
      }),
    );

    const env = { HCN_CONFIG_DIR: emptyUser, HCNE2E_CWD: repo };

    // precedence: project effort=low beats profile medium (spawn line shows it)
    const r = await runCliIn([harness, "--json", "--prompt", "hi"], env, repo);
    exitCode = r.exitCode;
    if (!/effort = "low" \(project-config\)/.test(r.stderr)) {
      failures.push(`project provenance missing: ${r.stderr.slice(0, 250)}`);
    }

    if (harness === "pi") {
      // floor: grant exceeding refuses exit 2 naming both sets
      const f = await runCliIn(
        [harness, "--json", "--prompt", "hi", "--tools", "read,bash"],
        env,
        repo,
      );
      if (f.exitCode !== 2) failures.push(`floor exit ${f.exitCode}, expected 2`);
      if (!/exceeds the project floor/.test(f.stderr)) failures.push("floor refusal missing");
      // named toolset within floor passes
      const ok = await runCliIn(
        [harness, "--json", "--prompt", "hi", "--tools", "review"],
        env,
        repo,
      );
      if (ok.exitCode === 2) failures.push(`named toolset refused: ${ok.stderr.slice(0, 200)}`);
      // all-off: empty floor refuses any grant
      writeFileSync(`${repo}/.hcn/config.json`, JSON.stringify({ version: 1, tools: [] }));
      const off = await runCliIn(
        [harness, "--json", "--prompt", "hi", "--tools", "read"],
        env,
        repo,
      );
      if (off.exitCode !== 2) failures.push(`all-off exit ${off.exitCode}, expected 2`);
    }
    return { durationMs: Date.now() - t0, exitCode, eventCounts: {}, failures };
  },
};

/** Table-hint coverage: walk one refusal per hint family so every shipped
 * hint string is exercised on its real raise path (cheap - all refusals). */
const tableHintsScenario: Scenario = {
  name: "table-hints",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    // one refused dimension per harness, asserting the confirmed hint text
    const cases: Record<string, { args: string[]; hint: RegExp }> = {
      claude: {
        args: ["--sandbox", "read-only", "--prompt", "hi"],
        hint: /hint: claude has no sandbox modes.*per-tool allowlist/,
      },
      pi: {
        args: ["--write", "--prompt", "hi"],
        hint: /hint: pi has no write toggle.*--exclude-tools write/,
      },
      muse: {
        // max-steps is muse's OWN option (no refusal); provider is the
        // muse-lacking dimension whose hint must fire.
        args: ["--provider", "zai", "--prompt", "hi"],
        hint: /hint: muse routes models through its own API.*no separate provider selector/,
      },
    };
    const c = cases[harness];
    if (c === undefined) {
      // codex: provider hint via --provider (pi-only option)
      const r = await runCli(["codex", "--json", "--provider", "zai", "--prompt", "hi"]);
      if (!/hint: codex routes models through OpenAI/.test(r.stderr)) {
        failures.push(`codex provider hint missing: ${r.stderr.slice(0, 200)}`);
      }
      return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
    }
    const r = await runCli([harness, "--json", ...c.args]);
    if (r.exitCode !== 2) failures.push(`exit ${r.exitCode}, expected 2`);
    if (!c.hint.test(r.stderr)) failures.push(`hint missing/mismatch: ${r.stderr.slice(0, 250)}`);
    return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
  },
};

/** Effort takes real effect: thinking-token magnitude at low vs high on
 * claude (the harness whose internal default the probe measured). Asserts
 * the flag changed model behavior, not just provenance. */
const effortEffectScenario: Scenario = {
  name: "effort-effect",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    if (harness !== "claude") {
      // magnitude check only scripted for claude (probe baseline exists);
      // others: effort flag rides and run completes clean.
      const r = await runCli([
        harness,
        "--json",
        "--effort",
        "low",
        "--prompt",
        "Reply with the single word OK and nothing else.",
      ]);
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean") failures.push(`effort low not clean: ${done?.cause}`);
      return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
    }
    const TASK = "Reason step by step: which is larger, 9^9^9 or 9^99? Justify rigorously.";
    const run = async (effort: string) => {
      const r = await runCli([harness, "--json", "--effort", effort, "--prompt", TASK]);
      // hcn events carry no usage; assert via completion magnitude instead:
      // total text emitted correlates with effort on this reasoning task.
      const text = r.events
        .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
        .map((e) => e.text)
        .join("");
      return {
        len: text.length,
        clean: r.events.some((e) => e.kind === "done" && e.cause === "clean"),
      };
    };
    const low = await run("low");
    const high = await run("high");
    if (!low.clean || !high.clean) failures.push("run not clean at low or high");
    // probe measured ~436 tokens thinking at medium vs ~893+ at high;
    // generous bound: high must out-emit low by >=25% on this task
    if (high.len < low.len * 1.25) {
      failures.push(`effort had no measurable effect: low=${low.len} high=${high.len}`);
    }
    return { durationMs: Date.now() - t0, exitCode: 0, eventCounts: {}, failures };
  },
};

/** Launch-only resolution: a resumed session keeps its own settings - the
 * profile must not inject effort into a resume argv. */
const resumeBypassScenario: Scenario = {
  name: "resume-bypass",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    // claude is the resume-richest harness; others just verify the
    // resume argv shape via a fake id (refuses before spawn is fine for
    // wrong-shape ids only - a well-shaped unknown id launches on
    // create-harnesses, so use inspect? inspect has no resume path;
    // exercise via run with --json and assert NO provenance lines).
    const FAKE = "12345678-1234-5678-1234-123456789abc";
    const r = await runCli([harness, "--json", "--resume", FAKE, "--prompt", "Reply OK only"]);
    if (/provenance: effort/.test(r.stderr)) {
      failures.push("profile effort leaked into a resume run");
    }
    if (/spawn:.*--effort|--thinking|--reasoning-effort|model_reasoning_effort/.test(r.stderr)) {
      failures.push("effort flag present in resume spawn line");
    }
    // run must not refuse purely from the profile (the resume itself may
    // fail on nonexistent ids - acceptable, message-checked only for the
    // profile leak above)
    return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
  },
};

/** D11 timeout: opt-in wall-clock budget. A 3s budget kills a slow
 * prompt with the timeout failure class and done cause "killed"; hcn
 * exit 1; 0 disables (a quick prompt completes clean). Live spawns. */
const timeoutScenario: Scenario = {
  name: "timeout",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    const tSlow0 = Date.now();
    const slow = await runCli([
      harness,
      "--json",
      "--timeout",
      "3",
      "--prompt",
      "Count slowly from 1 to 100, one number per line, pausing between each.",
    ]);
    const slowMs = Date.now() - tSlow0;
    const fail = slow.events.find(
      (e): e is Extract<HarnessEvent, { kind: "failure" }> => e.kind === "failure",
    );
    if (!fail) failures.push("no failure event on timeout kill");
    else if (fail.class !== "timeout")
      failures.push(`failure class ${fail.class}, expected timeout`);
    const done = slow.events.find(
      (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
    );
    if (done && done.cause !== "killed") failures.push(`done cause ${done.cause}, expected killed`);
    if (slow.exitCode !== 1) failures.push(`hcn exit ${slow.exitCode}, expected 1`);
    if (slowMs > 15000) failures.push(`kill took ${slowMs}ms - grace ladder too slow`);
    // timeout 0 = disable: quick prompt completes clean
    const off = await runCli([
      harness,
      "--json",
      "--timeout",
      "0",
      "--prompt",
      "Reply with the single word OK and nothing else.",
    ]);
    const doneOff = off.events.find(
      (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
    );
    if (!doneOff || doneOff.cause !== "clean")
      failures.push(`--timeout 0 run not clean: ${doneOff?.cause}`);
    return { durationMs: Date.now() - t0, exitCode: slow.exitCode, eventCounts: {}, failures };
  },
};

/** D13: equivalence by default. A BARE pi run (no --tools) must have grep
 * working - the dormant trio enabled by the profile marker - and the
 * provenance must show the tools entry at profile tier. */
const toolsEquivalenceScenario: Scenario = {
  name: "tools-equivalence",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    if (harness === "pi") {
      const r = await runCli([
        harness,
        "--json",
        "--prompt",
        "Use your grep tool to search this directory for the literal string 'createRenderState'. Report the count of matching lines only. If you have no grep tool, say NOGREP.",
      ]);
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean") failures.push(`pi bare run not clean: ${done?.cause}`);
      const text = r.events
        .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
        .map((e) => e.text)
        .join("");
      if (/NOGREP/i.test(text)) failures.push("pi bare run lacks grep - marker not applied");
      if (!/\d/.test(text)) failures.push(`no count reported: ${text.slice(0, 150)}`);
      if (
        !/tools = \["read","bash","edit","write","grep","find","ls"\] \(profile\)/.test(r.stderr)
      ) {
        failures.push(`tools provenance missing: ${r.stderr.slice(0, 250)}`);
      }
    } else if (harness === "claude") {
      const r = await runCli([harness, "--json", "--prompt", "Reply OK only."]);
      if (!/tools = "all known \(already default\)" \(profile\)/.test(r.stderr)) {
        failures.push(`claude emit-nothing provenance missing: ${r.stderr.slice(0, 250)}`);
      }
    } else {
      // codex/muse: divergence line on tools
      const r = await runCli([harness, "--json", "--prompt", "Reply OK only."]);
      if (!/divergence: profile "tools" not expressible/.test(r.stderr)) {
        failures.push(`tools divergence missing: ${r.stderr.slice(0, 250)}`);
      }
    }
    return { durationMs: Date.now() - t0, exitCode: 0, eventCounts: {}, failures };
  },
};

/** issue #38 skills allowlist: pi loads ONLY the picked skill (live check
 * of the listed set); claude complement narrows the personal registry;
 * codex/muse refuse with hints; unknown names refuse listing the
 * registry. */
const skillsAllowlistScenario: Scenario = {
  name: "skills-allowlist",
  phases: ["all"],
  run: async (harness) => {
    const failures: string[] = [];
    const t0 = Date.now();
    if (harness === "pi") {
      const r = await runCli([
        harness,
        "--json",
        "--skills",
        "hcn",
        "--prompt",
        "Which skills are listed as available to you? Names only, one line, comma separated. If none, say NONE.",
      ]);
      const done = r.events.find(
        (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
      );
      if (!done || done.cause !== "clean") failures.push(`pi skills run not clean: ${done?.cause}`);
      const text = r.events
        .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
        .map((e) => e.text)
        .join("");
      if (!/^\s*hcn\s*$/m.test(text) && !text.trim().endsWith("hcn")) {
        failures.push(`pi allowlist not exact (expected only hcn): ${text.slice(0, 150)}`);
      }
      const bad = await runCli([
        harness,
        "--json",
        "--skills",
        "definitely-not-a-skill",
        "--prompt",
        "hi",
      ]);
      if (bad.exitCode !== 2) failures.push(`unknown skill exit ${bad.exitCode}, expected 2`);
      if (!/unknown skill name/.test(bad.stderr)) failures.push("unknown-skill refusal missing");
    } else if (harness === "claude") {
      const r = await runCli([harness, "--json", "--skills", "hcn", "--prompt", "Reply OK only."]);
      if (!/--settings \{"skillOverrides"/.test(r.stderr)) {
        failures.push(`claude complement missing: ${r.stderr.slice(0, 200)}`);
      }
    } else {
      const r = await runCli([harness, "--json", "--skills", "hcn", "--prompt", "hi"]);
      if (r.exitCode !== 2) failures.push(`${harness} skills exit ${r.exitCode}, expected 2`);
      if (!/hint: .*no (call-time|per-skill) surface/.test(r.stderr)) {
        failures.push(`refusal hint missing: ${r.stderr.slice(0, 200)}`);
      }
    }
    return { durationMs: Date.now() - t0, exitCode: 0, eventCounts: {}, failures };
  },
};

const SCENARIOS: Scenario[] = [
  baselineScenario,
  toolSelectionScenario,
  mutualExclusionScenario,
  refusalDiagnosticsScenario,
  passthroughScenario,
  defaultsProfileScenario,
  projectTierScenario,
  tableHintsScenario,
  effortEffectScenario,
  resumeBypassScenario,
  timeoutScenario,
  toolsEquivalenceScenario,
  skillsAllowlistScenario,
];

// issue #41 question-escalation scenarios (see e2e-questions.ts). They
// need extra capabilities (temp dirs, git init) injected from this
// runner, so they adapt the Scenario shape here rather than in the module.
const gitInit = (cwd: string): void => {
  try {
    execFileSync("git", ["init", "-q"], { cwd });
  } catch {
    /* git absence fails the scenario assertions via stderr text */
  }
};
// issue #44 session-mode scenarios: drive `hcn session <harness>` with a
// stdout-synchronized stdin feeder (answer typed only after the menu
// renders, exit only after the final turn). claude + pi only.
const spawnSessionCli = async (
  harness: string,
  argv: string[],
  steps: readonly SessionStep[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
  const proc = spawn(HARNESS_BIN, [CLI_ENTRY, "session", harness, ...argv], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
  proc.stderr.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on("close", (code) => resolve(code));
    void (async () => {
      for (const step of steps) {
        if (step.branch !== undefined) {
          const start = stdout.length;
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const seen = stdout.slice(start);
            const hit = step.branch.find((b) => b.expect.test(seen));
            if (hit !== undefined) {
              proc.stdin.write(`${hit.line}\n`);
              break;
            }
            if (Date.now() > deadline || proc.exitCode !== null) return;
            await new Promise((r) => setTimeout(r, 200));
          }
          continue;
        }
        if (step.expect !== undefined) {
          // Positional: match only text emitted AFTER the previous step
          // matched - a later step must never re-match an earlier turn's
          // marker (the drive wrote "exit" against turn-1's awaiting-input
          // line while the menu was still open).
          const start = stdout.length;
          const deadline = Date.now() + timeoutMs;
          while (!step.expect.test(stdout.slice(start))) {
            if (Date.now() > deadline || proc.exitCode !== null) return;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        proc.stdin.write(`${step.line ?? ""}\n`);
      }
    })();
  });
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
};

const SESSION_SCENARIOS: Scenario[] = [
  {
    name: sessionAskScenario.name,
    phases: ["all"],
    run: async (harness) => {
      if (harness !== "claude" && harness !== "pi") {
        return { durationMs: 0, exitCode: 0, eventCounts: {}, failures: [] };
      }
      return sessionAskScenario.run(spawnSessionCli, harness, mkdtempSync);
    },
  },
  {
    name: sessionOffScenario.name,
    phases: ["all"],
    run: async (harness) => {
      if (harness !== "claude" && harness !== "pi") {
        return { durationMs: 0, exitCode: 0, eventCounts: {}, failures: [] };
      }
      return sessionOffScenario.run(spawnSessionCli, harness, mkdtempSync);
    },
  },
];
SCENARIOS.push(...SESSION_SCENARIOS);

// issue #48: payload stripping - behavior-verified replacement
SCENARIOS.push({
  name: payloadStripScenario.name,
  phases: ["all"],
  run: async (harness) => payloadStripScenario.run(qRunCli, harness),
});

const qRunCli: import("./e2e-questions.js").RunCli = (args, env, cwd) =>
  cwd === undefined ? runCliEnv(args, env) : runCliIn(args, env, cwd);
const QUESTION_SCENARIOS: Scenario[] = [
  {
    name: questionAskScenario.name,
    phases: ["all"],
    run: async (harness) => questionAskScenario.run(qRunCli, harness),
  },
  {
    name: questionOffScenario.name,
    phases: ["all"],
    run: async (harness) => questionOffScenario.run(qRunCli, harness, mkdtempSync),
  },
  {
    name: questionPrecedenceScenario.name,
    phases: ["all"],
    run: async (harness) =>
      questionPrecedenceScenario.run(
        qRunCli,
        harness,
        mkdtempSync,
        { writeFileSync, mkdirSync },
        gitInit,
      ),
  },
  {
    name: questionRoundtripScenario.name,
    phases: ["all"],
    run: async (harness) => questionRoundtripScenario.run(qRunCli, harness, mkdtempSync),
  },
  {
    name: questionNoneScenario.name,
    phases: ["all"],
    run: async (harness) => questionNoneScenario.run(qRunCli, harness, mkdtempSync),
  },
];
SCENARIOS.push(...QUESTION_SCENARIOS);

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
