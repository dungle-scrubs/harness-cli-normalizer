/**
 * Issue #454/#455: the native permission channel on a Claude session,
 * driven through openSession over a fake native process. The wire shapes
 * come from the 2.1.319 probe: `can_use_tool` control requests (ordinary
 * tools carry description/permission_suggestions; AskUserQuestion and
 * ExitPlanMode carry requires_user_interaction), the `control_response`
 * reply, and `control_cancel_request` when an interrupt cancels a waiting
 * request. Every event, every rejection reason, the three clearing
 * reasons, and the stall pause while a request waits are covered here.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (
  opts: { readonly nativeApprovals?: boolean; readonly exitOnStdinEnd?: boolean } = {},
  stallMs?: number,
) => {
  const proc = new FakeProcess({
    ...(opts.exitOnStdinEnd === false ? { exitOnStdinEnd: false } : {}),
  });
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  const log: Record<string, unknown>[] = [];
  const session = openSession(
    claudeCode,
    {
      sessionId: sid,
      questions: "none",
      ...(opts.nativeApprovals === true ? { nativeApprovals: true } : {}),
    },
    {
      spawn: spawner.spawn,
      clock,
      signal: sig.signal,
      log: (entry) => log.push(entry),
      ...(stallMs === undefined ? {} : { stallMs }),
    },
  );
  const turns = session.turns[Symbol.asyncIterator]();
  return { proc, spawner, sig, clock, log, session, turns };
};

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of turn) out.push(event);
  return out;
};

const lastStdin = (proc: FakeProcess): Record<string, unknown> =>
  JSON.parse(proc.stdinLines.at(-1) ?? "null") as Record<string, unknown>;
const uuidOf = (proc: FakeProcess): string => String(lastStdin(proc).uuid);

// --- claude wire shapes ----------------------------------------------------
const claudeInit = (uuids: string[]) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sid,
    user_message_uuids: uuids,
  });
const claudeAssistant = (text: string, uuids: string[]) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    user_message_uuid: uuids[0],
    user_message_uuids: uuids,
  });
const claudeResult = (uuids: string[]) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sid,
    is_error: false,
    user_message_uuid: uuids[0],
    user_message_uuids: uuids,
  });

const canUseTool = (requestId: string, request: Record<string, unknown>): string =>
  JSON.stringify({ type: "control_request", request_id: requestId, request });
const cancelRequest = (requestId: string): string =>
  JSON.stringify({ type: "control_cancel_request", request_id: requestId });

// The documented PermissionUpdate shapes (review round 1, F4): addRules
// rules are {toolName, ruleContent?} objects with an allow behavior.
const SET_MODE = { type: "setMode", mode: "acceptEdits", destination: "session" };
const ADD_RULES = {
  type: "addRules",
  behavior: "allow",
  destination: "session",
  rules: [{ toolName: "Bash", ruleContent: "git status" }],
};

const WRITE_ASK = {
  subtype: "can_use_tool",
  tool_name: "Write",
  display_name: "Write",
  input: { file_path: "/tmp/out.txt", content: "x\n" },
  description: "Write file to /tmp/out.txt",
  tool_use_id: "toolu_1",
  permission_suggestions: [
    SET_MODE,
    ADD_RULES,
    // Persisted destination and deny behavior are never offered.
    { ...ADD_RULES, destination: "persisted" },
    { ...ADD_RULES, behavior: "deny" },
  ],
};

/** A claude turn whose run has started natively, ready to raise a
 * permission request. */
const startTurn = async (r: ReturnType<typeof rig>, id: string) => {
  r.session.send({ id, text: "work" });
  const uuid = uuidOf(r.proc);
  r.proc.emitLine(claudeInit([uuid]));
  const turn = (await r.turns.next()).value as SessionTurn;
  expect(turn.inputId).toBe(id);
  return { turn, uuid };
};

