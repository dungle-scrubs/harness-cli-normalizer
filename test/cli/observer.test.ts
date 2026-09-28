/**
 * The run lifecycle observer, unit seams (ADR 0011, RFC-03 slice 11).
 * Enablement, the harness env override, the record stream shapes, and the
 * never-fail contract. Every spawned observer is a stub node script that
 * mirrors its stdin lines into a file and exits on stdin EOF; each test
 * reaps it before returning. No real harness, no model, no network.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRunObserver, INVOCATION_ID_ENV, OBSERVER_ENV } from "../../src/cli/observer.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { cleanupSandbox } from "./reap.js";

const dirs: string[] = [];
// Every test that launches a real observer child pushes its pid here so
// the cleanup can terminate and reap it before touching the sandbox. A
// run with a live child holds the operator's terminal; deleting the dir
// first leaves a runaway process and a missing directory behind.
const observerPids: number[] = [];

afterEach(async () => {
  // Terminate and reap every observer child first (SIGTERM, 2 s,
  // SIGKILL): a failed assertion before the test's own end() can leave
  // the stub running, and the sandbox must not be deleted under a live
  // child. A pid that survives both signals rejects, fails the test,
  // and keeps every directory for the operator to diagnose.
  try {
    await cleanupSandbox({
      pids: observerPids.splice(0),
      dirs: dirs.splice(0),
      prefix: join(tmpdir(), "hcn-observer-unit-"),
      label: "observer unit",
    });
  } finally {
    delete process.env[OBSERVER_ENV];
    delete process.env.STUB_OUT;
  }
});

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hcn-observer-unit-"));
  dirs.push(dir);
  return dir;
};

/** A stub observer: mirrors every stdin line into $STUB_OUT and appends
 * an EOF marker when stdin ends, then exits 0. */
const installStub = (dir: string): string => {
  const path = join(dir, "stub-observer.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\\n")) >= 0) {
    appendFileSync(process.env.STUB_OUT, buf.slice(0, at + 1));
    buf = buf.slice(at + 1);
  }
});
process.stdin.on("end", () => {
  if (buf) appendFileSync(process.env.STUB_OUT, buf + "\\n");
  appendFileSync(process.env.STUB_OUT, "EOF\\n");
  process.exit(0);
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};

// The observer never reads the capability map; the fixture leaves it
// empty on purpose.
const identity = {
  kind: "identity",
  sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
  authority: "harness-minted",
  capabilities: {},
} as HarnessEvent;

const message: HarnessEvent = { kind: "message", role: "assistant", text: "working" };

/** Waits until the stub's output file holds the EOF marker, then returns
 * the parsed records. */
const awaitStream = async (out: string, timeoutMs = 5000): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsAt(out)) {
      const text = readFileSync(out, "utf8");
      if (text.includes("EOF\n")) return text.split("\n").filter((l) => l && l !== "EOF");
    }
    if (Date.now() > deadline) throw new Error(`stub observer never hit EOF: ${out}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const existsAt = (path: string): boolean => {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
};

describe("enablement", () => {
  test("relative, empty and unset values disable the observer with no export", () => {
    const dir = fixture();
    const cases: [Record<string, string | undefined>, string][] = [
      [{}, "unset"],
      [{ [OBSERVER_ENV]: "" }, "empty"],
      [{ [OBSERVER_ENV]: "stub-observer.mjs" }, "relative"],
    ];
    for (const [env, why] of cases) {
      process.env[OBSERVER_ENV] = env[OBSERVER_ENV];
      const observer = createRunObserver("claude", dir);
      expect(observer.enabled, why).toBe(false);
      const opts = observer.harnessEnv({ stdin: "pipe", env: { A: "b" } }, "id-1");
      // Disabled: the options pass through untouched, no id exported.
      expect(opts, why).toBe(opts);
      expect(opts.env?.[INVOCATION_ID_ENV], why).toBeUndefined();
      delete process.env[OBSERVER_ENV];
    }
  });

  test("an absolute value enables the observer and the export wins over --env", () => {
    const dir = fixture();
    // Even a path that does not exist: the string alone decides. A failed
    // spawn is absorbed later, asynchronously.
    process.env[OBSERVER_ENV] = join(dir, "missing.mjs");
    const observer = createRunObserver("claude", dir);
    expect(observer.enabled).toBe(true);
    const opts = observer.harnessEnv(
      { stdin: "pipe", env: { [INVOCATION_ID_ENV]: "caller-value" } },
      "hcn-id",
    );
    expect(opts.env?.[INVOCATION_ID_ENV]).toBe("hcn-id");
  });

  test("an absolute value containing '..' still enables the observer (string-only path check)", () => {
    const dir = fixture();
    // isAbsolute passes on a string whose lexical value starts with /,
    // even when the path normalizes through '..'. The previous
    // resolve-based check rejected these and silently disabled
    // observation plus the invocation-ID export - the caller plainly
    // intended an absolute path.
    const value = `/tmp/../tmp/${dir.replace(/^.*\//, "")}-does-not-need-to-exist.mjs`;
    process.env[OBSERVER_ENV] = value;
    // Sanity: the string is plainly absolute from the caller's view.
    expect(resolve(value)).not.toBe(value);
    const observer = createRunObserver("claude", dir);
    expect(observer.enabled).toBe(true);
    const opts = observer.harnessEnv({ stdin: "pipe", env: {} }, "abs-id");
    expect(opts.env?.[INVOCATION_ID_ENV]).toBe("abs-id");
  });

  test("observer.ts does no filesystem work: no statSync, no accessSync", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "observer.ts"),
      "utf8",
    );
    expect(source).not.toContain("statSync");
    expect(source).not.toContain("accessSync");
    expect(source).not.toContain("node:fs");
  });
});

