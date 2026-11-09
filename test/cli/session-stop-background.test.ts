/**
 * The `stop-background` op on the `hcn session --json` wire: malformed
 * commands, the two-phase background-stop receipt, and the unsupported
 * receipt on a harness without the native stop. Driven through
 * runJsonSession over a real openSession on a fake native process; wire
 * shapes from the claude 2.1.319 capture of 2026-11-09.
 */
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runJsonSession } from "../../src/cli/session-json.js";
import { openSession } from "../../src/execution/open-session.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (descriptor: typeof claudeCode | typeof piCli) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const closeInfo: { exitCode: number | null; cause: string } = { exitCode: null, cause: "clean" };
  const handle = openSession(
    descriptor,
    { sessionId: sid, questions: "none" },
    {
      spawn: spawner.spawn,
      clock: new FakeClock(),
      signal: fakeSignal().signal,
      log: (entry: Record<string, unknown>) => {
        if (entry.event === "session_close") {
          closeInfo.exitCode = (entry.exitCode as number | null) ?? null;
          closeInfo.cause = (entry.cause as string) ?? "clean";
        }
      },
    },
  );
  const input = new PassThrough();
  const out: string[] = [];
  const done = runJsonSession({
    handle,
    sessionId: sid,
    harness: descriptor.name,
    hcnVersion: "9.9.9",
    questions: "none",
    origin: "fresh",
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
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const stdin = () => proc.stdinLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { proc, input, done, send, events, stdin };
};

const claudeInitFor = (proc: FakeProcess, sidValue: string) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sidValue,
    user_message_uuids: [String(JSON.parse(proc.stdinLines.at(-1) ?? "{}").uuid ?? "")],
  });
const claudeCompleted = (uuid: string) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    session_id: sid,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
  });
const stopTaskResponse = (requestId: unknown, ok: boolean) =>
  JSON.stringify({
    type: "control_response",
    response: {
      subtype: ok ? "success" : "error",
      request_id: requestId,
      ...(ok ? {} : { error: "no such task" }),
    },
  });

describe("stop-background on the session --json wire", () => {
  test("claude: requested then sent, with the job id on the native request", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "send", id: "a1", text: "start a background loop" });
    await tick();
    const uuid = String(r.stdin().at(-1)?.uuid);
    r.proc.emitLine(claudeInitFor(r.proc, sid));
    r.proc.emitLine(
      JSON.stringify({
        type: "system",
        subtype: "task_started",
        task_id: "bcrfa3pxt",
        tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
        description: "Run background tick loop",
        task_type: "local_bash",
        session_id: sid,
      }),
    );
    await tick();

    r.send({ op: "stop-background", id: "stop-1", job: "bcrfa3pxt" });
    await tick();
    const request = r.stdin().at(-1);
    expect(request).toEqual({
      type: "control_request",
      request_id: expect.stringMatching(/^hcn-stop-background:/),
      request: { subtype: "stop_task", task_id: "bcrfa3pxt" },
    });
    expect(r.events().filter((e) => e.kind === "background-stop")).toEqual([
      { kind: "background-stop", id: "stop-1", state: "requested" },
    ]);
    // The turn stream carries the job's own events.
    expect(
      r
        .events()
        .filter((e) => e.kind === "background")
        .map((e) => [e.state, e.job]),
    ).toEqual([["running", "shell"]]);

    r.proc.emitLine(stopTaskResponse(request?.request_id, true));
    await tick();
    expect(r.events().filter((e) => e.kind === "background-stop")).toEqual([
      { kind: "background-stop", id: "stop-1", state: "requested" },
      { kind: "background-stop", id: "stop-1", state: "sent" },
    ]);
    r.proc.emitLine(claudeCompleted(uuid));
    await tick();
    r.input.end();
    const code = await r.done;
    expect(r.events().at(-1)).toMatchObject({ kind: "closed", cause: "clean" });
    expect(code).toBe(0);
  });

  test("claude: a native error response ends the receipt rejected native-rejected", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "stop-background", id: "stop-1", job: "bcrfa3pxt" });
    await tick();
    const request = r.stdin().at(-1);
    r.proc.emitLine(stopTaskResponse(request?.request_id, false));
    await tick();
    expect(r.events().filter((e) => e.kind === "background-stop")).toEqual([
      { kind: "background-stop", id: "stop-1", state: "requested" },
      { kind: "background-stop", id: "stop-1", state: "rejected", reason: "native-rejected" },
    ]);
    // Nothing was written natively beyond the one request, and the session
    // stays usable.
    expect(r.proc.hasExited).toBe(false);
    r.input.end();
    expect(await r.done).toBe(0);
  });

  test("pi: one rejected unsupported receipt, nothing written natively", async () => {
    const r = rig(piCli);
    await tick();
    const before = r.proc.stdinLines.length;
    r.send({ op: "stop-background", id: "stop-1", job: "bcrfa3pxt" });
    await tick();
    expect(r.events().filter((e) => e.kind === "background-stop")).toEqual([
      { kind: "background-stop", id: "stop-1", state: "rejected", reason: "unsupported" },
    ]);
    expect(r.proc.stdinLines).toHaveLength(before);
    r.input.end();
    expect(await r.done).toBe(0);
  });

  test("a malformed stop-background is an error, never a receipt, and the session lives", async () => {
    const r = rig(claudeCode);
    await tick();
    const before = r.proc.stdinLines.length;
    r.send({ op: "stop-background", id: "stop-1" });
    r.send({ op: "stop-background", id: "", job: "bcrfa3pxt" });
    r.send({ op: "stop-background", id: "stop-1", job: "" });
    r.send({ op: "stop-background", id: "stop-1", job: 7 });
    await tick();
    const errors = r.events().filter((e) => e.kind === "error");
    expect(errors).toHaveLength(4);
    for (const error of errors) expect(String(error.message)).toMatch(/^malformed command:/);
    expect(r.events().filter((e) => e.kind === "background-stop")).toEqual([]);
    expect(r.proc.stdinLines).toHaveLength(before);
    r.input.end();
    expect(await r.done).toBe(0);
  });

  test("a receipt still pending at close settles on the wire before closed", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "stop-background", id: "stop-1", job: "bcrfa3pxt" });
    await tick();
    // EOF closes the session with the request unanswered.
    r.input.end();
    await r.done;
    expect(r.events().filter((e) => e.kind === "background-stop")).toEqual([
      { kind: "background-stop", id: "stop-1", state: "requested" },
      { kind: "background-stop", id: "stop-1", state: "rejected", reason: "closed" },
    ]);
    expect(r.events().at(-1)).toMatchObject({ kind: "closed" });
  });
});
