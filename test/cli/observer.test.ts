/**
 * The run lifecycle observer, unit seams (ADR 0011, RFC-03 slice 11).
 * Enablement, the harness env override, the record stream shapes, and the
 * never-fail contract. Every spawned observer is a stub node script that
 * mirrors its stdin lines into a file and exits on stdin EOF; each test
 * reaps it before returning. No real harness, no model, no network.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRunObserver, INVOCATION_ID_ENV, OBSERVER_ENV } from "../../src/cli/observer.js";
import type { HarnessEvent } from "../../src/execution/events.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env[OBSERVER_ENV];
  delete process.env.STUB_OUT;
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

  test("a record over 1 MiB serialized becomes a skipped marker", async () => {
    const dir = fixture();
    const command = installStub(dir);
    process.env[OBSERVER_ENV] = command;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const observer = createRunObserver("claude", dir);
    observer.launched("inv-4", "2026-09-28T03:00:00.000Z");
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

  test("explicit end closes the stream; cwd falls back to the invocation directory", async () => {
    const dir = fixture();
    const command = installStub(dir);
    process.env[OBSERVER_ENV] = command;
    process.env.STUB_OUT = join(dir, "stream.ndjson");
    const observer = createRunObserver("claude", undefined);
    observer.launched("inv-2", "2026-09-28T03:00:00.000Z");
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
