/**
 * Issue #469: pi's extension UI dialogs on a live session, driven through
 * openSession over a fake pi process. The wire shapes come from pi 1.4.0:
 * an `extension_ui_request` on stdout with the dialog method, title and
 * options, and one `extension_ui_response` line on stdin with the value
 * (or `cancelled: true`). Every event, every rejection reason, the
 * clearing reasons, the stall rule and the pending cap are covered here.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { isSessionTurn, openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (opts: { readonly nativeApprovals?: boolean } = {}, stallMs?: number) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  const log: Record<string, unknown>[] = [];
  const session = openSession(
    piCli,
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

const stdinRecords = (proc: FakeProcess): Record<string, unknown>[] =>
  proc.stdinLines.map((line) => JSON.parse(line) as Record<string, unknown>);

const responses = (proc: FakeProcess): Record<string, unknown>[] =>
  stdinRecords(proc).filter((line) => line.type === "extension_ui_response");

// --- pi 1.4.0 wire shapes -------------------------------------------------
const piReceipt = (wireId: string, disposition: "started" | "queued" | "handled") =>
  JSON.stringify({
    id: wireId,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition },
  });
const piSettled = (aborted: boolean) => JSON.stringify({ type: "agent_settled", aborted });

const TITLE = "Which one?";
const selectDialog = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "extension_ui_request",
    id,
    method: "select",
    title: TITLE,
    options: ["1. A", "1. B"],
    ...extra,
  });

/** A pi turn whose run has started natively, ready to raise a dialog. */
const startPiTurn = async (r: ReturnType<typeof rig>, id: string): Promise<SessionTurn> => {
  r.session.send({ id, text: "work" });
  r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "started"));
  return (await r.turns.next()).value as SessionTurn;
};

