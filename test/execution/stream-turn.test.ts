import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
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
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });

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

  test("turnTimeoutMs wall-clock budget escalates SIGTERM then SIGKILL and classifies timeout (F-19)", async () => {
    const proc = new FakeProcess();
    const sig = fakeSignal({ autoExit: false });
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const pending = collect(
      streamTurn(
        claudeCode,
        { prompt: "hi" },
        { spawn: spawner.spawn, clock, signal: sig.signal, turnTimeoutMs: 100 },
      ),
    );
    await Promise.resolve();
    clock.advance(101);
    await Promise.resolve();
    expect(sig.sent.map((s) => s.sig)).toEqual(["SIGTERM"]);
    clock.advance(5_000 + 1);
    await Promise.resolve();
    expect(sig.sent.map((s) => s.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    proc.exit(null);
    const events = await pending;
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done).toMatchObject({ kind: "done", cause: "killed" });
    expect(done.failure).toMatchObject({ class: "timeout" });
    expect(done.failure?.retryable).toBe(false);
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
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: null, cause: "killed" });
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

  test("F-05 abort signal escalates SIGTERM and yields killed with no failure", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    // use non-autoExit so we can assert signal before exit
    const sig = fakeSignal({ autoExit: false });
    const controller = new AbortController();
    const turn = collect(
      streamTurn(
        claudeCode,
        { prompt: "hi", signal: controller.signal },
        { ...d, signal: sig.signal },
      ),
    );
    // driver aborts after spawn
    // allow spawn to be recorded
    await Promise.resolve();
    controller.abort();
    // abort should have signaled SIGTERM
    expect(sig.sent.some((s) => s.sig === "SIGTERM")).toBe(true);
    proc.exit(null);
    const events = await turn;
    const done = events.at(-1) as unknown as {
      kind: string;
      exitCode: number | null;
      cause: string;
      failure?: unknown;
    };
    expect(done).toMatchObject({ kind: "done", exitCode: null, cause: "killed" });
    expect((done as unknown as { failure?: unknown }).failure).toBeUndefined();
    expect(events.some((e) => e.kind === "failure")).toBe(false);
  });

  test("F-05 aborted nonzero exit 143 is killed not crash and no failure", async () => {
    const proc = new FakeProcess();
    const sig = fakeSignal({ autoExit: false });
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const controller = new AbortController();
    controller.abort();
    const p = collect(
      streamTurn(
        claudeCode,
        { prompt: "hi", signal: controller.signal },
        { spawn: spawner.spawn, clock, signal: sig.signal },
      ),
    );
    // already aborted at spawn time, should have sent SIGTERM immediately
    expect(sig.sent.some((s) => s.sig === "SIGTERM")).toBe(true);
    proc.exit(143);
    const ev = await p;
    const done = ev.at(-1) as unknown as { kind: string; cause: string; failure?: unknown };
    expect(done.cause).toBe("killed");
    expect((done as unknown as { failure?: unknown }).failure).toBeUndefined();
    expect(ev.some((e) => e.kind === "failure")).toBe(false);
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
    { file: "pi-unreachable.ndjson", harness: "pi", exitCode: 0, nonError: false },
    { file: "pi-noauth.ndjson", harness: "pi", exitCode: 1, nonError: false },
    { file: "pi-model-unavailable.ndjson", harness: "pi", exitCode: 0, nonError: false },
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
      if (file === "pi-noauth.ndjson") {
        const stderrRaw = readFileSync(
          join(import.meta.dirname, "../fixtures/harnesses", "pi-noauth.stderr"),
          "utf8",
        );
        for (const line of stderrRaw.split("\n")) {
          if (line.trim() !== "") proc.emitStderr(line);
        }
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

  test("pi-unreachable yields exactly one transport failure and failed done", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { piCli } = await import("../../src/knowledge/pi.js");
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-unreachable.ndjson"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(piCli, { prompt: "hi" }, d);
    for (const line of raw.split("\n")) if (line.trim() !== "") proc.emitLine(line);
    proc.exit(0);
    const events = await collect(turn);
    const failures = events.filter((e) => e.kind === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ class: "transport", retryable: true });
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.cause).toBe("failed");
    expect(done.failure).toMatchObject({ class: "transport" });
  });

  test("pi-noauth yields auth not-logged-in failure and failed done", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { piCli } = await import("../../src/knowledge/pi.js");
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-noauth.ndjson"),
      "utf8",
    );
    const stderrRaw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-noauth.stderr"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(piCli, { prompt: "hi" }, d);
    for (const line of raw.split("\n")) if (line.trim() !== "") proc.emitLine(line);
    for (const line of stderrRaw.split("\n")) if (line.trim() !== "") proc.emitStderr(line);
    proc.exit(1);
    const events = await collect(turn);
    const failure = events.find((e) => e.kind === "failure") as Extract<
      HarnessEvent,
      { kind: "failure" }
    >;
    expect(failure).toMatchObject({ class: "auth", authKind: "not-logged-in", retryable: true });
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.cause).toBe("failed");
    expect(done.failure).toMatchObject({ class: "auth" });
  });

  test("pi-model-unavailable yields exactly one unavailable failure and failed done", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { piCli } = await import("../../src/knowledge/pi.js");
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-model-unavailable.ndjson"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(piCli, { prompt: "hi" }, d);
    for (const line of raw.split("\n")) if (line.trim() !== "") proc.emitLine(line);
    proc.exit(0);
    const events = await collect(turn);
    const failures = events.filter((e) => e.kind === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ class: "unavailable", retryable: true });
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.cause).toBe("failed");
    expect(done.failure).toMatchObject({ class: "unavailable" });
  });

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

