import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const assistant = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hello there" }] },
});
const result = JSON.stringify({ type: "result", subtype: "success" });

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const deps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig };
};

describe("streamTurn happy path (claude, fake spawner)", () => {
  test("spawns the built argv, yields identity once, messages, and a clean done", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);

    proc.emitLine(init);
    proc.emitLine(assistant);
    proc.emitLine(result);
    proc.exit(0);

    const events = await collect(turn);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("identity");
    expect(events.filter((e) => e.kind === "identity")).toHaveLength(1);
    expect(events.find((e) => e.kind === "message")).toMatchObject({
      role: "assistant",
      text: "hello there",
    });
    expect(events.at(-1)).toEqual({ kind: "done", exitCode: 0, cause: "clean" });

    // The spawned argv is the builder's, verbatim.
    expect(d.spawner.calls).toHaveLength(1);
    expect(d.spawner.calls[0]?.argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(d.spawner.calls[0]?.opts.stdin).toBe("inherit");
  });
});

const tokenDelta = (text: string) =>
  JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text } } });

describe("streamTurn behaviors (M3.1 boxes)", () => {
  test("token deltas stream as token events under the pinned flag set", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(init);
    proc.emitLine(tokenDelta("he"));
    proc.emitLine(tokenDelta("llo"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(
      events.filter((e) => e.kind === "token").map((e) => (e.kind === "token" ? e.text : "")),
    ).toEqual(["he", "llo"]);
  });

  test("torn and interleaved chunks reassemble into whole lines", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    const line = `${assistant}\n`;
    proc.emitChunk(`${init}\n${line.slice(0, 10)}`);
    proc.emitChunk(line.slice(10, 25));
    proc.emitChunk(line.slice(25));
    proc.exit(0);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "hello there" });
  });

  test("stall watchdog fires for every granularity (M13)", async () => {
    // 0.2.0: stallMs now arms at every granularity, not only none
    const tokenProc = new FakeProcess();
    const dTok = deps(tokenProc);
    const tokenTurn = collect(streamTurn(claudeCode, { prompt: "hi" }, { ...dTok, stallMs: 100 }));
    dTok.clock.advance(101);
    const tokenEvents = await tokenTurn;
    expect(dTok.sig.sent).toHaveLength(1);
    expect(tokenEvents.at(-1)).toMatchObject({ kind: "done", cause: "stall" });

    // A none-granularity invocation (no stream flags): watchdog also arms and fires.
    const bare = {
      ...claudeCode,
      launch: { ...claudeCode.launch, streamFlags: [] },
    };
    const stallProc = new FakeProcess();
    const dNone = deps(stallProc);
    const stallTurn = collect(streamTurn(bare, { prompt: "hi" }, { ...dNone, stallMs: 100 }));
    dNone.clock.advance(101);
    const stallEvents = await stallTurn;
    expect(dNone.sig.sent).toHaveLength(1);
    expect(dNone.sig.sent[0]?.sig).toBe("SIGTERM");
    expect(stallEvents.at(-1)).toMatchObject({ kind: "done", cause: "stall" });
  });

  test("a limit wall on stderr classifies the exit as limit", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(init);
    proc.emitStderr("You've hit your weekly limit · resets 2am");
    proc.exit(1);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "limit")).toMatchObject({ code: "weekly-limit" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "limit" });
  });

  test("a process that dies mid-turn yields done, never hangs", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(init);
    proc.exit(null); // killed externally, no exit code
    const events = await collect(turn);
    expect(events.at(-1)).toEqual({ kind: "done", exitCode: null, cause: "killed" });
  });

  test("a harness that never announces identity still completes with done", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(assistant);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.some((e) => e.kind === "identity")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  });

  test("crash exits classify as crash", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.exit(3);
    const events = await collect(turn);
    // 0.2.0: nonzero exit with no other classification is transport, with a failure on done
    const done = events.at(-1) as unknown as {
      kind: string;
      exitCode: number;
      cause: string;
      failure?: unknown;
    };
    expect(done.kind).toBe("done");
    expect(done.exitCode).toBe(3);
    expect((done as unknown as { failure?: { class: string } }).failure).toMatchObject({
      class: "transport",
    });
  });
});

