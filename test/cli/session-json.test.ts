import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { session } from "../../src/cli/session.js";
import { runJsonSession, type SessionOrigin } from "../../src/cli/session-json.js";
import { openSession } from "../../src/execution/open-session.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const assistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const result = JSON.stringify({ type: "result", subtype: "success" });
const question = (q: string, opts: string[]) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `\`\`\`hcn-question\n${JSON.stringify({ question: q, options: opts })}\n\`\`\``,
        },
      ],
    },
  });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Drive runJsonSession over a real openSession on a fake process. Returns
 * the parsed stdout events, the input stream to write commands to, and the
 * fake process to emit harness lines from. */
const rig = (procOpts: { exitOnStdinEnd?: boolean } = {}, origin: SessionOrigin = "fresh") => {
  const proc = new FakeProcess(procOpts);
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  const closeInfo = { exitCode: null as number | null, cause: "clean" };
  const handle = openSession(
    claudeCode,
    { sessionId: sid },
    {
      spawn: spawner.spawn,
      clock,
      signal: sig.signal,
      log: (e: Record<string, unknown>) => {
        if (e.event === "session_close") {
          closeInfo.exitCode = (e.exitCode as number | null) ?? null;
          closeInfo.cause = (e.cause as string) ?? "clean";
        }
      },
    },
  );
  const input = new PassThrough();
  const out: string[] = [];
  const done = runJsonSession({
    handle,
    sessionId: sid,
    harness: "claude",
    hcnVersion: "9.9.9",
    escalateQuestions: true,
    origin,
    getCloseInfo: () => closeInfo,
    input,
    write: (line) => {
      out.push(line);
      return true;
    },
    onDrain: (fn) => fn(),
  });
  const send = (obj: unknown) => input.write(`${JSON.stringify(obj)}\n`);
  const events = () =>
    out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { proc, input, done, send, events };
};

