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

const boxes: { box: Box; pids: number[] }[] = [];

afterEach(async () => {
  for (const { box, pids } of boxes.splice(0)) {
    // Every recorded PID must be confirmed gone before the sandbox is
    // deleted; a live process fails the test and keeps the directory.
    for (const pid of pids) {
      if (pid > 0) await waitExit(pid, 5000);
    }
    const prefix = join(tmpdir(), "hcn-observer-run-");
    if (!box.dir.startsWith(prefix)) throw new Error(`refusing to delete ${box.dir}`);
    rmSync(box.dir, { recursive: true, force: true });
  }
  // stub-dist.ts creates an hcn-test-state-* directory at import time to
  // keep the command ledger out of the operator's state; this file's use
  // of it ends with the suite, so remove it under the same rule.
  const stateDir = process.env.HCN_STATE_DIR;
  const statePrefix = join(tmpdir(), "hcn-test-state-");
  if (stateDir !== undefined && stateDir.startsWith(statePrefix)) {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.HCN_STATE_DIR;
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
    ...(options.observerEnabled ? { HCN_OBSERVER: observerPath } : {}),
  };
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
  test("AC1: a clean run streams started, non-droppable events, and done", async () => {
    const box = fixture({ observerEnabled: true });
    boxes.push({ box, pids: [] });
    const pids = boxes[0]!.pids;
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
    pids.push(
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
    boxes.push({ box, pids: [] });
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
    boxes[boxes.length - 1]!.pids.push(
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

  test("AC2: SIGTERM to the process group yields done with cause killed, and the detached observer survives", async () => {
    const box = fixture({ observerEnabled: true });
    boxes.push({ box, pids: [] });
    const cli = spawn("node", [box.cli, "run", "claude", "--json", "--cwd", box.cwdDir, "hi"], {
      detached: true,
      env: { ...box.env, STUB_HARNESS_MODE: "sleep" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const sawIdentity = await until(() => {
      const stream = readStream(box.stream);
      return stream !== null && stream.some((r) => r.record === "event");
    });
    expect(sawIdentity).toBe(true);
    // A terminal signals the process group, not the bare pid.
    expect(cli.pid).toBeDefined();
    process.kill(-cli.pid!, "SIGTERM");
    const cliGone = await waitExit(cli.pid!, 5000);
    expect(cliGone).toBe(true);
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
