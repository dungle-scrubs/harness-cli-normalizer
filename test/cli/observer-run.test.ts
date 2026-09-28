/**
 * The observer over a real `hcn run` (ADR 0011, RFC-03 slice 11): the
 * built CLI against a stub `claude` on PATH and a stub observer script,
 * per the M3 stub pattern. Covers the run-level acceptance criteria:
 * the full record stream on a clean run (and no droppable records in it
 * while --json stdout shows them), the env override, the string-only
 * enablement (a missing observer path changes nothing), and SIGTERM to
 * hcn's process group producing a done with cause killed - which also
 * proves the observer is detached into its own group. No real harness,
 * no model, no network. Every spawned observer is a stub script that
 * exits on stdin EOF; cleanup kills every recorded PID by PID and waits
 * for exit before deleting anything.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupSandbox } from "./reap.js";
import { ensureDist } from "./stub-dist.js";

const SID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

const HARNESS = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.HARNESS_PID_OUT, String(process.pid));
fs.writeFileSync(process.env.HARNESS_ENV_OUT, JSON.stringify({ HCN_INVOCATION_ID: process.env.HCN_INVOCATION_ID ?? null }));
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
line({ type: "system", subtype: "init", session_id: "${SID}" });
if (process.env.STUB_HARNESS_MODE === "sleep") {
  setInterval(() => {}, 1000000);
  return;
}
line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "tok" } } });
line({ type: "system", subtype: "hook_started" });
line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
line({ type: "result", subtype: "success" });
`;

const OBSERVER = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
let buf = "";
const sink = process.env.STUB_OUT;
writeFileSync(process.env.OBSERVER_PID_OUT, String(process.pid));
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\\n")) >= 0) {
    appendFileSync(sink, buf.slice(0, at + 1));
    buf = buf.slice(at + 1);
  }
});
process.stdin.on("end", () => {
  if (buf) appendFileSync(sink, buf + "\\n");
  appendFileSync(sink, "EOF\\n");
  process.exit(0);
});
`;

interface Box {
  cli: string;
  cwdDir: string;
  dir: string;
  env: Record<string, string>;
  harnessEnv: string;
  harnessPid: string;
  observerPath: string;
  observerPid: string;
  stream: string;
}

// `started` is set before a test spawns an observer-enabled CLI, so
// cleanup knows an observer may exist even before any file shows it.
const boxes: { box: Box; pids: number[]; started?: boolean }[] = [];

// The per-worker HCN_STATE_DIR sandbox (hcn-test-state-*, created by
// test/cli/setup-state.ts before any test file) must live for the WHOLE
// suite: deleting and unbinding it after one test leaves later fixtures
// running without an override, so the spawned CLI writes its command
// ledger to the operator's real $XDG_STATE_HOME/hcn/commands.jsonl. This
// file never deletes it; the setup module removes it at worker exit.

afterEach(async () => {
  for (const { box, pids, started } of boxes.splice(0)) {
    // Terminate and reap every recorded child before deleting anything:
    // a failed assertion before the test's own SIGTERM or end() can
    // leave a stub running, and the sandbox must not be deleted under
    // a live child. A pid that survives SIGTERM and SIGKILL rejects,
    // fails the test, and keeps the directory for diagnosis.
    // A test can fail before it records its stub pids, so also take them
    // from the pid files the stubs write at startup. A detached observer
    // may be running without having written its file yet: once the run
    // has started, wait for a valid pid. If none arrives in time, fail
    // and keep the fixture rather than delete it under a live child.
    const pidIn = (file: string): number | undefined => {
      if (!existsSync(file)) return undefined;
      const pid = Number(readFileSync(file, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    };
    if (started && box.env.HCN_OBSERVER !== undefined && existsSync(box.observerPath)) {
      if (!(await until(() => pidIn(box.observerPid) !== undefined, 5000))) {
        throw new Error(`observer pid never written; keeping ${box.dir} for diagnosis`);
      }
    }
    const filed = [box.harnessPid, box.observerPid]
      .map(pidIn)
      .filter((pid): pid is number => pid !== undefined);
    await cleanupSandbox({
      pids: [...new Set([...pids, ...filed])],
      dirs: [box.dir],
      prefix: join(tmpdir(), "hcn-observer-run-"),
      label: "observer-run",
    });
  }
});

const waitExit = async (pid: number, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** The sandbox for one run: stub bin on PATH, pid files, the observer
 * stream path. `observerEnabled: false` leaves HCN_OBSERVER unset;
 * `observerMissing: true` points HCN_OBSERVER at a path that does not
 * exist (the string-only enablement case). */