describe("issue #469: arming the channel", () => {
  test("with the flag the controls advertise approvals and the spawn argv is unchanged", async () => {
    const r = rig({ nativeApprovals: true });
    expect(r.spawner.calls[0]?.argv).toEqual(["pi", "--mode", "rpc", "--session-id", sid]);
    expect(r.session.controls.approvals).toEqual({ supported: true });
    r.proc.exit(0);
    await r.session.close();
  });

  test("without the flag nothing changes: no channel, no approval event", async () => {
    const r = rig();
    expect(r.spawner.calls[0]?.argv).toEqual(["pi", "--mode", "rpc", "--session-id", sid]);
    expect(r.session.controls.approvals).toEqual({ supported: false });
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(responses(r.proc)).toEqual([]);
    expect(r.session.answerApproval({ id: "d1", requestId: "dlg-1", choiceId: "answer" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: a select dialog becomes an approval-request", () => {
  test("a dialog raised inside a turn rides inside that turn", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(events.find((event) => event.kind === "approval-request")).toEqual({
      kind: "approval-request",
      v: 1,
      requestId: "dlg-1",
      sessionId: sid,
      turnId: `${sid}:turn-1`,
      category: "question",
      tool: "select",
      details: TITLE,
      input: {
        type: "extension_ui_request",
        id: "dlg-1",
        method: "select",
        title: TITLE,
        options: ["1. A", "1. B"],
      },
      questions: [
        {
          question: TITLE,
          multiSelect: false,
          allowOther: false,
          allowNotes: false,
          options: [{ label: "1. A" }, { label: "1. B" }],
        },
      ],
      choices: [
        { id: "answer", label: "Answer", scope: "once" },
        { id: "decline", label: "Decline to answer", scope: "deny" },
      ],
    });
    // Nothing is written until the host decides.
    expect(responses(r.proc)).toEqual([]);
    r.proc.emitLine(piSettled(false));
    await draining;
    await r.session.close();
  });

  test("a dialog raised between turns opens no turn and carries no turnId", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1"));
    const bare = (await r.turns.next()).value as HarnessEvent;
    expect(bare.kind).toBe("approval-request");
    expect(bare).toMatchObject({ requestId: "dlg-1", category: "question", tool: "select" });
    expect("turnId" in bare).toBe(false);
    expect(r.log.filter((entry) => entry.event === "turn_start")).toEqual([]);
    // The host can still answer it.
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. A" },
      }),
    ).toEqual({ status: "sent" });
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", value: "1. A" },
    ]);
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: decisions", () => {
  test("answer writes the native response line", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const draining = drainTurn(turn);
    await tick();
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. A" },
      }),
    ).toEqual({ status: "sent" });
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", value: "1. A" },
    ]);
    // The answer right is consumed.
    expect(
      r.session.answerApproval({
        id: "d2",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. B" },
      }),
    ).toEqual({ status: "rejected", reason: "already-answered" });
    r.proc.emitLine(piSettled(false));
    await draining;
    await r.session.close();
  });

  test("an array of one offered option answers the dialog", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: ["1. B"] },
      }),
    ).toEqual({ status: "sent" });
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", value: "1. B" },
    ]);
    r.proc.exit(0);
    await r.session.close();
  });

  test("decline cancels the dialog natively", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "dlg-1", choiceId: "decline" })).toEqual(
      { status: "sent" },
    );
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", cancelled: true },
    ]);
    r.proc.exit(0);
    await r.session.close();
  });

  test.each([
    [{ choiceId: "nope" }, "unknown-choice"],
    [{ choiceId: "answer", answers: { [TITLE]: "2. C" } }, "invalid-answers"],
    [
      { choiceId: "answer", answers: { [TITLE]: "1. A", [`${TITLE} 2`]: "1. B" } },
      "invalid-answers",
    ],
    [{ choiceId: "answer", answers: { [TITLE]: ["1. A", "1. B"] } }, "invalid-answers"],
    [{ choiceId: "answer", answers: { [TITLE]: [] } }, "invalid-answers"],
    [{ choiceId: "answer", answers: { "Other question": "1. A" } }, "invalid-answers"],
    [{ choiceId: "answer", answers: {} }, "invalid-answers"],
    [{ choiceId: "answer", message: "hi" }, "invalid-message"],
    [{ choiceId: "decline", answers: { [TITLE]: "1. A" } }, "invalid-answers"],
    [{ choiceId: "decline", message: "no" }, "invalid-message"],
  ])(
    "a semantically invalid decision is rejected and nothing is written",
    async (decision, reason) => {
      const r = rig({ nativeApprovals: true });
      r.proc.emitLine(selectDialog("dlg-1"));
      await tick();
      expect(r.session.answerApproval({ id: "d1", requestId: "dlg-1", ...decision })).toEqual({
        status: "rejected",
        reason,
      });
      expect(responses(r.proc)).toEqual([]);
      r.proc.exit(0);
      await r.session.close();
    },
  );

  test("an unknown request id is rejected unknown-request", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "dlg-x", choiceId: "answer" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: a pi dialog outlives its turn", () => {
  test("the turn ends while the dialog waits: no clearing, and the answer still lands", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    r.proc.emitLine(piSettled(false));
    await draining;
    expect(events.filter((event) => event.kind === "approval-cleared")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    // The dialog is still answerable after the turn ended.
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. A" },
      }),
    ).toEqual({ status: "sent" });
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", value: "1. A" },
    ]);
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: the process ends", () => {
  test("a waiting dialog is cleared process-ended", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    r.proc.exit(1);
    await draining;
    expect(events.find((event) => event.kind === "approval-cleared")).toEqual({
      kind: "approval-cleared",
      requestId: "dlg-1",
      reason: "process-ended",
      v: 1,
    });
    expect(r.session.answerApproval({ id: "d1", requestId: "dlg-1", choiceId: "answer" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    await r.session.close();
  });
});

