import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  beginCommandRecord,
  commandLedgerPath,
  markCrashed,
  recordExit,
} from "../../src/cli/ledger.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hcn-ledger-"));
  process.env.HCN_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.HCN_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const lines = (): Array<Record<string, unknown>> =>
  readFileSync(commandLedgerPath(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("durable command ledger", () => {
  test("start line before work, end line at exit, both on disk", () => {
    beginCommandRecord("run");
    recordExit(0);
    const entries = lines();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe("start");
    expect(entries[0]?.command).toBe("run");
    expect(typeof entries[0]?.pid).toBe("number");
    expect(typeof entries[0]?.at).toBe("string");
    expect(entries[1]?.event).toBe("end");
    expect(entries[1]?.exit).toBe(0);
    expect(entries[1]?.ok).toBe(true);
    expect(entries[1]?.crashed).toBeUndefined();
  });

  test("a bare invocation records command 'hcn'", () => {
    beginCommandRecord(undefined);
    recordExit(1);
    expect(lines()[0]?.command).toBe("hcn");
  });

  test("recordExit without a start is a no-op (programmatic dispatch)", () => {
    recordExit(0);
    expect(() => lines()).toThrow();
  });

  test("a crash after the stream ends still records the final code and crashed flag", () => {
    beginCommandRecord("run");
    // The stream finished cleanly, then an uncaught timer killed the
    // process: markCrashed + the exit handler's final code (4) are both
    // reflected in the single end line.
    markCrashed("Internal hcn failure: boom");
    recordExit(4);
    const entries = lines();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.crashed).toBe(true);
    expect(entries[1]?.exit).toBe(4);
    expect(entries[1]?.ok).toBe(false);
    expect(entries[1]?.message).toContain("boom");
  });

  test("an end line closes the record: a second exit writes nothing", () => {
    beginCommandRecord("run");
    recordExit(0);
    recordExit(4);
    expect(lines()).toHaveLength(2);
  });

  test("markCrashed without a start records nothing", () => {
    markCrashed("boom");
    recordExit(4);
    expect(() => lines()).toThrow();
  });

  test("a failed append never fails the command", () => {
    // A regular file where a directory is needed: mkdirSync must throw,
    // and the append failure is swallowed.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    process.env.HCN_STATE_DIR = join(blocker, "sub");
    expect(() => beginCommandRecord("run")).not.toThrow();
    expect(() => recordExit(0)).not.toThrow();
  });
});
