import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { LINE_MAX, LineBuffer } from "../../src/execution/lines.js";
import {
  KILL_GRACE_MS,
  PIPE_GRACE_MS,
  redactArgv,
  streamTurn,
} from "../../src/execution/stream-turn.js";
import { buildResumeArgv } from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("M3.1 boundary-review regression pins", () => {
  test("torn multi-byte UTF-8 decodes whole, never as replacement characters", async () => {
    const text = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "café 日本語 ✅" }] },
    });
    const bytes = new TextEncoder().encode(`${init}\n${text}\n`);
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    // Tear inside the multi-byte sequences.
    proc.stdout.push(bytes.slice(0, bytes.length - 20) as unknown as string);
    proc.stdout.push(bytes.slice(bytes.length - 20) as unknown as string);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "café 日本語 ✅" });
  });

  test("an abandoned turn signals the child and stops - never a leaked process", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitLine(init);
    for await (const event of turn) {
      if (event.kind === "identity") break; // consumer walks away mid-turn
    }
    await tick();
    expect(sig.sent.length).toBeGreaterThan(0);
    expect(sig.sent[0]?.sig).toBe("SIGTERM");
  });

  test("watchdog never flips a completed turn to stall or signals a dead process", async () => {
    const bare = { ...claudeCode, launch: { ...claudeCode.launch, streamFlags: [] } };
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const pending = collect(
      streamTurn(
        bare,
        { prompt: "hi" },
        { spawn: spawner.spawn, clock, signal: sig.signal, stallMs: 100 },
      ),
    );
    proc.exit(0);
    await tick();
    clock.advance(10_000); // timer would fire long after the clean exit
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
    expect(sig.sent).toHaveLength(0);
  });

  test("a spawn that cannot start yields error + done(127 crash), never throws", async () => {
    const clock = new FakeClock();
    const sig = fakeSignal();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      {
        spawn: () => {
          throw new Error("ENOENT: claude not found");
        },
        clock,
        signal: sig.signal,
      },
    );
    const events = await collect(turn);
    expect(events[0]).toMatchObject({ kind: "error" });
    expect(events.at(-1)).toEqual({ kind: "done", exitCode: 127, cause: "crash" });
  });

  test("redaction keeps identifiers and masks content: session ids log verbatim, prompts never", () => {
    const prompt = "Refactor billing and tell me the customer email for account 88213";
    const argv = buildResumeArgv(claudeCode, { sessionId: sid, prompt });
    const redacted = redactArgv(argv, prompt);
    expect(redacted).toContain(sid); // the correlating identifier survives
    expect(redacted.join(" ")).not.toContain("customer email");
    expect(redacted).toContain(`[prompt:${prompt.length}ch]`);
    // Paths and model ids are identifiers, not secrets.
    expect(redactArgv(["/Users/kevin/dev/harness-cli-normalizer/src/execution"])).toEqual([
      "/Users/kevin/dev/harness-cli-normalizer/src/execution",
    ]);
    expect(redactArgv(["sk-abcdefghij1234567890"])).toEqual(["[redacted]"]);
  });

  test("crash exits carry a bounded stderr tail on the exit boundary log", async () => {
    const logged: Record<string, unknown>[] = [];
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal, log: (e) => logged.push(e) },
    );
    proc.emitStderr("TypeError: boom");
    proc.emitStderr("    at main.ts:12");
    proc.exit(1);
    await collect(turn);
    const exit = logged.find((e) => e.event === "exit");
    expect(exit?.stderrTail).toEqual(["TypeError: boom", "    at main.ts:12"]);
  });

  test("a child that ignores SIGTERM gets SIGKILL after the grace budget", async () => {
    const bare = { ...claudeCode, launch: { ...claudeCode.launch, streamFlags: [] } };
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal({ autoExit: false });
    const clock = new FakeClock();
    const pending = collect(
      streamTurn(
        bare,
        { prompt: "hi" },
        { spawn: spawner.spawn, clock, signal: sig.signal, stallMs: 100 },
      ),
    );
    await tick();
    clock.advance(101); // watchdog fires -> SIGTERM (ignored)
    await tick();
    clock.advance(KILL_GRACE_MS + 1); // escalation -> SIGKILL (fake dies)
    const events = await pending;
    expect(sig.sent.map((s) => s.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "stall" });
  });

  test("pipes held open past exit close out after grace with the exit code in hand", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const logged: Record<string, unknown>[] = [];
    const pending = collect(
      streamTurn(
        claudeCode,
        { prompt: "hi" },
        { spawn: spawner.spawn, clock, signal: sig.signal, log: (e) => logged.push(e) },
      ),
    );
    proc.emitLine(init);
    proc.exitWithoutClosing(0); // a grandchild holds the pipes
    await tick();
    clock.advance(PIPE_GRACE_MS + 1);
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
    expect(logged.find((e) => e.event === "exit")?.pipesOpenAtExit).toBe(true);
  });

  test("a malformed identity announcement surfaces as an error event", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitLine(JSON.stringify({ type: "system", subtype: "init", session_id: null }));
    proc.exit(0);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      message: expect.stringContaining("malformed"),
    });
  });

  test("an over-long line is discarded whole, never parsed from a lucky split", () => {
    const lines = new LineBuffer();
    expect(lines.push(`x`.repeat(LINE_MAX + 10))).toEqual([]);
    // The rest of the oversized line and its terminator are discarded...
    expect(lines.push(`yyy\n${JSON.stringify({ ok: true })}\n`)).toEqual([
      JSON.stringify({ ok: true }),
    ]);
  });
});