describe("issue #469: an interrupt while a dialog waits", () => {
  test("the interrupt is written, the turn ends aborted, and the dialog stays waiting", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    const requested = r.session.interrupt({ id: "stop-1" });
    expect(requested.state).toBe("requested");
    expect(stdinRecords(r.proc).some((line) => line.type === "abort")).toBe(true);
    // The cancelled tool result and the aborted settlement.
    r.proc.emitLine(piSettled(true));
    await draining;
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    // Pi announces no withdrawal, so the request keeps waiting.
    expect(events.filter((event) => event.kind === "approval-cleared")).toEqual([]);
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. A" },
      }),
    ).toEqual({ status: "sent" });
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", value: "1. A" },
    ]);
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: a dialog with a native timeout", () => {
  test("the dialog is cleared native-resolved when it expires, and stops being answerable", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1", { timeout: 5000 }));
    // The request itself arrives first, as a bare between-turns event.
    expect(((await r.turns.next()).value as HarnessEvent).kind).toBe("approval-request");
    r.clock.advance(5000);
    const cleared = (await r.turns.next()).value as HarnessEvent;
    expect(cleared).toEqual({
      kind: "approval-cleared",
      requestId: "dlg-1",
      reason: "native-resolved",
      v: 1,
    });
    expect(r.session.answerApproval({ id: "d1", requestId: "dlg-1", choiceId: "answer" })).toEqual({
      status: "rejected",
      reason: "unknown-request",
    });
    expect(responses(r.proc)).toEqual([]);
    r.proc.exit(0);
    await r.session.close();
  });

  test("answering before the timeout cancels the timer", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1", { timeout: 5000 }));
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. A" },
      }),
    ).toEqual({ status: "sent" });
    r.clock.advance(5000);
    // No clearing event follows an answered request.
    expect(r.log.filter((entry) => entry.event === "approval_cleared")).toEqual([]);
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: other extension UI records stay ignored", () => {
  test("notify, setWidget and confirm produce no approval event and write nothing", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(
      JSON.stringify({ type: "extension_ui_request", id: "n-1", method: "notify", message: "hi" }),
    );
    r.proc.emitLine(
      JSON.stringify({ type: "extension_ui_request", id: "w-1", method: "setWidget", widget: {} }),
    );
    r.proc.emitLine(
      JSON.stringify({
        type: "extension_ui_request",
        id: "c-1",
        method: "confirm",
        title: "Sure?",
      }),
    );
    await tick();
    expect(responses(r.proc)).toEqual([]);
    for (const requestId of ["n-1", "w-1", "c-1"]) {
      expect(r.session.answerApproval({ id: "d", requestId, choiceId: "answer" })).toEqual({
        status: "rejected",
        reason: "unknown-request",
      });
    }
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #469: the stall clock", () => {
  test("a dialog on the active turn pauses the clock; one left over from an earlier turn does not", async () => {
    const r = rig({ nativeApprovals: true }, 1000);
    const first = await startPiTurn(r, "a");
    r.proc.emitLine(selectDialog("dlg-1"));
    const firstEvents = drainTurn(first);
    await tick();
    // Past the whole budget while the dialog waits: no stall.
    r.clock.advance(5000);
    expect(r.proc.hasExited).toBe(false);
    expect(r.log.filter((entry) => entry.event === "stall")).toEqual([]);
    // The turn ends with the dialog still waiting.
    r.proc.emitLine(piSettled(false));
    await firstEvents;
    // The next turn's budget counts again: the leftover dialog does not
    // pause it.
    const second = await startPiTurn(r, "b");
    const secondEvents = drainTurn(second);
    await tick();
    r.clock.advance(2000);
    expect(r.log.filter((entry) => entry.event === "stall")).toHaveLength(1);
    r.proc.exit(1);
    await secondEvents;
    await r.session.close();
  });
});

describe("issue #469: a leftover dialog's timeout and the next turn's stall clock", () => {
  test("a dialog from an earlier turn expiring does not restart the active turn's budget", async () => {
    const r = rig({ nativeApprovals: true }, 1000);
    const first = await startPiTurn(r, "a");
    r.proc.emitLine(selectDialog("dlg-1", { timeout: 500 }));
    const firstEvents = drainTurn(first);
    await tick();
    r.proc.emitLine(piSettled(false));
    await firstEvents;
    const second = await startPiTurn(r, "b");
    const secondEvents = drainTurn(second);
    await tick();
    // The leftover dialog expires 600 ms into the second turn's 1000 ms budget.
    r.clock.advance(600);
    await tick();
    expect(r.log.filter((entry) => entry.event === "stall")).toEqual([]);
    // The budget still ends at 1000 ms, not 1000 ms after the expiry.
    r.clock.advance(450);
    expect(r.log.filter((entry) => entry.event === "stall")).toHaveLength(1);
    r.proc.exit(1);
    const events = await secondEvents;
    expect(events).toContainEqual({
      kind: "approval-cleared",
      requestId: "dlg-1",
      reason: "native-resolved",
      v: 1,
    });
    await r.session.close();
  });
});