describe("issue #454: arming the channel", () => {
  test("the spawn adds --permission-prompt-tool stdio and the controls advertise it", async () => {
    const r = rig({ nativeApprovals: true });
    expect(r.spawner.calls[0]?.argv).toContain("--permission-prompt-tool");
    expect(
      r.spawner.calls[0]?.argv?.[r.spawner.calls[0].argv.indexOf("--permission-prompt-tool") + 1],
    ).toBe("stdio");
    expect(r.session.controls).toEqual({
      deliveryModes: ["queue", "steer"],
      interrupt: { supported: false },
      approvals: { supported: true },
      stopBackground: { supported: true },
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("without the flag the argv is unchanged and approvals read unsupported", async () => {
    const r = rig();
    expect(r.spawner.calls[0]?.argv).not.toContain("--permission-prompt-tool");
    expect(r.session.controls.approvals).toEqual({ supported: false });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a pi session without the flag never advertises approvals and carries no channel flags", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const session = openSession(
      piCli,
      { sessionId: sid, questions: "none" },
      { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    expect(session.controls.approvals).toEqual({ supported: false });
    expect(spawner.calls[0]?.argv).toEqual(["pi", "--mode", "rpc", "--session-id", sid]);
    proc.exit(0);
    await session.close();
  });
});

describe("issue #454/#455: requests become approval-request events", () => {
  test("a tool request lands inside the current turn with its choices", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    const request = events.find((event) => event.kind === "approval-request");
    expect(request).toEqual({
      kind: "approval-request",
      v: 1,
      requestId: "req-1",
      sessionId: sid,
      turnId: `${sid}:turn-1`,
      category: "tool",
      tool: "Write",
      details: "Write file to /tmp/out.txt",
      input: WRITE_ASK.input,
      choices: [
        { id: "allow", label: "Allow", scope: "once" },
        {
          id: "suggestion-1",
          label: "Allow, and accept edits for this session",
          scope: "session",
          update: SET_MODE,
        },
        {
          id: "suggestion-2",
          label: "Allow, and always allow Bash(git status) for this session",
          scope: "session",
          update: ADD_RULES,
        },
        { id: "deny", label: "Deny", scope: "deny" },
      ],
    });
    r.proc.emitLine(claudeAssistant("done", [uuid]));
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("a duplicate native request id is ignored", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events = await (async () => {
      const out: HarnessEvent[] = [];
      const draining = (async () => {
        for await (const event of turn) out.push(event);
      })();
      await tick();
      r.proc.emitLine(claudeAssistant("done", [uuid]));
      r.proc.emitLine(claudeResult([uuid]));
      await draining;
      return out;
    })();
    expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
    await r.session.close();
  });

  test("a request with no turn open opens one so the event has a home", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBeUndefined();
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    expect(events.some((event) => event.kind === "approval-request")).toBe(true);
    void draining;
    r.proc.exit(0);
    await r.session.close();
  });

  test("a replayed duplicate after its turn ended opens no empty turn (review round 2, G6)", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    const turnStarts = () => r.log.filter((entry) => entry.event === "turn_start").length;
    expect(turnStarts()).toBe(1);
    // The child replays the answered request's line after its turn
    // ended: a duplicate is ignored, and none of a first sighting's side
    // effects - like opening a turn - may happen for it.
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    await tick();
    expect(turnStarts()).toBe(1);
    expect(r.session.answerApproval({ id: "d2", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "already-answered",
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("without the flag a request is dropped, never half-forwarded", async () => {
    const r = rig();
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events = await (async () => {
      const out: HarnessEvent[] = [];
      const draining = (async () => {
        for await (const event of turn) out.push(event);
      })();
      await tick();
      r.proc.emitLine(claudeResult([uuid]));
      await draining;
      return out;
    })();
    expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    await r.session.close();
  });
});

describe("issue #454/#455: decisions", () => {
  test("allow writes the native control_response and consumes the answer right", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "sent",
    });
    expect(lastStdin(r.proc)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: WRITE_ASK.input },
      },
    });
    expect(r.session.answerApproval({ id: "d2", requestId: "req-1", choiceId: "deny" })).toEqual({
      status: "rejected",
      reason: "already-answered",
    });
    r.proc.emitLine(claudeAssistant("done", [uuid]));
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  });

  test("an addRules suggestion choice replays its native permission update (F4)", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    expect(
      r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "suggestion-2" }),
    ).toEqual({ status: "sent" });
    expect((lastStdin(r.proc).response as { response: unknown })?.response).toEqual({
      behavior: "allow",
      updatedInput: WRITE_ASK.input,
      updatedPermissions: [ADD_RULES],
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  });

  test("deny carries the message; decline its own default", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    r.session.answerApproval({
      id: "d1",
      requestId: "req-1",
      choiceId: "deny",
      message: "not here",
    });
    expect((lastStdin(r.proc).response as { response: unknown })?.response).toEqual({
      behavior: "deny",
      message: "not here",
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  });

  test("an AskUserQuestion answer amends the input with joined answers", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(
      canUseTool("req-q", {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        display_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              multiSelect: false,
              options: [{ label: "Postgres" }, { label: "SQLite" }],
            },
          ],
        },
        tool_use_id: "toolu_q",
        requires_user_interaction: true,
      }),
    );
    const draining = drainTurn(turn);
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "req-q",
        choiceId: "answer",
        answers: { "Which database?": "SQLite" },
      }),
    ).toEqual({ status: "sent" });
    expect((lastStdin(r.proc).response as { response: unknown })?.response).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: { "Which database?": "SQLite" },
      },
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  });

  test("a plan approval passes the input through", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(
      canUseTool("req-p", {
        subtype: "can_use_tool",
        tool_name: "ExitPlanMode",
        display_name: "ExitPlanMode",
        input: { plan: "1. Write probe.txt" },
        tool_use_id: "toolu_p",
        requires_user_interaction: true,
      }),
    );
    const draining = drainTurn(turn);
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "req-p", choiceId: "approve" })).toEqual(
      { status: "sent" },
    );
    expect((lastStdin(r.proc).response as { response: unknown })?.response).toEqual({
      behavior: "allow",
      updatedInput: { plan: "1. Write probe.txt" },
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  });

  test.each([
    [{ choiceId: "nope" }, "unknown-choice"],
    [{ choiceId: "allow", message: "hi" }, "invalid-message"],
    [{ choiceId: "allow", answers: { q: "a" } }, "invalid-answers"],
  ])(
    "a semantically invalid decision is rejected and the request stays answerable",
    (decision, reason) => {
      const r = rig({ nativeApprovals: true });
      return (async () => {
        const { turn, uuid } = await startTurn(r, "a");
        r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
        const draining = drainTurn(turn);
        await tick();
        expect(r.session.answerApproval({ id: "d1", requestId: "req-1", ...decision })).toEqual({
          status: "rejected",
          reason,
        });
        // The request is still waiting and can be answered properly.
        expect(
          r.session.answerApproval({ id: "d2", requestId: "req-1", choiceId: "allow" }),
        ).toEqual({
          status: "sent",
        });
        r.proc.emitLine(claudeResult([uuid]));
        await draining;
        await r.session.close();
      })();
    },
  );

  test("an unknown request id is rejected unknown-request", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "req-x", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  });

  test("a closing session rejects a still-waiting request's decision closed", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    // close() marks the session closing synchronously, then drains the
    // open turn - the request is still waiting in that window.
    const closing = r.session.close();
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "closed",
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await closing;
    // The turn's end cleared the unrequited request; it stays unknown.
    expect(r.session.answerApproval({ id: "d2", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
  });

  test("a broken stdin rejects the decision write-failed and the decision stays consumed", async () => {
    const r = rig({ nativeApprovals: true, exitOnStdinEnd: false });
    const { turn } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    // End stdin without exiting: the next write throws, the pipe is gone.
    r.proc.stdin?.end();
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "write-failed",
    });
    expect(r.session.answerApproval({ id: "d2", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "already-answered",
    });
    r.proc.exit(1);
    await draining;
    await r.session.close();
  });
});

