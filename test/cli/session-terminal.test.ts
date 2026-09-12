import { describe, expect, test, vi } from "vitest";
import { session } from "../../src/cli/session.js";

/** Drive the session command with stdout/stderr captured and process.exitCode
 * observed, the way the CLI tests do. */
const run = async (harness: string, args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
  // The command under test sets process.exitCode. Bun does not clear it when
  // you assign undefined, so a leaked code fails the whole run with every
  // test passing. Restore to 0, never to undefined.
  const before = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await session(harness, args);
    return {
      exitCode: process.exitCode,
      events: out
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return { raw: l };
          }
        }),
      stderr: err.join(""),
    };
  } finally {
    process.exitCode = before;
    if (process.exitCode === undefined) process.exitCode = 0;
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
};

describe("T08: a refused --json session still owes the stream its terminal pair", () => {
  test("a harness with no session mode writes failure + closed and exits 2", async () => {
    const r = await run("codex", ["--json"]);
    expect(r.exitCode).toBe(2);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ kind: "failure", class: "rejected" });
    expect(r.events[1]).toMatchObject({ kind: "closed", cause: "failed", exitCode: null });
    // The prose stays on stderr; stdout carries JSON only.
    expect(r.stderr).toContain("session mode");
  });

  test("the same refusal without --json writes prose and nothing on stdout", async () => {
    const r = await run("codex", []);
    expect(r.exitCode).toBe(2);
    expect(r.events).toHaveLength(0);
    expect(r.stderr).toContain("session mode");
  });

  test("an unknown flag writes failure + closed and exits 2", async () => {
    const r = await run("claude", ["--json", "--no-such-flag"]);
    expect(r.exitCode).toBe(2);
    expect(r.events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
    expect(r.events[0]).toMatchObject({ kind: "failure" });
  });

  test("an invalid --stall writes failure + closed and exits 2", async () => {
    const r = await run("claude", ["--json", "--stall", "not-a-number"]);
    expect(r.exitCode).toBe(2);
    expect(r.events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
    expect(r.stderr).toContain("invalid --stall");
  });

  test("a provider refusal on a harness without one writes failure + closed", async () => {
    const r = await run("claude", ["--json", "--provider", "lmstudio"]);
    expect(r.exitCode).toBe(2);
    expect(r.events[0]).toMatchObject({ kind: "failure", class: "rejected" });
    expect(r.events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
  });
});

describe("session --effort (validated per harness/model like a one-shot turn)", () => {
  test("an off-ladder effort writes failure + closed and exits 2, naming the ladder", async () => {
    const r = await run("claude", ["--json", "--effort", "bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.events[0]).toMatchObject({ kind: "failure", class: "rejected" });
    expect(r.events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
    expect(r.stderr).toContain('unknown effort for claude "bogus"');
    expect(r.stderr).toContain("supported: low, medium, high, xhigh, max");
  });

  test("the same refusal without --json writes prose and exits 2", async () => {
    const r = await run("claude", ["--effort", "bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.events).toHaveLength(0);
    expect(r.stderr).toContain('unknown effort for claude "bogus"');
  });

  test("the ladder is the harness's own: claude refuses pi's 'off'", async () => {
    const claudeRefusal = await run("claude", ["--effort", "off"]);
    expect(claudeRefusal.exitCode).toBe(2);
    expect(claudeRefusal.stderr).toContain("supported: low, medium, high, xhigh, max");
  });
});