describe("issue #469: a dialog before the turn's receipt", () => {
  test("publishes the provisional turn and rides inside it", async () => {
    const r = rig({ nativeApprovals: true });
    r.session.send({ id: "a", text: "work" });
    const wire = r.proc.lastSendRequestId();
    // The dialog arrives before pi's prompt receipt.
    r.proc.emitLine(selectDialog("dlg-1"));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    expect(turn.turnId).toBe(`${sid}:turn-1`);
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    r.proc.emitLine(piReceipt(wire, "started"));
    await tick();
    expect(events.find((event) => event.kind === "approval-request")).toMatchObject({
      requestId: "dlg-1",
      turnId: `${sid}:turn-1`,
    });
    r.proc.emitLine(piSettled(false));
    await draining;
    await r.session.close();
  });
});

describe("issue #469: the pending cap", () => {
  test("a dialog beyond the cap is cancelled natively and reported as an error", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    for (let i = 0; i < 32; i++) r.proc.emitLine(selectDialog(`dlg-${i}`));
    await tick();
    r.proc.emitLine(selectDialog("dlg-32"));
    await tick();
    const cancelled = responses(r.proc).filter((line) => line.cancelled === true);
    expect(cancelled).toEqual([{ type: "extension_ui_response", id: "dlg-32", cancelled: true }]);
    expect(events.some((event) => event.kind === "error" && event.message.includes("dlg-32"))).toBe(
      true,
    );
    r.proc.exit(0);
    await draining;
    await r.session.close();
  }, 30_000);
});

describe("issue #469: the Other flow - a select, then a free-text input", () => {
  test("both dialogs reach the host in the turn and each answer is written", async () => {
    const r = rig({ nativeApprovals: true });
    const turn = await startPiTurn(r, "a");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    r.proc.emitLine(selectDialog("dlg-1", { options: ["1. A", "2. B", "3. Other"] }));
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "3. Other" },
      }),
    ).toEqual({ status: "sent" });
    // The extension follows Other with an input dialog.
    r.proc.emitLine(
      JSON.stringify({
        type: "extension_ui_request",
        id: "dlg-2",
        method: "input",
        title: TITLE,
        placeholder: "Type your answer",
      }),
    );
    await tick();
    const requests = events.filter((event) => event.kind === "approval-request");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      requestId: "dlg-2",
      turnId: `${sid}:turn-1`,
      tool: "input",
      questions: [
        {
          question: TITLE,
          freeText: true,
          placeholder: "Type your answer",
          options: [],
        },
      ],
    });
    expect(
      r.session.answerApproval({
        id: "d2",
        requestId: "dlg-2",
        choiceId: "answer",
        answers: { [TITLE]: "C, actually" },
      }),
    ).toEqual({ status: "sent" });
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", value: "3. Other" },
      { type: "extension_ui_response", id: "dlg-2", value: "C, actually" },
    ]);
    r.proc.emitLine(piSettled(false));
    await draining;
    await r.session.close();
  });
});