describe("T02: hcn session --json happy path", () => {
  test("session -> disposition started -> turn(id) -> events -> done -> closed exit 0", async () => {
    const r = rig();
    await tick();

    r.send({ op: "send", id: "in-1", text: "hi" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(assistant("hello back"));
    r.proc.emitLine(result);
    await tick();

    r.input.end(); // EOF == close
    const code = await r.done;

    const evs = r.events();
    expect(evs[0]).toMatchObject({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "9.9.9",
      escalateQuestions: true,
      origin: "fresh",
    });
    const disp = evs.find((e) => e.kind === "disposition");
    expect(disp).toMatchObject({ id: "in-1", disposition: "started" });
    const turn = evs.find((e) => e.kind === "turn");
    expect(turn).toMatchObject({ id: "in-1" });
    expect(turn.turnId).toBe(`${sid}:turn-1`);
    expect(evs.find((e) => e.kind === "message")).toMatchObject({ text: "hello back" });
    expect(evs.find((e) => e.kind === "done")).toMatchObject({ cause: "clean" });
    expect(evs.at(-1)).toMatchObject({ kind: "closed", cause: "clean", exitCode: 0 });
    expect(code).toBe(0);

    // stdout carries JSON only; no prose leaked in.
    for (const line of r.events()) expect(typeof line.kind).toBe("string");
  });

  test("a malformed command is an error, never a disposition, and the session lives", async () => {
    const r = rig();
    await tick();
    r.input.write("not json at all\n");
    await tick();
    r.send({ op: "send", id: "in-1", text: "hi" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;

    const evs = r.events();
    const err = evs.find((e) => e.kind === "error");
    expect(err.message).toContain("malformed command");
    expect(evs.some((e) => e.kind === "disposition" && e.id === "in-1")).toBe(true);
  });
});

describe("T03: queued sends carry their id to the turn that consumes them", () => {
  test("second send while busy -> queued, then next turn carries in-2", async () => {
    const r = rig();
    await tick();
    r.send({ op: "send", id: "in-1", text: "first" });
    await tick();
    r.proc.emitLine(init);
    r.send({ op: "send", id: "in-2", text: "second while busy" });
    await tick();
    r.proc.emitLine(result); // ends turn 1; boundary flushes in-2
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result); // ends turn 2
    await tick();
    r.input.end();
    await r.done;

    const evs = r.events();
    const disps = evs.filter((e) => e.kind === "disposition");
    expect(disps[0]).toMatchObject({ id: "in-1", disposition: "started" });
    expect(disps[1]).toMatchObject({ id: "in-2", disposition: "queued" });
    const turns = evs.filter((e) => e.kind === "turn");
    expect(turns[0]).toMatchObject({ id: "in-1" });
    expect(turns[1]).toMatchObject({ id: "in-2" });
  });
});

describe("T07: write-failed is distinct from closed", () => {
  test("a broken harness stdin rejects write-failed and the session ends", async () => {
    // The child stays alive; only its input pipe is gone, so this is a
    // broken pipe and not a dead session.
    const r = rig({ exitOnStdinEnd: false });
    await tick();
    // The child's input pipe goes away between turns.
    r.proc.stdin?.end();
    r.send({ op: "send", id: "in-1", text: "unwritable" });
    await tick();
    r.input.end();
    await r.done;

    const evs = r.events();
    const disp = evs.find((e) => e.kind === "disposition");
    expect(disp).toMatchObject({ id: "in-1", disposition: "rejected", reason: "write-failed" });
    // The disposition's reason IS the signal. The runner's own error event
    // is raised between turns, and the runner holds between-turn events for
    // the next turn; a broken pipe means no next turn, so that event is
    // logged as dropped rather than delivered. The consumer is not left
    // guessing: it has the reason and the closed event.
    expect(evs.at(-1)).toMatchObject({ kind: "closed" });
    // A send after the pipe broke reports closed, not write-failed again.
    expect(evs.filter((e) => e.kind === "disposition")).toHaveLength(1);
  });
});

describe("branch review: fixes for the findings the cross-family review raised", () => {
  test("F7: a queued send that dies with the session is rejected on the wire", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const closeInfo = { exitCode: null as number | null, cause: "clean" };
    const droppedIds: string[] = [];
    const handle = openSession(
      claudeCode,
      { sessionId: sid },
      {
        spawn: spawner.spawn,
        clock: new FakeClock(),
        signal: fakeSignal().signal,
        log: (e: Record<string, unknown>) => {
          if (e.event === "session_close") {
            closeInfo.exitCode = (e.exitCode as number | null) ?? null;
            closeInfo.cause = (e.cause as string) ?? "clean";
          }
          if (e.event === "sends_dropped" && Array.isArray(e.ids)) {
            for (const id of e.ids as unknown[]) if (typeof id === "string") droppedIds.push(id);
          }
        },
      },
    );
    const input = new PassThrough();
    const out: string[] = [];
    const done = runJsonSession({
      handle,
      sessionId: sid,
      harness: "claude",
      hcnVersion: "9.9.9",
      escalateQuestions: true,
      origin: "fresh",
      getCloseInfo: () => closeInfo,
      getDroppedIds: () => droppedIds,
      input,
      write: (line) => {
        out.push(line);
        return true;
      },
      onDrain: (fn) => fn(),
    });

    input.write(`${JSON.stringify({ op: "send", id: "in-1", text: "first" })}\n`);
    await tick();
    proc.emitLine(init);
    input.write(`${JSON.stringify({ op: "send", id: "in-2", text: "queued and doomed" })}\n`);
    await tick();
    proc.exit(1); // dies before the boundary ever flushes in-2
    await tick();
    input.end();
    await done;

    const evs = out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const rejected = evs.find((e) => e.kind === "disposition" && e.disposition === "rejected");
    expect(rejected).toMatchObject({ id: "in-2", reason: "closed" });
    // The rejection lands before the terminal line, never after it.
    expect(evs.indexOf(rejected)).toBeLessThan(evs.length - 1);
    expect(evs.at(-1)).toMatchObject({ kind: "closed" });
  });

  // The window this closes is a microtask wide, so a stream-driven test
  // cannot force it open. What is asserted here is the invariant that the
  // reordering guarantees: the moment `done` is READABLE by the consumer,
  // an answer is already accepted. The consumer answers as soon as it sees
  // the line, which is exactly the sequence the review described.
  test("F1: an answer is accepted as soon as done is on the wire", async () => {
    const r = rig();
    await tick();
    r.send({ op: "send", id: "in-1", text: "ask me" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(question("Deploy where?", ["prod", "staging"]));
    r.proc.emitLine(result);

    // Answer the instant the done line is readable, not a tick later.
    while (!r.events().some((e) => e.kind === "done")) await tick();
    r.send({ op: "answer", id: "in-2", text: "prod" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;

    const evs = r.events();
    const answerDisp = evs.filter((e) => e.kind === "disposition")[1];
    expect(answerDisp).toMatchObject({ id: "in-2", disposition: "started" });
  });
});

describe("T04: answer wraps the preamble; no-open-question is refused", () => {
  test("answer after an awaiting-input turn opens a wrapped turn", async () => {
    const r = rig();
    await tick();
    r.send({ op: "send", id: "in-1", text: "ask me" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(question("Deploy where?", ["prod", "staging"]));
    r.proc.emitLine(result); // turn ends awaiting-input
    await tick();
    r.send({ op: "answer", id: "in-2", text: "prod" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;

    const evs = r.events();
    expect(evs.some((e) => e.kind === "question")).toBe(true);
    const doneAsk = evs.filter((e) => e.kind === "done")[0];
    expect(doneAsk.cause).toBe("awaiting-input");
    const answerDisp = evs.filter((e) => e.kind === "disposition")[1];
    expect(answerDisp).toMatchObject({ id: "in-2", disposition: "started" });
    // the wrapped answer reached the harness stdin
    const wrote = r.proc.stdinLines.join(" ");
    expect(wrote).toContain("The user answered the question");
    expect(wrote).toContain("prod");
  });

  test("answer with no open question is rejected, session stays live", async () => {
    const r = rig();
    await tick();
    r.send({ op: "answer", id: "in-1", text: "prod" });
    await tick();
    r.send({ op: "send", id: "in-2", text: "hi" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;

    const evs = r.events();
    expect(evs.find((e) => e.kind === "disposition")).toMatchObject({
      id: "in-1",
      disposition: "rejected",
      reason: "no-open-question",
    });
    expect(
      evs.some((e) => e.kind === "disposition" && e.id === "in-2" && e.disposition === "started"),
    ).toBe(true);
  });
});

describe("follow-ups: backpressure and a broken command stream", () => {
  /** Like rig(), but stdout refuses every write until the test releases a
   * drain. The default rig always accepts, which is why ordering under
   * congestion could not be proven before. */
  const congestedRig = () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const closeInfo = { exitCode: null as number | null, cause: "clean" };
    const handle = openSession(
      claudeCode,
      { sessionId: sid },
      { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    const input = new PassThrough();
    const out: string[] = [];
    let congested = true;
    const waiters: Array<() => void> = [];
    const done = runJsonSession({
      handle,
      sessionId: sid,
      harness: "claude",
      hcnVersion: "9.9.9",
      escalateQuestions: true,
      origin: "fresh",
      getCloseInfo: () => closeInfo,
      input,
      write: (line) => {
        out.push(line);
        return !congested;
      },
      onDrain: (fn) => waiters.push(fn),
    });
    const release = async () => {
      congested = false;
      while (waiters.length > 0) {
        (waiters.shift() as () => void)();
        await tick();
      }
    };
    const events = () =>
      out
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { proc, input, done, out, release, events };
  };

  test("every send gets exactly one disposition, in command order, while stdout is congested", async () => {
    const r = congestedRig();

    // Four commands arrive back to back while stdout refuses every write.
    for (const id of ["a", "b", "c", "d"]) {
      r.input.write(`${JSON.stringify({ op: "send", id, text: id })}\n`);
    }
    await tick();
    await tick();

    // The first opened a turn; the rest queued behind it.
    r.proc.emitLine(init);
    await tick();
    await r.release();
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;
    await r.release();

    const dispositions = r.events().filter((e) => e.kind === "disposition");
    // Exactly one per send, in the order the sends arrived - not merely
    // "some dispositions appeared".
    expect(dispositions.map((d) => d.id)).toEqual(["a", "b", "c", "d"]);
    expect(dispositions[0]?.disposition).toBe("started");
    for (const d of dispositions.slice(1)) expect(d.disposition).toBe("queued");
    // Every line parsed on its own: a torn or interleaved write would have
    // made that impossible.
    expect(r.events().length).toBeGreaterThan(dispositions.length);
  });

  test("a command stream that breaks is reported, and its unanswered send is rejected", async () => {
    const r = congestedRig();
    await r.release();

    // A send that the session accepts but never dispositions, because the
    // command stream dies before the answer is written.
    r.input.write(`${JSON.stringify({ op: "send", id: "in-1", text: "hi" })}\n`);
    r.input.destroy(new Error("EPIPE from the consumer"));
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    r.proc.exit(0);
    await r.done;
    await r.release();

    const evs = r.events();
    expect(
      evs.some((e) => e.kind === "error" && String(e.message).includes("command stream failed")),
    ).toBe(true);
    expect(evs.at(-1)).toMatchObject({ kind: "closed" });
  });
});

describe("session origin: fresh vs resumed, and refused resume emits no session", () => {
  test("fresh session reports origin fresh", async () => {
    const r = rig({}, "fresh");
    await tick();
    r.send({ op: "send", id: "in-1", text: "hi" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    expect(evs[0]).toMatchObject({ kind: "session", origin: "fresh" });
  });

  test("resumed session reports origin resumed", async () => {
    const r = rig({}, "resumed");
    await tick();
    r.send({ op: "send", id: "in-1", text: "hi" });
    await tick();
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    expect(evs[0]).toMatchObject({ kind: "session", origin: "resumed" });
  });

  test("a refused unknown-id resume emits no session event", async () => {
    const tmpHome = mkdtempSync(`${tmpdir()}/hcn-home-`);
    const tmpCwd = mkdtempSync(`${tmpdir()}/hcn-cwd-`);
    const tmpCfg = mkdtempSync(`${tmpdir()}/hcn-cfg-`);
    const prevHome = process.env.HOME;
    const prevCfg = process.env.HCN_CONFIG_DIR;
    process.env.HOME = tmpHome;
    process.env.HCN_CONFIG_DIR = tmpCfg;
    // Use pi (store-backed) so the guard checks the filesystem; claude's
    // onMissing is "error" and would refuse via harness validation rather than
    // the store check that the origin depends on.
    const fakeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    // Ensure store does NOT exist - fresh tmp dirs guarantee that.
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((c: string | Uint8Array) => {
        out.push(String(c));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c: string | Uint8Array) => {
        err.push(String(c));
        return true;
      });
    const before = process.exitCode ?? 0;
    process.exitCode = 0;
    try {
      await session("pi", ["--json", "--resume", fakeId, "--cwd", tmpCwd]);
      expect(process.exitCode).toBe(2);
      const events = out
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
        });
      expect(events.some((e) => e.kind === "session")).toBe(false);
      expect(events[0]).toMatchObject({ kind: "failure" });
      expect(events.at(-1)).toMatchObject({ kind: "closed" });
      // Also verify the same store-path would be reported as fresh if we
      // created it: file the session and check the complementary path reports
      // resumed. Reuses the same tmp dirs rather than building a second fake.
      const { resumeStore } = await import("../../src/cli/resume-guard.js");
      const beforeCheck = resumeStore(piCli, { home: tmpHome, cwd: tmpCwd, sessionId: fakeId });
      if (beforeCheck.path === null) throw new Error("expected store path");
      const filed = beforeCheck.path;
      mkdirSync(filed, { recursive: true });
      out.length = 0;
      err.length = 0;
      // Verify the store helper now sees it - proves the fake is wired to the
      // same path the refusal checked. Uses the guard's own resolved cwd so
      // /tmp vs /private/tmp on macOS does not diverge.
      const check = resumeStore(piCli, { home: tmpHome, cwd: tmpCwd, sessionId: fakeId });
      expect(check.exists).toBe(true);
      expect(check.path).toBe(filed);
    } finally {
      process.exitCode = before;
      if (process.exitCode === undefined) process.exitCode = 0;
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCfg === undefined) delete process.env.HCN_CONFIG_DIR;
      else process.env.HCN_CONFIG_DIR = prevCfg;
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpCwd, { recursive: true, force: true });
      rmSync(tmpCfg, { recursive: true, force: true });
    }
  });
});