const fixture = (options: { observerEnabled: boolean; observerMissing?: boolean }): Box => {
  const cli = ensureDist();
  const dir = mkdtempSync(join(tmpdir(), "hcn-observer-run-"));
  const binDir = join(dir, "bin");
  const outDir = join(dir, "out");
  const cwdDir = join(dir, "cwd");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  writeFileSync(join(binDir, "claude"), HARNESS);
  chmodSync(join(binDir, "claude"), 0o755);
  const observerPath = options.observerMissing
    ? join(dir, "missing-observer.mjs")
    : join(binDir, "stub-observer.mjs");
  if (!options.observerMissing) {
    writeFileSync(observerPath, OBSERVER);
    chmodSync(observerPath, 0o755);
  }
  const stream = join(outDir, "observer-stream.ndjson");
  const harnessEnv = join(outDir, "harness-env.json");
  const harnessPid = join(outDir, "harness.pid");
  const observerPid = join(outDir, "observer.pid");
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    STUB_OUT: stream,
    HARNESS_ENV_OUT: harnessEnv,
    HARNESS_PID_OUT: harnessPid,
    OBSERVER_PID_OUT: observerPid,
  };
  // Never inherit the operator's observer wiring: an HCN_OBSERVER (or
  // HCN_INVOCATION_ID) set in the operator environment would run that
  // external command inside the disabled cases, coupling the test to
  // whatever the operator happens to have set. Tests set these only
  // when they mean to.
  delete env.HCN_OBSERVER;
  delete env.HCN_INVOCATION_ID;
  if (options.observerEnabled) env.HCN_OBSERVER = observerPath;
  return {
    cli,
    cwdDir,
    dir,
    env,
    harnessEnv,
    harnessPid,
    observerPath,
    observerPid,
    stream,
  };
};

const parseStream = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((l) => l && l !== "EOF")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const readStream = (path: string): Record<string, unknown>[] | null =>
  existsSync(path) ? parseStream(readFileSync(path, "utf8")) : null;

/** Waits until the predicate holds for the stream file (or the deadline
 * passes; the caller decides). */
const until = async (predicate: () => boolean, timeoutMs = 10000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};