describe("issue #470: pi's structured question dialog", () => {
  const MARKER = "[hcn-question] ";
  const PREFILL = {
    v: 1,
    questions: [
      {
        question: "Pick toppings",
        header: "Pizza",
        options: [{ label: "Cheese" }, { label: "Olives" }],
        multiSelect: true,
        allowOther: true,
        allowNotes: true,
      },
      {
        question: "Pick a size",
        options: [{ label: "Small" }, { label: "Large" }],
      },
    ],
  };
  const editorDialog = (id: string, prefill: unknown = PREFILL): string =>
    JSON.stringify({
      type: "extension_ui_request",
      id,
      method: "editor",
      title: `${MARKER}Pick toppings`,
      prefill: typeof prefill === "string" ? prefill : JSON.stringify(prefill),
    });

  test("a marked dialog is relayed as a question with its whole question set", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(editorDialog("dlg-1"));
    await tick();
    const event = (await r.turns.next()).value as HarnessEvent;
    expect(event).toEqual({
      kind: "approval-request",
      v: 1,
      requestId: "dlg-1",
      sessionId: sid,
      category: "question",
      tool: "editor",
      details: "Pick toppings",
      input: {
        type: "extension_ui_request",
        id: "dlg-1",
        method: "editor",
        title: `${MARKER}Pick toppings`,
        prefill: JSON.stringify(PREFILL),
      },
      questions: [
        {
          question: "Pick toppings",
          header: "Pizza",
          multiSelect: true,
          allowOther: true,
          allowNotes: true,
          options: [{ label: "Cheese" }, { label: "Olives" }],
        },
        {
          question: "Pick a size",
          multiSelect: false,
          allowOther: false,
          allowNotes: false,
          options: [{ label: "Small" }, { label: "Large" }],
        },
      ],
      choices: [
        { id: "answer", label: "Answer", scope: "once" },
        { id: "decline", label: "Decline to answer", scope: "deny" },
      ],
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("two checkboxes, an other text and a note become the editor's value", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(editorDialog("dlg-1"));
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { "Pick toppings": ["Cheese", "Olives", "Anchovies"], "Pick a size": "Small" },
        notes: { "Pick toppings": "no anchovies" },
      }),
    ).toEqual({ status: "sent" });
    const written = responses(r.proc);
    expect(written).toHaveLength(1);
    expect(JSON.parse(String(written[0]?.value))).toEqual({
      answers: { "Pick toppings": ["Cheese", "Olives", "Anchovies"], "Pick a size": "Small" },
      notes: { "Pick toppings": "no anchovies" },
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a decline cancels the dialog", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(editorDialog("dlg-1"));
    await tick();
    expect(r.session.answerApproval({ id: "d1", requestId: "dlg-1", choiceId: "decline" })).toEqual(
      { status: "sent" },
    );
    expect(responses(r.proc)).toEqual([
      { type: "extension_ui_response", id: "dlg-1", cancelled: true },
    ]);
    r.proc.exit(0);
    await r.session.close();
  });

  test.each([
    ["prefill that is not JSON", "{not json"],
    ["a missing version", JSON.stringify({ questions: [{ question: "q" }] })],
    [
      "duplicate option labels",
      JSON.stringify({
        v: 1,
        questions: [{ question: "q", options: [{ label: "A" }, { label: "A" }] }],
      }),
    ],
    ["no questions", JSON.stringify({ v: 1, questions: [] })],
  ])(
    "an invalid prefill is an error event and nothing is forwarded: %s",
    async (_label, prefill) => {
      const r = rig({ nativeApprovals: true });
      const events: HarnessEvent[] = [];
      const draining = (async () => {
        for await (const event of r.session.turns) {
          if (!isSessionTurn(event)) events.push(event);
        }
      })();
      r.proc.emitLine(editorDialog("dlg-1", prefill));
      await tick();
      const errors = events.filter((event) => event.kind === "error");
      expect(errors).toHaveLength(1);
      const message = String((errors[0] as { message: string }).message);
      expect(message).toContain("dlg-1");
      expect(message).toContain("hcn-question prefill is invalid");
      expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
      expect(responses(r.proc)).toEqual([]);
      r.proc.exit(0);
      await draining;
      await r.session.close();
    },
  );

  test("an unmarked editor dialog stays ignored", async () => {
    const r = rig({ nativeApprovals: true });
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of r.session.turns) {
        if (!isSessionTurn(event)) events.push(event);
      }
    })();
    r.proc.emitLine(
      JSON.stringify({
        type: "extension_ui_request",
        id: "dlg-1",
        method: "editor",
        title: "Edit the file",
        prefill: "hello",
      }),
    );
    await tick();
    expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
    expect(responses(r.proc)).toEqual([]);
    r.proc.exit(0);
    await draining;
    await r.session.close();
  });

  test("notes on a plain pi select are refused invalid-notes", async () => {
    const r = rig({ nativeApprovals: true });
    r.proc.emitLine(selectDialog("dlg-1"));
    await tick();
    expect(
      r.session.answerApproval({
        id: "d1",
        requestId: "dlg-1",
        choiceId: "answer",
        answers: { [TITLE]: "1. A" },
        notes: { [TITLE]: "no" },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-notes" });
    expect(responses(r.proc)).toEqual([]);
    r.proc.exit(0);
    await r.session.close();
  });
});