describe("issue #454: clearing", () => {
  test("control_cancel_request clears native-resolved and the answer right is gone", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(cancelRequest("req-1"));
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    expect(events.find((event) => event.kind === "approval-cleared")).toEqual({
      kind: "approval-cleared",
      requestId: "req-1",
      reason: "native-resolved",
      v: 1,
    });
    await r.session.close();
  });

  test("a turn that ends while a request waits clears it turn-ended, ahead of done", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    const clearedAt = events.findIndex((event) => event.kind === "approval-cleared");
    const doneAt = events.findIndex((event) => event.kind === "done");
    expect(events[clearedAt]).toEqual({
      kind: "approval-cleared",
      requestId: "req-1",
      reason: "turn-ended",
      v: 1,
    });
    expect(clearedAt).toBeLessThan(doneAt);
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    await r.session.close();
  });

  test("an answered request is not cleared again at turn end", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" });
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    expect(events.filter((event) => event.kind === "approval-cleared")).toEqual([]);
    await r.session.close();
  });

  test("close with a request still waiting does not hang: stdin ends and the request dies with the process", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    // No further native output and no answer: the drain must give up on
    // the turn instead of waiting forever (the stall clock is paused).
    const closing = r.session.close();
    await draining;
    await closing;
    expect(events.find((event) => event.kind === "approval-cleared")).toEqual({
      kind: "approval-cleared",
      requestId: "req-1",
      reason: "process-ended",
      v: 1,
    });
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
  });

  test("a request arriving after the drain began also unblocks the close", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn } = await startTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    // The drain is already waiting on the open turn when the request
    // lands; it can never be answered, so the drain must give up then.
    const closing = r.session.close();
    await tick();
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    await draining;
    await closing;
    expect(events.find((event) => event.kind === "approval-cleared")).toMatchObject({
      requestId: "req-1",
      reason: "process-ended",
    });
    expect(events.at(-1)).toMatchObject({ kind: "done" });
  });

  test("process death clears a still-waiting request process-ended", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.exit(1);
    await draining;
    expect(events.find((event) => event.kind === "approval-cleared")).toEqual({
      kind: "approval-cleared",
      requestId: "req-1",
      reason: "process-ended",
      v: 1,
    });
  });
});