describe("the observer over a real run", () => {
  test("HCN_STATE_DIR survives all tests so spawned CLIs write to a sandbox, not the operator's state", async () => {
    // The earlier bug deleted and unset HCN_STATE_DIR after the first
    // test, leaving later fixtures running without an override: the
    // CLI then appends to the operator's real $XDG_STATE_HOME/hcn.
    // This test is the suite-level proof that the override persists
    // from the stub-dist import through every test that follows: a
    // hcn invocation writes commands.jsonl into the sandbox, not the
    // operator's state.
    const stateDir = process.env.HCN_STATE_DIR;
    if (!stateDir) throw new Error("HCN_STATE_DIR not set");
    const prefix = join(tmpdir(), "hcn-test-state-");
    expect(stateDir.startsWith(prefix)).toBe(true);
    // Drive a CLI to populate the ledger in the sandbox. The
    // spawn uses the same env setup as the real tests, so the
    // override is what reaches the CLI.
    const sandboxCli = ensureDist();
    spawnSync("node", [sandboxCli, "--help"], {
      encoding: "utf8",
      env: process.env,
      timeout: 15000,
    });
    expect(existsSync(join(stateDir, "commands.jsonl"))).toBe(true);
  });

  test("AC1: a clean run streams started, non-droppable events, and done", async () => {
    const box = fixture({ observerEnabled: true });
    const entry = { box, pids: [] as number[], started: true };
    boxes.push(entry);
    const result = spawnSync(
      "node",
      [box.cli, "run", "claude", "--json", "--cwd", box.cwdDir, "hi"],
      { encoding: "utf8", env: box.env, timeout: 30000 },
    );
    expect(result.status).toBe(0);
    // --json stdout shows the droppable events; the observer stream must
    // not carry them.
    const stdout = (result.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string });
    expect(stdout.some((e) => e.kind === "token")).toBe(true);
    expect(stdout.some((e) => e.kind === "progress")).toBe(true);
    expect(
      await until(
        () => existsSync(box.stream) && readFileSync(box.stream, "utf8").includes("EOF\n"),
      ),
    ).toBe(true);
    entry.pids.push(
      Number(readFileSync(box.harnessPid, "utf8").trim()),
      Number(readFileSync(box.observerPid, "utf8").trim()),
    );
    const records = parseStream(readFileSync(box.stream, "utf8"));
    const started = records[0] as Record<string, unknown>;
    expect(started.record).toBe("started");
    expect(started.schema).toBe("hcn-observer/1");
    expect(started.command).toBe("run");
    expect(started.cwd).toBe(box.cwdDir);
    expect(typeof started.invocationId).toBe("string");
    const kinds = records
      .filter((r) => r.record === "event")
      .map((r) => (r.event as { kind: string }).kind);
    expect(kinds).toEqual(["identity", "message", "done"]);
    expect(JSON.stringify(records)).not.toContain('"kind":"token"');
    expect(JSON.stringify(records)).not.toContain('"kind":"progress"');
    const done = records.at(-1)?.event as { kind: string; cause: string; exitCode: number };
    expect(done.cause).toBe("clean");
    expect(done.exitCode).toBe(0);
    const harnessEnv = JSON.parse(readFileSync(box.harnessEnv, "utf8")) as {
      HCN_INVOCATION_ID: string | null;
    };
    expect(harnessEnv.HCN_INVOCATION_ID).toBe(started.invocationId);
  });

  test("the caller's HCN_INVOCATION_ID never wins over hcn's", async () => {
    const box = fixture({ observerEnabled: true });
    boxes.push({ box, pids: [], started: true });
    const result = spawnSync(
      "node",
      [
        box.cli,
        "run",
        "claude",
        "--json",
        "--cwd",
        box.cwdDir,
        "--env",
        "HCN_INVOCATION_ID=caller-value",
        "hi",
      ],
      { encoding: "utf8", env: box.env, timeout: 30000 },
    );
    expect(result.status).toBe(0);
    expect(
      await until(
        () => existsSync(box.stream) && readFileSync(box.stream, "utf8").includes("EOF\n"),
      ),
    ).toBe(true);
    const liveBox2 = boxes[boxes.length - 1];
    if (!liveBox2) throw new Error("no current test box");
    liveBox2.pids.push(
      Number(readFileSync(box.harnessPid, "utf8").trim()),
      Number(readFileSync(box.observerPid, "utf8").trim()),
    );
    const records = parseStream(readFileSync(box.stream, "utf8"));
    const started = records[0] as { invocationId: string };
    expect(started.invocationId).not.toBe("caller-value");
    const harnessEnv = JSON.parse(readFileSync(box.harnessEnv, "utf8")) as {
      HCN_INVOCATION_ID: string | null;
    };
    expect(harnessEnv.HCN_INVOCATION_ID).toBe(started.invocationId);
  });

  test("an observer path that cannot spawn changes nothing (string-only enablement)", async () => {
    const clean = fixture({ observerEnabled: false });
    const missing = fixture({ observerEnabled: true, observerMissing: true });
    boxes.push({ box: clean, pids: [] }, { box: missing, pids: [] });
    const runArgs = (box: Box): string[] => [
      box.cli,
      "run",
      "claude",
      "--json",
      "--cwd",
      box.cwdDir,
      "hi",
    ];
    const cleanRun = spawnSync("node", runArgs(clean), {
      encoding: "utf8",
      env: clean.env,
      timeout: 30000,
    });
    const missingRun = spawnSync("node", runArgs(missing), {
      encoding: "utf8",
      env: missing.env,
      timeout: 30000,
    });
    expect(missingRun.status).toBe(cleanRun.status);
    expect(missingRun.stdout).toBe(cleanRun.stdout);
    expect(missingRun.stderr).toBe(cleanRun.stderr);
    // No observer output anywhere: the stub never ran.
    expect(existsSync(missing.stream)).toBe(false);
    expect(existsSync(missing.observerPid)).toBe(false);
  });

  test("an operator-set HCN_OBSERVER never reaches the spawned CLI (disabled case)", async () => {
    // A stand-in for an operator-configured machine: HCN_OBSERVER set
    // in the test process to an absolute stub that leaves proof it ran.
    // The fixture builds the child env from ...process.env, so without
    // the explicit delete the spawned CLI would inherit the value and
    // run the external command inside the disabled case. The stub lives
    // in its own fixture dir and is bound BEFORE fixture() runs, so the
    // spread really sees it - the proof construction depends on that
    // ordering.
    const observerDir = mkdtempSync(join(tmpdir(), "hcn-observer-marker-"));
    const observerStubPath = join(observerDir, "marker-observer.mjs");
    const marker = join(observerDir, "marker.ran");
    writeFileSync(
      observerStubPath,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nprocess.exit(0);\n`,
    );
    chmodSync(observerStubPath, 0o755);
    const previous = process.env.HCN_OBSERVER;
    process.env.HCN_OBSERVER = observerStubPath;
    try {
      const box = fixture({ observerEnabled: false });
      boxes.push({ box, pids: [] });
      // The direct proof: the env handed to the CLI carries no observer.
      expect(box.env.HCN_OBSERVER).toBeUndefined();
      expect(box.env.HCN_INVOCATION_ID).toBeUndefined();
      const result = spawnSync(
        "node",
        [box.cli, "run", "claude", "--json", "--cwd", box.cwdDir, "hi"],
        { encoding: "utf8", env: box.env, timeout: 30000 },
      );
      expect(result.status).toBe(0);
      // The observer is detached: a would-be observer may still be
      // starting when the CLI has exited. Give it a bounded window to
      // leave its marker before asserting none ever ran.
      expect(await until(() => existsSync(marker), 3000)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HCN_OBSERVER;
      else process.env.HCN_OBSERVER = previous;
      if (observerDir.startsWith(join(tmpdir(), "hcn-observer-marker-"))) {
        rmSync(observerDir, { recursive: true, force: true });
      }
    }
  });

  test("AC2: SIGTERM to the process group yields done with cause killed, and the detached observer survives", async () => {
    const box = fixture({ observerEnabled: true });
    boxes.push({ box, pids: [], started: true });
    const cli = spawn("node", [box.cli, "run", "claude", "--json", "--cwd", box.cwdDir, "hi"], {
      detached: true,
      env: { ...box.env, STUB_HARNESS_MODE: "sleep" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(cli.pid).toBeDefined();
    // Register the CLI's pid BEFORE any later assertion so a failing
    // assertion still reaches cleanup with the child pid recorded.
    const liveBox = boxes[boxes.length - 1];
    if (!liveBox) throw new Error("no current test box");
    if (!cli.pid) throw new Error("cli.pid not defined");
    liveBox.pids.push(cli.pid);
    // Wait for the harness and observer stub pids to land, then
    // register them too - same rule: the cleanup must always see the
    // recorded pids, not depend on a happy path reaching the end of
    // the test.
    const sawPids = await until(() => existsSync(box.harnessPid) && existsSync(box.observerPid));
    liveBox.pids.push(
      Number(readFileSync(box.harnessPid, "utf8").trim()),
      Number(readFileSync(box.observerPid, "utf8").trim()),
    );
    expect(sawPids).toBe(true);
    const sawIdentity = await until(() => {
      const stream = readStream(box.stream);
      return stream?.some((r) => r.record === "event") ?? false;
    });
    expect(sawIdentity).toBe(true);
    // A terminal signals the process group, not the bare pid.
    if (!cli.pid) throw new Error("cli.pid not defined");
    process.kill(-cli.pid, "SIGTERM");
    const cliGone = await waitExit(cli.pid, 5000);
    if (!cliGone) {
      throw new Error(`cli pid ${cli.pid} still alive after 5000ms (dir: ${box.dir})`);
    }
    // The detached observer still drains the stream to its EOF.
    expect(
      await until(
        () => existsSync(box.stream) && readFileSync(box.stream, "utf8").includes("EOF\n"),
        15000,
      ),
    ).toBe(true);
    const records = parseStream(readFileSync(box.stream, "utf8"));
    const doneRecord = records.filter((r) => r.record === "event").at(-1)?.event as {
      kind: string;
      cause: string;
      exitCode: number | null;
    };
    expect(doneRecord.kind).toBe("done");
    expect(doneRecord.cause).toBe("killed");
    expect(doneRecord.exitCode).toBeNull();
  });
});