describe("F-09 capabilities with no model use curated source and argv granularity", () => {
  test("claude no model yields token and curated", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(init);
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const id = events.find((e) => e.kind === "identity") as unknown as {
      kind: string;
      capabilities: { streaming: string; source: string };
    };
    expect(id.capabilities.streaming).toBe("token");
    expect(id.capabilities.source).toBe("curated");
  });
  test("pi no model yields token and curated", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(piCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "session", id: sid }));
    proc.emitLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const id = events.find((e) => e.kind === "identity") as unknown as {
      capabilities: { streaming: string; source: string };
    };
    expect(id?.capabilities.streaming).toBe("token");
    expect(id?.capabilities.source).toBe("curated");
  });
  test("codex no model yields message and curated", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(codexCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: sid }));
    proc.exit(0);
    const events = await collect(turn);
    const id = events.find((e) => e.kind === "identity") as unknown as {
      capabilities: { streaming: string; source: string };
    };
    expect(id?.capabilities.streaming).toBe("message");
    expect(id?.capabilities.source).toBe("curated");
  });
  test("muse no model yields token and curated", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(museCode, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ stream: { id: sid } }));
    proc.exit(0);
    const events = await collect(turn);
    const id = events.find((e) => e.kind === "identity") as unknown as {
      capabilities: { streaming: string; source: string };
    };
    expect(id?.capabilities.streaming).toBe("token");
    expect(id?.capabilities.source).toBe("curated");
  });
  test("unknown model still degrades to unknown", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(
      piCli,
      { prompt: "hi", model: "unknown-provider/unknown-model-xyz" },
      d,
    );
    proc.emitLine(JSON.stringify({ type: "session", id: sid }));
    proc.exit(0);
    const events = await collect(turn);
    const id = events.find((e) => e.kind === "identity") as unknown as {
      capabilities: { streaming: string; source: string };
    };
    expect(id?.capabilities.source).toBe("unknown");
    expect(id?.capabilities.streaming).toBe("none");
  });

  test("F-23 pi resume warns create-on-missing before spawn", async () => {
    const resume = "11111111-1111-4111-8111-111111111111";
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(piCli, { prompt: "hi", resume }, d);
    proc.emitLine(JSON.stringify({ type: "session", id: resume }));
    proc.exit(0);
    const events = await collect(turn);
    const firstError = events.find((e) => e.kind === "error") as unknown as
      | { message: string }
      | undefined;
    expect(firstError?.message).toContain("pi creates a new session");
    expect(firstError?.message).toContain(resume);
    const museProc = new FakeProcess();
    const museD = deps(museProc);
    const museTurn = streamTurn(museCode, { prompt: "hi", resume }, museD);
    museProc.emitLine(JSON.stringify({ stream: { id: resume } }));
    museProc.exit(0);
    const museEvents = await collect(museTurn);
    const museFirst = museEvents.find((e) => e.kind === "error") as unknown as
      | { message: string }
      | undefined;
    expect(museFirst?.message).toContain("muse creates a new session");
  });

  test("F-68 rotated resume emits error naming both ids and harness-minted identity", async () => {
    const resumeA = "11111111-1111-4111-8111-111111111111";
    const announceB = "22222222-2222-4222-8222-222222222222";
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(piCli, { prompt: "hi", resume: resumeA }, d);
    proc.emitLine(JSON.stringify({ type: "session", id: announceB }));
    proc.exit(0);
    const events = await collect(turn);
    const errs = events.filter((e) => e.kind === "error") as unknown as Array<{
      message: string;
    }>;
    const rotated = errs.find((e) => e.message.includes("rotated"));
    expect(rotated?.message).toContain(resumeA);
    expect(rotated?.message).toContain(announceB);
    const ids = events.filter((e) => e.kind === "identity") as unknown as Array<{
      sessionId: string;
      authority: string;
    }>;
    expect(ids.some((i) => i.sessionId === announceB && i.authority === "harness-minted")).toBe(
      true,
    );
  });

  test("F-46 launch identity is harness-minted, resume identity is caller-assigned", async () => {
    const sidLaunch = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    const initLaunch = JSON.stringify({ type: "system", subtype: "init", session_id: sidLaunch });
    const procLaunch = new FakeProcess();
    const dLaunch = deps(procLaunch);
    const turnLaunch = streamTurn(claudeCode, { prompt: "hi" }, dLaunch);
    procLaunch.emitLine(initLaunch);
    procLaunch.exit(0);
    const eventsLaunch = await collect(turnLaunch);
    const idLaunch = eventsLaunch.find((e) => e.kind === "identity") as unknown as {
      authority: string;
    };
    expect(idLaunch?.authority).toBe("harness-minted");

    const sidResume = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const initResume = JSON.stringify({ type: "system", subtype: "init", session_id: sidResume });
    const procResume = new FakeProcess();
    const dResume = deps(procResume);
    const turnResume = streamTurn(claudeCode, { prompt: "hi", resume: sidResume }, dResume);
    procResume.emitLine(initResume);
    procResume.exit(0);
    const eventsResume = await collect(turnResume);
    const idResume = eventsResume.find((e) => e.kind === "identity") as unknown as {
      authority: string;
    };
    expect(idResume?.authority).toBe("caller-assigned");
  });
});

describe("descriptor-derived spawn env (memory dimension, ratified 2026-08-26)", () => {
  test("claude memory:false spawns with the env var merged OVER the caller env", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(
      claudeCode,
      {
        prompt: "hi",
        memory: false,
        env: { FOO: "bar", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" },
      },
      d,
    );
    proc.exit(0);
    await collect(turn);
    const call = d.spawner.calls[0];
    expect(call).toBeDefined();
    expect(call?.opts.env).toEqual({
      FOO: "bar",
      // the descriptor-derived disable beats the contradicting raw variable
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });

  test("claude memory unset spawns with no env overlay at all", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.exit(0);
    await collect(turn);
    expect(d.spawner.calls[0]?.opts.env).toBeUndefined();
  });

  test("codex memory:false renders into argv (nothing in env)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(codexCli, { prompt: "hi", memory: false }, d);
    proc.exit(0);
    await collect(turn);
    const call = d.spawner.calls[0];
    expect(call?.argv).toContain("--disable");
    expect(call?.argv[call.argv.indexOf("--disable") + 1]).toBe("memories");
    expect(call?.opts.env).toBeUndefined();
  });
});