describe("issue #454 (review F6): the approval history is bounded", () => {
  test("a request beyond the pending cap is denied natively and reported as an error event", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    // NATIVE_APPROVAL_LIMITS.pending requests wait; the next is denied.
    for (let i = 0; i <= 32; i++) r.proc.emitLine(canUseTool(`req-${i}`, WRITE_ASK));
    await tick();
    const requests = events.filter((event) => event.kind === "approval-request");
    expect(requests).toHaveLength(32);
    // The native deny was written with a message the child can show.
    const deny = r.proc.stdinLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.type === "control_response") as
      | { response?: { response?: { behavior?: string; message?: string } } }
      | undefined;
    expect(deny?.response?.response?.behavior).toBe("deny");
    expect(deny?.response?.response?.message).toContain("32 permission requests");
    expect(events.some((event) => event.kind === "error" && event.message.includes("req-32"))).toBe(
      true,
    );
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  }, 30_000);

  test("the cap denial's write is guarded like every other: a broken pipe runs the shutdown, never throws through the pump (review round 2, G3)", async () => {
    const r = rig({ nativeApprovals: true, exitOnStdinEnd: false });
    const { turn } = await startTurn(r, "a");
    const draining = drainTurn(turn);
    await tick();
    for (let i = 0; i < 32; i++) r.proc.emitLine(canUseTool(`req-${i}`, WRITE_ASK));
    await tick();
    // The pipe is gone: the cap-path deny write on the 33rd request must
    // fail through the session's broken-pipe path, not propagate out of
    // stdout processing.
    r.proc.stdin?.end();
    r.proc.emitLine(canUseTool("req-32", WRITE_ASK));
    await tick();
    r.proc.exit(1);
    await draining;
    await r.session.close();
    // The 33rd request was never tracked: with the pipe gone it reads
    // unknown, and the session ended through the escalation path.
    expect(r.session.answerApproval({ id: "d1", requestId: "req-32", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
  });

  test("the broken-pipe shutdown runs on its own, before any forced exit: the tracker's callback, not the process, closes the session (review round 3, H6)", async () => {
    const r = rig({ nativeApprovals: true, exitOnStdinEnd: false });
    const { turn } = await startTurn(r, "a");
    const draining = drainTurn(turn);
    await tick();
    for (let i = 0; i < 32; i++) r.proc.emitLine(canUseTool(`req-${i}`, WRITE_ASK));
    await tick();
    // Same broken pipe, but nothing forces the child out: the tracker's
    // cap-path write failure itself must run the session's shutdown -
    // escalation signals the child, the cooperative fake dies on it, and
    // the session closes. A tracker that swallowed the write failure
    // leaves the session open forever.
    r.proc.stdin?.end();
    r.proc.emitLine(canUseTool("req-32", WRITE_ASK));
    await r.session.close();
    expect(r.proc.hasExited).toBe(true);
    expect(r.sig.sent.length).toBeGreaterThan(0);
    await draining;
  });

  test("answered ids become bounded tombstones; the oldest is evicted past the cap", async () => {
    const r = rig({ nativeApprovals: true });
    const { turn, uuid } = await startTurn(r, "a");
    const draining = drainTurn(turn);
    await tick();
    // Fill the identity ledger past NATIVE_APPROVAL_LIMITS.identities
    // (4096): offer, then answer, in small batches so the pending cap
    // never trips.
    for (let batch = 0; batch * 16 <= 4096; batch++) {
      const start = batch * 16;
      const end = Math.min(start + 16, 4097);
      for (let i = start; i < end; i++) r.proc.emitLine(canUseTool(`req-${i}`, WRITE_ASK));
      await tick();
      for (let i = start; i < end; i++)
        r.session.answerApproval({ id: `d-${i}`, requestId: `req-${i}`, choiceId: "allow" });
    }
    // The oldest tombstone (req-0) was evicted: the id reads like any
    // unknown request. A recent one keeps rejecting already-answered.
    expect(r.session.answerApproval({ id: "d", requestId: "req-0", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    expect(r.session.answerApproval({ id: "d", requestId: "req-4096", choiceId: "allow" })).toEqual(
      { status: "rejected", reason: "already-answered" },
    );
    r.proc.emitLine(claudeResult([uuid]));
    await draining;
    await r.session.close();
  }, 120_000);
});

describe("issue #454 (review F3): an async stdin failure clears waiting requests", () => {
  test("a broken pipe clears waiting requests channel-failed and ends the session", async () => {
    const r = rig({ nativeApprovals: true, exitOnStdinEnd: false });
    const { turn } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    // The pipe fails asynchronously: no write throws, inputError is the
    // only signal.
    r.proc.failStdin();
    await draining;
    expect(events.find((event) => event.kind === "approval-cleared")).toEqual({
      kind: "approval-cleared",
      requestId: "req-1",
      reason: "channel-failed",
      v: 1,
    });
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    expect(
      events.some((event) => event.kind === "error" && event.message.includes("stdin failed")),
    ).toBe(true);
    // The request lost its answer right with the channel.
    expect(r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    await r.session.close();
  });
});

describe("issue #454: the stall clock pauses while a request waits", () => {
  test("quiet while a human decides is not inactivity; it resumes once the request settles", async () => {
    const r = rig({ nativeApprovals: true }, 1000);
    const { turn } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    // Past the whole budget while the request waits: no stall.
    r.clock.advance(5000);
    expect(r.proc.hasExited).toBe(false);
    expect(r.log.filter((entry) => entry.event === "stall")).toEqual([]);
    // Answered: the pause lifts, and with no further output the budget
    // fires on the resumed clock.
    r.session.answerApproval({ id: "d1", requestId: "req-1", choiceId: "allow" });
    r.clock.advance(2000);
    const events = await draining;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "stall" });
    await r.session.close();
  });

  test("a cancelled request resumes the clock too", async () => {
    const r = rig({ nativeApprovals: true }, 1000);
    const { turn } = await startTurn(r, "a");
    r.proc.emitLine(canUseTool("req-1", WRITE_ASK));
    const draining = drainTurn(turn);
    await tick();
    r.proc.emitLine(cancelRequest("req-1"));
    await tick();
    r.clock.advance(5000);
    const events = await draining;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "stall" });
    await r.session.close();
  });
});