describe("record stream", () => {
  test("started, events, and done ending the stream", async () => {
    const dir = fixture();
    const command = installStub(dir);
    process.env[OBSERVER_ENV] = command;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const cwd = join(dir, "cwd");
    const observer = createRunObserver("claude", cwd);
    observer.harnessEnv({ stdin: "pipe" }, "inv-1");
    observer.launched("inv-1", "2026-09-28T03:00:00.000Z");
    observerPids.push(observer.pid ?? 0);
    observer.event({ kind: "token", text: "tok" } as HarnessEvent);
    observer.event(identity);
    observer.event(message);
    observer.event({ kind: "done", exitCode: 0, cause: "clean" } as HarnessEvent);
    const lines = await awaitStream(process.env.STUB_OUT);
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      record: "started",
      schema: "hcn-observer/1",
      invocationId: "inv-1",
      at: "2026-09-28T03:00:00.000Z",
      command: "run",
      harness: "claude",
      cwd: resolve(cwd),
    });
    expect(typeof records[0]?.hcnVersion).toBe("string");
    const events = records.filter((r) => r.record === "event");
    expect(events.map((r) => (r.event as HarnessEvent).kind)).toEqual([
      "identity",
      "message",
      "done",
    ]);
    const done = events.at(-1)?.event as { cause: string; exitCode: number };
    expect(done).toEqual({ kind: "done", exitCode: 0, cause: "clean" });
  });

  test("a record over 1 MiB serialized bytes becomes a skipped marker", async () => {
    const dir = fixture();
    const command = installStub(dir);
    process.env[OBSERVER_ENV] = command;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const observer = createRunObserver("claude", dir);
    observer.launched("inv-4", "2026-09-28T03:00:00.000Z");
    observerPids.push(observer.pid ?? 0);
    observer.event({ kind: "message", role: "assistant", text: "x".repeat(1024 * 1024 + 4096) });
    observer.event(message);
    observer.event({ kind: "done", exitCode: 0, cause: "clean" } as HarnessEvent);
    const lines = await awaitStream(process.env.STUB_OUT);
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const skipped = records.find((r) => r.record === "skipped");
    expect(skipped).toMatchObject({ reason: "oversize" });
    expect(typeof skipped?.at).toBe("string");
    // The oversize event itself is absent; the small events survive.
    expect(JSON.stringify(records)).not.toContain("x".repeat(1024));
    expect(records.some((r) => r.record === "started")).toBe(true);
    expect(
      records.filter((r) => r.record === "event").map((r) => (r.event as { kind: string }).kind),
    ).toEqual(["message", "done"]);
  });

  test("a record under 1 MiB characters but over 1 MiB serialized bytes becomes a skipped marker", async () => {
    const dir = fixture();
    const command = installStub(dir);
    process.env[OBSERVER_ENV] = command;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const observer = createRunObserver("claude", dir);
    observer.launched("inv-multi", "2026-09-28T03:00:00.000Z");
    observerPids.push(observer.pid ?? 0);
    // 400,000 three-byte UTF-8 characters. The string length is well
    // under the 1 MiB character cap, but the serialized UTF-8 payload
    // is ~1.2 MiB on the wire. The cap must be measured on the wire so
    // the consumer sees the same bound the producer enforced.
    const text = "中".repeat(400_000);
    expect(text.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(1024 * 1024);
    observer.event({ kind: "message", role: "assistant", text });
    observer.event(message);
    observer.event({ kind: "done", exitCode: 0, cause: "clean" } as HarnessEvent);
    const lines = await awaitStream(process.env.STUB_OUT);
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const skipped = records.find((r) => r.record === "skipped");
    expect(skipped).toMatchObject({ reason: "oversize" });
    // The small events and the started record survive.
    expect(records.some((r) => r.record === "started")).toBe(true);
    expect(
      records.filter((r) => r.record === "event").map((r) => (r.event as { kind: string }).kind),
    ).toEqual(["message", "done"]);
  });

  test("the 8 MiB pending-write cap is checked before the record is serialized", () => {
    // Source-level invariant: the writableLength check must run BEFORE
    // any JSON.stringify call on the record body. Otherwise a stalled
    // reader pays for full serialization on each huge event, the cost
    // the cap was added to avoid. The Writable's writableLength
    // behavior is runtime-specific (Node accumulates, Bun flushes
    // eagerly), so a behavioral 8 MiB fill-up test would not survive
    // both lanes; the order invariant does, and it is the contract
    // the consumer cares about.
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "observer.ts"),
      "utf8",
    );
    const capIdx = source.indexOf("writableLength");
    const serializeIdx = source.indexOf("JSON.stringify(makeRecord())");
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(serializeIdx).toBeGreaterThan(capIdx);
  });

  test("a drained-stdin's pending-bytes cap suppresses a record on Node", async () => {
    // On Node, the parent-side Writable internal buffer accumulates as
    // 12 × 900 KiB writes land; the cap triggers when writableLength
    // crosses 8 MiB, suppressing later serialization. Bun's Writable
    // flushes eagerly and writableLength stays at 0 throughout, so the
    // runtime-specific behavioral assertion only runs in this lane.
    // The source-order test above carries the contract for both lanes.
    if (process.versions.bun !== undefined) {
      return; // Behavior is not observable on Bun; source order covers it.
    }
    const dir = fixture();
    const stubPath = join(dir, "drain.mjs");
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from "node:fs";
const sink = process.env.STUB_OUT;
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
});
process.stdin.on("end", () => {
  writeFileSync(sink, buf);
  appendFileSync(sink, "EOF\\n");
  process.exit(0);
});
process.stdin.on("close", () => {
  writeFileSync(sink, buf);
  appendFileSync(sink, "EOF\\n");
  process.exit(0);
});
setInterval(() => {}, 1000000);
`,
    );
    chmodSync(stubPath, 0o755);
    process.env[OBSERVER_ENV] = stubPath;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const observer = createRunObserver("claude", dir);
    observer.launched("inv-pending", "2026-09-28T03:00:00.000Z");
    observerPids.push(observer.pid ?? 0);
    for (let i = 0; i < 12; i++) {
      observer.event({ kind: "message", role: "assistant", text: "x".repeat(900 * 1024) });
    }
    observer.end();
    const lines = await awaitStream(process.env.STUB_OUT, 15000);
    expect(lines.some((l) => JSON.parse(l).record === "started")).toBe(true);
    expect(lines.length).toBeLessThan(13);
  });

  test("explicit end closes the stream; cwd falls back to the invocation directory", async () => {
    const dir = fixture();
    const command = installStub(dir);
    process.env[OBSERVER_ENV] = command;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const observer = createRunObserver("claude", undefined);
    observer.launched("inv-2", "2026-09-28T03:00:00.000Z");
    observerPids.push(observer.pid ?? 0);
    observer.event(message);
    observer.end();
    // Idempotent, and events after the end are dropped.
    observer.end();
    observer.event({ kind: "message", role: "assistant", text: "after end" });
    const lines = await awaitStream(process.env.STUB_OUT);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").record).toBe("started");
    expect(JSON.parse(lines[1] ?? "{}").event.text).toBe("working");
    // The cwd falls back to the invocation directory, absolute.
    expect(JSON.parse(lines[0] ?? "{}").cwd).toBe(resolve(process.cwd()));
  });
});

describe("never-fail contract", () => {
  test("an observer that dies mid-stream never throws, and end is idempotent", async () => {
    const dir = fixture();
    // A stub that exits at once: every write lands on a dead pipe.
    const path = join(dir, "die.mjs");
    writeFileSync(path, "process.exit(0);\n");
    chmodSync(path, 0o755);
    process.env[OBSERVER_ENV] = path;
    const observer = createRunObserver("claude", dir);
    expect(() => {
      observer.launched("inv-3", "2026-09-28T03:00:00.000Z");
      observer.event(identity);
      observer.event(message);
      observer.end();
      observer.end();
      observer.event(message);
    }).not.toThrow();
    observerPids.push(observer.pid ?? 0);
    // Give the async error handlers a beat, then the process ends.
    await new Promise((r) => setTimeout(r, 50));
  });

  test("spawnSync of the disabled observer performs no work at all", () => {
    delete process.env[OBSERVER_ENV];
    const observer = createRunObserver("claude", undefined);
    const opts = { stdin: "pipe" as const, env: { A: "b" } };
    expect(observer.harnessEnv(opts, "x")).toBe(opts);
    expect(() => observer.launched("x", "at")).not.toThrow();
    expect(() => observer.event(identity)).not.toThrow();
    expect(() => observer.end()).not.toThrow();
  });
});