describe("structured boundary events (observability)", () => {
  test("spawn and exit events are always-on, with redacted argv", async () => {
    const logged: Record<string, unknown>[] = [];
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(
      claudeCode,
      { prompt: "use sk-abcdefghij1234567890 to auth" },
      { ...d, log: (e) => logged.push(e) },
    );
    proc.emitLine(init);
    proc.exit(0);
    await collect(turn);
    const spawn = logged.find((e) => e.event === "spawn");
    const exit = logged.find((e) => e.event === "exit");
    expect(spawn).toBeDefined();
    expect(exit).toMatchObject({ cause: "clean", exitCode: 0 });
    expect(spawn?.turnId).toBe(exit?.turnId); // correlation survives
    expect(JSON.stringify(spawn?.argv)).not.toContain("sk-abcdefghij");
  });
});

describe("malformed resume id is a typed refusal (F-01)", () => {
  test("bad resume yields failure rejected + done failed, never spawns", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi", resume: "../../etc/passwd" }, d);
    const events = await collect(turn);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "invalid-option-value",
    });
    expect(events[1]).toMatchObject({ kind: "done", cause: "failed" });
    expect(d.spawner.calls).toHaveLength(0);
  });
});

describe("A-001 fixture replay (D-022)", () => {
  test("three turns of re-emitted init yield exactly one identity event", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = readFileSync(join(import.meta.dirname, "../fixtures/a001-raw.ndjson"), "utf8");
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") proc.emitLine(line);
    }
    proc.exit(0);
    const events = await collect(turn);
    expect(events.filter((e) => e.kind === "identity")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  });
});

describe("harness fixture replay (F-20)", () => {
  const cases: Array<{
    file: string;
    harness: (typeof claudeCode)["name"];
    exitCode: number;
    nonError: boolean;
  }> = [
    { file: "claude.ndjson", harness: "claude", exitCode: 0, nonError: true },
    { file: "codex.ndjson", harness: "codex", exitCode: 0, nonError: true },
    { file: "codex-tool.ndjson", harness: "codex", exitCode: 0, nonError: true },
    { file: "codex-filetool.ndjson", harness: "codex", exitCode: 0, nonError: true },
    { file: "pi.ndjson", harness: "pi", exitCode: 0, nonError: true },
    { file: "pi-tool.ndjson", harness: "pi", exitCode: 0, nonError: true },
    { file: "pi-autherror.ndjson", harness: "pi", exitCode: 1, nonError: false },
    { file: "muse.ndjson", harness: "muse", exitCode: 0, nonError: true },
    { file: "muse-tool.ndjson", harness: "muse", exitCode: 0, nonError: true },
    { file: "muse-readtool.ndjson", harness: "muse", exitCode: 0, nonError: true },
  ];

  test.each(cases)(
    "replays $file with exactly one identity and a terminal done",
    async ({ file, harness, exitCode, nonError }) => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { codexCli } = await import("../../src/knowledge/codex.js");
      const { piCli } = await import("../../src/knowledge/pi.js");
      const { museCode } = await import("../../src/knowledge/muse.js");
      const byName = { claude: claudeCode, codex: codexCli, pi: piCli, muse: museCode } as const;
      const descriptor = byName[harness as keyof typeof byName];
      const raw = readFileSync(join(import.meta.dirname, "../fixtures/harnesses", file), "utf8");
      const proc = new FakeProcess();
      const d = deps(proc);
      const turn = streamTurn(descriptor, { prompt: "hi" }, d);
      for (const line of raw.split("\n")) {
        if (line.trim() !== "") proc.emitLine(line);
      }
      proc.exit(exitCode);
      const events = await collect(turn);
      expect(events.filter((e) => e.kind === "identity")).toHaveLength(1);
      if (nonError) {
        const hasContent = events.some((e) => e.kind === "message" || e.kind === "token");
        expect(hasContent, `${file} should emit at least one message or token`).toBe(true);
      }
      expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
      expect(events.at(-1)?.kind).toBe("done");
    },
  );

  test("inventory: every .ndjson in test/fixtures/harnesses is covered", async () => {
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "../fixtures/harnesses");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ndjson"))
      .sort();
    const covered = new Set(cases.map((c) => c.file));
    const uncovered = files.filter((f) => !covered.has(f));
    expect(uncovered, `uncovered fixtures: ${uncovered.join(", ")}`).toEqual([]);
    expect(files.length).toBe(cases.length);
  });
});
