/**
 * Issue #454/#455: the `--native-approvals` session surface. The wire
 * behavior (approval ops on stdin, approval-request/disposition events on
 * stdout) is driven through runJsonSession over a real openSession on a
 * fake native process; the pre-spawn refusals and the spawn argv are
 * driven through the built CLI with a fake claude and a fake pi on PATH
 * (issue #469: pi declares the channel too, so the refusal case moved to
 * codex).
 */
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runJsonSession } from "../../src/cli/session-json.js";
import { openSession } from "../../src/execution/open-session.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { UUID_SHAPE } from "../../src/knowledge/descriptor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";
import { runCliFixture, runtimes } from "./session-fixture.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = () => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const closeInfo: { exitCode: number | null; cause: string } = { exitCode: null, cause: "clean" };
  const handle = openSession(
    claudeCode,
    { sessionId: sid, questions: "none", nativeApprovals: true },
    {
      spawn: spawner.spawn,
      clock: new FakeClock(),
      signal: sig.signal,
      log: (entry) => {
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
    harness: "claude",
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
  const events = () =>
    out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const raw = (line: string): void => {
    input.write(`${line}\n`);
  };
  return { proc, input, done, raw, events };
};

const claudeInit = (uuid: string) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sid,
    user_message_uuids: [uuid],
  });
const claudeResult = (uuid: string) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sid,
    is_error: false,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
  });
const canUseTool = (requestId: string): string =>
  JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      input: { file_path: "/tmp/out.txt", content: "x\n" },
      description: "Write file to /tmp/out.txt",
      tool_use_id: "toolu_1",
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    },
  });

describe("issue #454/#455: the approval op over the wire", () => {
  test("a decision answers its request and exactly one disposition follows", async () => {
    const r = rig();
    await tick();
    r.raw('{"op":"send","id":"a","text":"work"}');
    await tick();
    const uuid = (r.proc.stdinLines.at(-1) ?? "").length > 0 ? sentUuid(r.proc) : "";
    r.proc.emitLine(claudeInit(uuid));
    r.proc.emitLine(canUseTool("req-1"));
    await tick();
    r.raw('{"v":1,"op":"approval","id":"d1","requestId":"req-1","choiceId":"suggestion-1"}');
    await tick();
    r.proc.emitLine(claudeResult(uuid));
    await tick();
    r.input.end();
    const code = await r.done;
    expect(code).toBe(0);
    const evs = r.events();
    expect(evs[0]).toMatchObject({
      kind: "session",
      controls: { approvals: { supported: true } },
    });
    expect(evs.find((e) => e.kind === "approval-request")).toMatchObject({
      requestId: "req-1",
      turnId: `${sid}:turn-1`,
      category: "tool",
      tool: "Write",
    });
    expect(evs.find((e) => e.kind === "approval-disposition")).toEqual({
      kind: "approval-disposition",
      v: 1,
      id: "d1",
      requestId: "req-1",
      status: "sent",
    });
    const reply = r.proc.stdinLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.type === "control_response");
    expect(reply).toMatchObject({
      type: "control_response",
      response: {
        request_id: "req-1",
        response: {
          behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    });
  });

  test("a rejected decision carries its reason; a malformed line is an error event", async () => {
    const r = rig();
    await tick();
    r.raw('{"op":"send","id":"a","text":"work"}');
    await tick();
    const uuid = sentUuid(r.proc);
    r.proc.emitLine(claudeInit(uuid));
    r.proc.emitLine(canUseTool("req-1"));
    await tick();
    r.raw('{"v":1,"op":"approval","id":"d1","requestId":"req-1","choiceId":"nope"}');
    r.raw('{"v":1,"op":"approval","id":"d2","requestId":"req-x","choiceId":"allow"}');
    await tick();
    r.raw('{"op":"approval","id":"d3","requestId":"req-1","choiceId":"allow"}');
    r.raw('{"v":1,"op":"approval","id":"","requestId":"req-1","choiceId":"allow"}');
    await tick();
    r.proc.emitLine(claudeResult(uuid));
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    const dispositions = evs.filter((e) => e.kind === "approval-disposition");
    expect(dispositions).toEqual([
      {
        kind: "approval-disposition",
        v: 1,
        id: "d1",
        requestId: "req-1",
        status: "rejected",
        reason: "unknown-choice",
      },
      {
        kind: "approval-disposition",
        v: 1,
        id: "d2",
        requestId: "req-x",
        status: "rejected",
        reason: "unknown-request",
      },
    ]);
    const errors = evs.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ kind: "error", message: expect.stringContaining("v:1") });
    expect(errors[1]).toMatchObject({ kind: "error", message: expect.stringContaining("id") });
  });
});

