import { describe, expect, test, vi } from "vitest";
import { AsyncChannel } from "../../src/execution/channel.js";
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

  test("high-water abandonment releases the blocked stdout producer before child exit", async () => {
    let reportBlocked!: (blocked: { readonly push: Promise<void> }) => void;
    const producerBlocked = new Promise<{ readonly push: Promise<void> }>((resolve) => {
      reportBlocked = resolve;
    });
    const originalPush = AsyncChannel.prototype.push;
    const pushSpy = vi.spyOn(AsyncChannel.prototype, "push").mockImplementation(function (
      this: AsyncChannel<HarnessEvent>,
      event: HarnessEvent,
    ) {
      const push = originalPush.call(this, event);
      let settled = false;
      void push.then(() => {
        settled = true;
      });
      void Promise.resolve().then(() => {
        if (!settled) reportBlocked({ push });
      });
      return push;
    });
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal({ autoExit: false });
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    )[Symbol.asyncIterator]();
    const firstEvent = turn.next();
    const content = Array.from({ length: 1_100 }, (_, index) => ({
      type: "tool_use",
      name: `tool-${index}`,
      input: {},
    }));
    proc.emitChunk(`${JSON.stringify({ type: "assistant", message: { content } })}\n`);
    proc.emitLine(JSON.stringify({ type: "result", subtype: "success" }));

    try {
      await expect(firstEvent).resolves.toMatchObject({ value: { kind: "tool", name: "tool-0" } });
      const blocked = await producerBlocked;
      expect(proc.stdout.pullCount).toBe(1);

      const returned = turn.return?.();
      await expect(blocked.push).resolves.toBeUndefined();
      await proc.stdout.waitForPullCount(2);
      expect(proc.stdout.pullCount).toBe(2);

      proc.exit(null);
      await returned;
    } finally {
      pushSpy.mockRestore();
    }
  });

  test("a slow consumer drains every buffered event and receives exactly one done", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    )[Symbol.asyncIterator]();
    const firstEvent = turn.next();
    proc.emitLine(init);
    for (let index = 0; index < 500; index += 1) {
      proc.emitLine(
        JSON.stringify({
          type: "stream_event",
          event: { delta: { type: "text_delta", text: `chunk-${index}` } },
        }),
      );
    }
    proc.emitLine(JSON.stringify({ type: "result", subtype: "success" }));
    proc.exit(0);

    const first = await firstEvent;
    await tick();
    const events = first.value === undefined ? [] : [first.value];
    while (true) {
      const next = await turn.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(events.filter((event) => event.kind === "token")).toHaveLength(500);
    expect(events.filter((event) => event.kind === "done")).toEqual([
      { kind: "done", exitCode: 0, cause: "clean" },
    ]);
  });

  test("held-pipe abandonment returns only after output disposal and both pumps settle", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const clock = new FakeClock();
    const logged: Record<string, unknown>[] = [];
    const signal = (): void => {
      proc.exitWithoutClosing(null);
    };
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      {
        spawn: spawner.spawn,
        clock,
        signal,
        turnId: "held-pipe-turn",
        log: (event) => logged.push(event),
      },
    );
    proc.emitLine(init);

    for await (const event of turn) {
      if (event.kind === "identity") break;
    }

    expect(proc.outputDisposed).toBe(true);
    expect(proc.hasExited).toBe(true);
    expect(proc.stdout.activeReaderCount).toBe(0);
    expect(proc.stderr.activeReaderCount).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
    expect(
      logged.filter(
        (event) => event.event === "abandoned" || event.event === "abandonment_settled",
      ),
    ).toEqual([
      {
        event: "abandoned",
        turnId: "held-pipe-turn",
        harness: "claude",
      },
      {
        event: "abandonment_settled",
        turnId: "held-pipe-turn",
        harness: "claude",
        exitCode: null,
        outputDisposed: true,
      },
    ]);
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

describe("crash context surfaces as a stream error", () => {
  test("a pre-disposal premature-close pump failure stays visible", async () => {
    const logged: Record<string, unknown>[] = [];
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const clock = new FakeClock();
    const signal = (): void => {
      proc.exitWithoutClosing(null);
    };
    const pending = collect(
      streamTurn(
        claudeCode,
        { prompt: "hi" },
        {
          spawn: spawner.spawn,
          clock,
          signal,
          log: (event) => logged.push(event),
        },
      ),
    );
    const failure = new Error("synthetic premature close") as NodeJS.ErrnoException;
    failure.code = "ERR_STREAM_PREMATURE_CLOSE";
    proc.failStdout(failure);

    const events = await pending;
    expect(events.find((event) => event.kind === "error")).toMatchObject({
      message: expect.stringContaining("stdout pump failed: synthetic premature close"),
    });
    expect(logged.find((event) => event.event === "output_pump_failed")).toMatchObject({
      stream: "stdout",
      issue: "read-failed",
    });
    expect(events.findIndex((event) => event.kind === "error")).toBeLessThan(
      events.findIndex((event) => event.kind === "done"),
    );
    expect(proc.outputDisposed).toBe(true);
    expect(proc.stderr.activeReaderCount).toBe(0);
  });

  test("a crash with stderr yields an error event carrying the tail, then done", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitStderr("Fatal: kaboom");
    proc.exit(1);
    const events = await collect(turn);
    const errorAt = events.findIndex((e) => e.kind === "error");
    expect(errorAt).toBeGreaterThan(-1);
    expect(events[errorAt]).toMatchObject({ message: expect.stringContaining("kaboom") });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "crash" });
    // error precedes done
    expect(errorAt).toBe(events.length - 2);
  });

  test("a clean exit with stray stderr emits no error event", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitStderr("just a warning");
    proc.exit(0);
    const events = await collect(turn);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  });
});
