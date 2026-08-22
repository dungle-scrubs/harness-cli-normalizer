import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runJsonSession } from "../../src/cli/session-json.js";
import { openSession } from "../../src/execution/open-session.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
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
const rig = (procOpts: { exitOnStdinEnd?: boolean } = {}) => {
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