const sentUuid = (proc: FakeProcess): string => {
  const line = proc.stdinLines.at(-1);
  if (line === undefined) throw new Error("no user frame written");
  return String((JSON.parse(line) as { uuid?: unknown }).uuid);
};

const runSession = (runtime: string, args: readonly string[]) =>
  runCliFixture(runtime, ["session", ...args]);

describe("issue #454/#455: the flag's pre-spawn refusals and the spawn argv", () => {
  test.each(runtimes)(
    "%s: --native-approvals without --json refuses with exit 2 and spawns nothing",
    (runtime) => {
      const run = runSession(runtime, ["claude", "--native-approvals"]);
      expect(run.status).toBe(2);
      expect(run.argv).toBeNull();
      expect(run.stderr).toContain("--native-approvals needs --json");
    },
  );

  test.each(runtimes)(
    "%s: --native-approvals on a harness with no channel refuses with exit 2",
    (runtime) => {
      const run = runSession(runtime, ["codex", "--json", "--native-approvals"]);
      expect(run.status).toBe(2);
      expect(run.argv).toBeNull();
      // The refused --json stream still owes its terminal pair.
      expect(run.events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
      expect(run.stderr).toContain("no session permission channel");
    },
  );

  test.each(runtimes)(
    "%s: with --json on pi the spawn is unchanged and the controls advertise the channel",
    (runtime) => {
      // Issue #469: pi's extension UI needs no flag, so arming the
      // channel adds nothing to the spawn argv.
      const run = runSession(runtime, ["pi", "--json", "--native-approvals"]);
      expect(run.status).toBe(0);
      expect(run.argv).not.toBeNull();
      // The capture holds the fake peer's own argv: the interpreter, the
      // script, then the spawn argv hcn built (the kernel replaces argv[0]
      // with the script path, so the spawned binary's name is the script
      // path).
      expect(run.argv?.[1]).toMatch(/\/pi$/);
      const argv = run.argv?.slice(2) ?? [];
      expect(argv.slice(0, 3)).toEqual(["--mode", "rpc", "--session-id"]);
      expect(argv).toHaveLength(4);
      expect(argv[3]).toMatch(UUID_SHAPE);
      expect(run.events[0]).toMatchObject({
        kind: "session",
        controls: { approvals: { supported: true } },
      });
    },
  );

  test.each(runtimes)(
    "%s: with --json on claude the spawn carries --permission-prompt-tool stdio",
    (runtime) => {
      const run = runSession(runtime, ["claude", "--json", "--native-approvals"]);
      expect(run.status).toBe(0);
      expect(run.argv).not.toBeNull();
      const at = run.argv?.indexOf("--permission-prompt-tool") ?? -1;
      expect(at).toBeGreaterThan(-1);
      expect(run.argv?.[at + 1]).toBe("stdio");
      expect(run.events[0]).toMatchObject({
        kind: "session",
        controls: { approvals: { supported: true } },
      });
    },
  );

  test.each(runtimes)(
    "%s: without the flag the claude spawn carries no permission tool",
    (runtime) => {
      // Preservation proof, argv only (review round 2, G9): the events
      // assertion belongs to the flag's own tests, so this one passes at
      // base for exactly the claim it makes - the spawn is unchanged.
      const run = runSession(runtime, ["claude", "--json"]);
      expect(run.status).toBe(0);
      expect(run.argv).not.toContain("--permission-prompt-tool");
    },
  );
});
