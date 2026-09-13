import { expect, test } from "vitest";
import { AsyncChannel } from "../../src/execution/channel.js";
import type { RunnerDeps, SpawnedProcess } from "../../src/execution/deps.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import type { TurnRunOptions } from "../../src/execution/stream-turn.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { NativeSettingsSnapshot } from "../../src/knowledge/native-settings.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const saved: NativeSettingsSnapshot = {
  cwd: "/fixture",
  effort: "high",
  fingerprint: "a".repeat(64),
  harness: "codex",
  model: "saved-model",
  permissions: {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    filesystem: "read-only",
    network: "restricted",
    status: "recorded",
  },
  provider: "saved-provider",
  sessionId: "907feafe-e82b-4df4-91ba-4f1aeb987508",
  source: "codex-rollout-v1",
  status: "available",
  v: 1,
};

const options: TurnRunOptions = {
  cwd: saved.cwd,
  nativeApprovals: true,
  nativeSettingsFingerprint: saved.fingerprint,
  prompt: "fixture",
  questions: "none",
  resume: saved.sessionId,
};

class ApprovalPeer extends FakeProcess {
  afterStart?: () => void;
  resumeModel = saved.model;
  constructor(private readonly beforeAck = false) {
    super();
  }
  requestApproval(nativeId = 7): void {
    this.emitLine(
      JSON.stringify({
        id: nativeId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: saved.sessionId,
          turnId: "native-turn",
          itemId: "command",
          startedAtMs: 0,
          command: "echo fixture",
          cwd: saved.cwd,
          availableDecisions: ["accept", "decline", "cancel"],
        },
      }),
    );
  }
  override get stdin(): SpawnedProcess["stdin"] {
    const pipe = super.stdin;
    if (!pipe) return undefined;
    return {
      end: () => pipe.end(),
      write: (text: string): void => {
        pipe.write(text);
        const message = JSON.parse(text) as Record<string, unknown>;
        if (message.method === "initialize")
          this.emitLine(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
        if (message.method === "thread/resume")
          this.emitLine(
            JSON.stringify({
              id: message.id,
              result: {
                thread: { id: saved.sessionId },
                cwd: saved.cwd,
                model: this.resumeModel,
                modelProvider: saved.provider,
                reasoningEffort: saved.effort,
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                activePermissionProfile: null,
                sandbox: { type: "readOnly", networkAccess: false },
              },
            }),
          );
        if (message.method === "turn/start") {
          if (this.beforeAck) this.requestApproval();
          this.emitLine(
            JSON.stringify({ id: message.id, result: { turn: { id: "native-turn" } } }),
          );
          if (!this.beforeAck) this.requestApproval();
          this.afterStart?.();
        }
      },
    };
  }
  complete(): void {
    this.emitLine(
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { threadId: saved.sessionId, requestId: 7 },
      }),
    );
    this.emitLine(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: saved.sessionId,
          turn: { id: "native-turn", status: "completed", error: null },
        },
      }),
    );
  }
}

function setup(beforeAck = false): {
  readonly proc: ApprovalPeer;
  readonly input: AsyncChannel<string | Uint8Array>;
  readonly deps: RunnerDeps;
  readonly clock: FakeClock;
} {
  const proc = new ApprovalPeer(beforeAck);
  const input = new AsyncChannel<string | Uint8Array>();
  const clock = new FakeClock();
  const spawner = fakeSpawner([proc]);
  const signals = fakeSignal();
  return {
    proc,
    input,
    clock,
    deps: {
      ...spawner,
      clock,
      signal: signals.signal,
      inspectNativeSettings: () => saved,
      approvalInput: {
        chunks: input,
        close: () => input.close(),
        newId: () => "207feafe-e82b-4df4-91ba-4f1aeb987508",
      },
    },
  };
}

test("a verified native resume reports its harness-confirmed identity before approval requests", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") f.proc.complete();
  }
  expect(events.filter((event) => event.kind === "identity")).toEqual([
    expect.objectContaining({
      authority: "harness-minted",
      sessionId: saved.sessionId,
    }),
  ]);
  expect(events.findIndex((event) => event.kind === "identity")).toBeLessThan(
    events.findIndex((event) => event.kind === "approval-request"),
  );
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
});

test("a malformed native error cannot disappear into a clean completion", async () => {
  const f = setup();
  f.proc.requestApproval = () => {
    f.proc.emitLine(
      JSON.stringify({
        method: "error",
        params: { threadId: saved.sessionId, turnId: "native-turn", error: { message: "fixture" } },
      }),
    );
    f.proc.complete();
  };
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) events.push(event);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { nativeApproval: { reason: "unsupported-native-interaction" } },
  });
});

test("a failed completion retains the native error even without an earlier error notification", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request")
      f.proc.emitLine(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: saved.sessionId,
            turn: {
              id: "native-turn",
              status: "failed",
              error: {
                message: "Fixture native refusal",
                additionalDetails: "Fixture explanation",
              },
            },
          },
        }),
      );
  }
  expect(events.filter((event) => event.kind === "error")).toEqual([
    { kind: "error", terminal: true, message: "Fixture native refusal\nFixture explanation" },
  ]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: {
      message: expect.stringContaining("Fixture native refusal"),
      nativeApproval: { prompt: "acknowledged" },
    },
  });
});

test.each([true, false])(
  "native error retry=%s preserves its explanation and terminal meaning",
  async (willRetry) => {
    const f = setup();
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(codexCli, options, f.deps)) {
      events.push(event);
      if (event.kind === "approval-request") {
        f.proc.emitLine(
          JSON.stringify({
            method: "error",
            params: {
              threadId: saved.sessionId,
              turnId: "native-turn",
              willRetry,
              error: {
                message: "Fixture provider disconnected",
                additionalDetails: "Fixture detail",
              },
            },
          }),
        );
        f.proc.complete();
      }
    }
    expect(events.filter((event) => event.kind === "error")).toEqual([
      {
        kind: "error",
        message: "Fixture provider disconnected\nFixture detail",
        terminal: !willRetry,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: willRetry ? "clean" : "failed" });
    if (!willRetry)
      expect(events.at(-1)).toMatchObject({
        failure: { nativeApproval: { reason: "native-process-failed" } },
      });
    expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  },
);

test("native streamed text and tool activity remain visible around an approval", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      for (const message of [
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: saved.sessionId,
            turnId: "native-turn",
            itemId: "answer",
            delta: "Working",
          },
        },
        {
          method: "item/started",
          params: {
            threadId: saved.sessionId,
            turnId: "native-turn",
            item: {
              id: "tool",
              type: "commandExecution",
              command: "echo fixture",
              cwd: saved.cwd,
              status: "inProgress",
            },
          },
        },
        {
          method: "item/completed",
          params: {
            threadId: saved.sessionId,
            turnId: "native-turn",
            item: { id: "answer", type: "agentMessage", text: "Working. Done." },
          },
        },
      ])
        f.proc.emitLine(JSON.stringify(message));
      f.proc.complete();
    }
  }
  expect(events.filter((event) => ["token", "tool", "message"].includes(event.kind))).toEqual([
    { kind: "token", text: "Working" },
    { kind: "tool", name: "shell", input: "echo fixture" },
    { kind: "message", role: "assistant", text: "Working. Done." },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
});

test.each(["initialize", "thread/resume", "turn/start"] as const)(
  "a missing %s acknowledgement preserves submission evidence at the protocol deadline",
  async (method) => {
    const f = setup();
    const pipe = f.proc.stdin;
    let reached: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const proc: SpawnedProcess = {
      ...f.proc,
      started: Promise.resolve({ kind: "started", owner: undefined }),
      disposeOutput: () => f.proc.disposeOutput(),
      stdin: {
        end: () => pipe?.end(),
        write: (text) => {
          if (JSON.parse(text).method === method) {
            f.proc.stdinWrites.push(text);
            reached?.();
          } else pipe?.write(text);
        },
      },
    };
    const events: HarnessEvent[] = [];
    const collecting = (async () => {
      for await (const event of streamTurn(codexCli, options, {
        ...f.deps,
        spawn: () => proc,
        signal: (_proc, sig) => f.deps.signal(f.proc, sig),
      }))
        events.push(event);
    })();
    await ready;
    f.clock.advance(30000);
    await collecting;
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: {
        nativeApproval: {
          process: "started",
          prompt: method === "turn/start" ? "submission-unknown" : "not-submitted",
          reason: "native-protocol-timeout",
        },
      },
    });
    expect(
      f.proc.stdinLines
        .map((line) => JSON.parse(line))
        .filter((value) => value.method === "turn/start"),
    ).toHaveLength(method === "turn/start" ? 1 : 0);
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);

test.each([32, 33])(
  "%i concurrent native requests retain exact answers or fail the whole attempt at the bound",
  async (count) => {
    const f = setup();
    const request = f.proc.requestApproval.bind(f.proc);
    f.proc.requestApproval = () => {
      for (let id = 1; id <= count; id++) request(id);
    };
    let sequence = 0;
    const uuid = (value: number): string =>
      `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    const events: HarnessEvent[] = [];
    const requests: string[] = [];
    let sent = 0;
    for await (const event of streamTurn(codexCli, options, {
      ...f.deps,
      approvalInput: {
        chunks: f.input,
        close: () => f.input.close(),
        newId: () => uuid(++sequence),
      },
    })) {
      events.push(event);
      if (event.kind === "approval-request") {
        requests.push(event.requestId);
        if (count === 32 && requests.length === count)
          await f.input.push(
            requests
              .toReversed()
              .map((requestId, index) =>
                JSON.stringify({
                  v: 1,
                  op: "approval",
                  id: uuid(100 + index),
                  requestId,
                  choiceId: "once",
                }),
              )
              .join("\n") + "\n",
          );
      }
      if (event.kind === "approval-disposition" && event.status === "sent" && ++sent === count)
        f.proc.complete();
    }
    expect(requests).toHaveLength(32);
    const writes = f.proc.stdinLines
      .map((line) => JSON.parse(line))
      .filter((value) => typeof value.id === "number" && value.result);
    expect(writes.map((write) => write.id)).toEqual(
      count === 32 ? Array.from({ length: 32 }, (_, index) => 32 - index) : [],
    );
    expect(events.filter((event) => event.kind === "approval-cleared")).toHaveLength(32);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: count === 32 ? "clean" : "failed" });
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);

test("buffered initialization replies after observed exit cannot resume or submit a prompt", async () => {
  const f = setup();
  const proc = new FakeProcess();
  proc.emitLine(JSON.stringify({ id: "hcn-initialize", result: { userAgent: "fixture" } }));
  proc.exit(1);
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, { ...f.deps, spawn: () => proc }))
    events.push(event);
  expect(
    proc.stdinLines
      .map((line) => JSON.parse(line))
      .filter((v) => v.method === "thread/resume" || v.method === "turn/start"),
  ).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { nativeApproval: { prompt: "not-submitted" } },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a buffered turn acknowledgement after exit retains submission evidence without offering dead requests", async () => {
  const f = setup(true);
  f.proc.afterStart = () => f.proc.exit(1);
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) events.push(event);
  expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { nativeApproval: { prompt: "acknowledged" } },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("an asynchronous no-child startup failure retains explicit process and prompt evidence", async () => {
  const f = setup();
  const proc = new FakeProcess();
  const events: HarnessEvent[] = [];
  proc.failToStart("spawn codex ENOENT");
  const spawned: SpawnedProcess = {
    ...proc,
    stdin: proc.stdin,
    disposeOutput: () => proc.disposeOutput(),
    startupError: () => proc.startupError(),
    started: Promise.resolve({ kind: "not-started", code: "ENOENT" }),
  };
  for await (const event of streamTurn(codexCli, options, { ...f.deps, spawn: () => spawned }))
    events.push(event);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: {
      class: "transport",
      nativeApproval: { process: "not-started", prompt: "not-submitted", reason: "spawn-failed" },
    },
  });
  expect(
    proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.method === "turn/start"),
  ).toEqual([]);
  expect(f.input.isClosed).toBe(true);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a reused native request identity is refused even after its first request was cleared", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  let sequence = 0;
  const deps: RunnerDeps = {
    ...f.deps,
    approvalInput: {
      chunks: f.input,
      close: () => f.input.close(),
      newId: () => `${++sequence}07feafe-e82b-4df4-91ba-4f1aeb987508`,
    },
  };
  for await (const event of streamTurn(codexCli, options, deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      if (sequence === 1) {
        f.proc.emitLine(
          JSON.stringify({
            method: "serverRequest/resolved",
            params: { threadId: saved.sessionId, requestId: 7 },
          }),
        );
        f.proc.requestApproval();
      } else f.proc.complete();
    }
  }
  expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { nativeApproval: { reason: "unsupported-native-interaction" } },
  });
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("abandoning the event consumer never writes a decision buffered during channel cleanup", async () => {
  const f = setup();
  let release: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestId = "207feafe-e82b-4df4-91ba-4f1aeb987508";
  const deps: RunnerDeps = {
    ...f.deps,
    signal: () => {},
    approvalInput: {
      close: () => release?.(),
      newId: () => requestId,
      chunks: (async function* () {
        await closed;
        yield `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId, choiceId: "once" })}\n`;
        f.proc.exit(null);
      })(),
    },
  };
  for await (const event of streamTurn(codexCli, options, deps))
    if (event.kind === "approval-request") break;
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(f.proc.hasExited).toBe(true);
  expect(f.proc.outputDisposed).toBe(true);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a native interrupted response clears approval and reports cancellation without a task failure", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request")
      f.proc.emitLine(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: saved.sessionId,
            turn: { id: "native-turn", status: "interrupted", error: null },
          },
        }),
      );
  }
  expect(events.filter((event) => event.kind === "failure")).toEqual([]);
  expect(events.filter((event) => event.kind === "approval-cleared")).toMatchObject([
    { reason: "turn-ended" },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("repeating the same approval decision returns its disposition without a second native write", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      const command = JSON.stringify({
        v: 1,
        op: "approval",
        id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
        requestId: event.requestId,
        choiceId: "once",
      });
      await f.input.push(`${command}\n${command}\n`);
    }
    if (
      event.kind === "approval-disposition" &&
      events.filter((e) => e.kind === "approval-disposition").length === 2
    )
      f.proc.complete();
  }
  expect(events.filter((e) => e.kind === "approval-disposition")).toMatchObject([
    { status: "sent" },
    { status: "sent" },
  ]);
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
    { id: 7, result: { decision: "accept" } },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("native requests arriving before turn acknowledgement wait for exact turn correlation", async () => {
  const f = setup(true);
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request")
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: "once" })}\n`,
      );
    if (event.kind === "approval-disposition") f.proc.complete();
  }
  expect(events.filter((e) => e.kind === "approval-request")).toMatchObject([
    { sessionId: saved.sessionId, turnId: "native-turn" },
  ]);
  expect(events.filter((e) => e.kind === "failure")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("changed saved settings refuse with terminal evidence before a native approval process starts", async () => {
  const f = setup();
  let spawns = 0;
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, {
    ...f.deps,
    inspectNativeSettings: () => ({ ...saved, fingerprint: "b".repeat(64) }),
    spawn: (argv, options) => {
      spawns++;
      return f.deps.spawn(argv, options);
    },
  }))
    events.push(event);
  expect(spawns).toBe(0);
  expect(events).toMatchObject([
    { kind: "failure", class: "rejected", issue: "native-settings-changed", retryable: false },
    {
      kind: "done",
      cause: "failed",
      failure: {
        issue: "native-settings-changed",
        nativeApproval: {
          phase: "preflight",
          process: "not-attempted",
          prompt: "not-submitted",
          reason: "native-settings-changed",
        },
      },
    },
  ]);
  expect(f.input.isClosed).toBe(true);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("human approval waits pause inactivity and sending the answer restarts the budget", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, { ...f.deps, stallMs: 10 })) {
    events.push(event);
    if (event.kind === "approval-request") {
      f.clock.advance(100);
      expect(f.proc.hasExited).toBe(false);
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: "once" })}\n`,
      );
    }
    if (event.kind === "approval-disposition" && event.status === "sent") {
      f.clock.advance(11);
      expect(f.proc.hasExited).toBe(true);
    }
  }
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("an already cancelled approval turn creates no native process", async () => {
  const f = setup();
  const controller = new AbortController();
  controller.abort();
  let spawns = 0;
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(
    codexCli,
    {
      ...options,
      signal: controller.signal,
    },
    {
      ...f.deps,
      spawn: (argv, options) => {
        spawns++;
        return f.deps.spawn(argv, options);
      },
    },
  ))
    events.push(event);
  expect(spawns).toBe(0);
  expect(events).toMatchObject([{ kind: "done", cause: "killed" }]);
  expect(f.input.isClosed).toBe(true);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a decision exceeding 4 KiB including its newline closes the channel without answering", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      const command = JSON.stringify({
        v: 1,
        op: "approval",
        id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
        requestId: event.requestId,
        choiceId: "once",
      });
      await f.input.push(`${command.padStart(4096, " ")}\n`);
    }
    // Let the old behavior finish, so the assertion reports the unwanted answer.
    if (event.kind === "approval-disposition") f.proc.complete();
  }
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { retryable: false },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("complete buffered decisions are processed in order before a later oversized frame ends the channel", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      const command = JSON.stringify({
        v: 1,
        op: "approval",
        id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
        requestId: event.requestId,
        choiceId: "once",
      });
      await f.input.push(`${command}\n${" ".repeat(4097)}`);
    }
  }
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
    { id: 7, result: { decision: "accept" } },
  ]);
  expect(events.filter((event) => event.kind === "approval-disposition")).toMatchObject([
    { status: "sent" },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a native clear from a different thread cannot settle this attempt's request", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      f.proc.emitLine(
        JSON.stringify({
          method: "serverRequest/resolved",
          params: { threadId: "another-thread", requestId: 7 },
        }),
      );
      f.proc.complete();
    }
  }
  expect(events.filter((event) => event.kind === "approval-cleared")).toMatchObject([
    { reason: "channel-failed" },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("cancelling a live approval wait cleans up without answering and reports killed", async () => {
  const f = setup();
  const controller = new AbortController();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(
    codexCli,
    { ...options, signal: controller.signal },
    f.deps,
  )) {
    events.push(event);
    if (event.kind === "approval-request") controller.abort();
    if (event.kind === "done") expect(f.proc.hasExited).toBe(true);
  }
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(f.input.isClosed).toBe(true);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("the explicit hard deadline still expires while a native approval awaits a person", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, { ...f.deps, turnTimeoutMs: 50 })) {
    events.push(event);
    if (event.kind === "approval-request") f.clock.advance(51);
    if (event.kind === "done") expect(f.proc.hasExited).toBe(true);
  }
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "killed",
    failure: { class: "timeout", retryable: false },
  });
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a buffered decision cannot write to a process whose exit is already observed", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      f.proc.exit(0);
      await f.input.push(
        `${JSON.stringify({
          v: 1,
          op: "approval",
          id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
          requestId: event.requestId,
          choiceId: "once",
        })}\n`,
      );
    }
  }
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(
    events.filter((event) => event.kind === "approval-disposition" && event.status === "sent"),
  ).toEqual([]);
  expect(events.filter((event) => event.kind === "approval-disposition")).toMatchObject([
    {
      id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      status: "rejected",
      reason: "request-unavailable",
    },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test.each(["utf8-overflow", "invalid-utf8", "partial-eof"] as const)(
  "unusable decision framing ends the wait without answering: %s",
  async (variant) => {
    const f = setup();
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(codexCli, options, f.deps)) {
      events.push(event);
      if (event.kind === "approval-request") {
        const command = JSON.stringify({
          v: 1,
          op: "approval",
          id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
          requestId: event.requestId,
          choiceId: variant === "utf8-overflow" ? "界".repeat(1400) : "once",
        });
        await f.input.push(
          variant === "invalid-utf8"
            ? new Uint8Array([255, 10])
            : `${command}${variant === "partial-eof" ? "" : "\n"}`,
        );
        if (variant === "partial-eof") f.input.close();
      }
      if (event.kind === "approval-disposition") f.proc.complete();
    }
    expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { retryable: false },
    });
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);

test("decision refusals identify the cause, remain repeatable and preserve one response right", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      const base = {
        v: 1,
        op: "approval",
        id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
        requestId: event.requestId,
        choiceId: "once",
      };
      const unknownChoice = { ...base, choiceId: "not-offered" };
      const accepted = { ...base, id: "407feafe-e82b-4df4-91ba-4f1aeb987508" };
      const commands = [
        { ...base, extra: true },
        unknownChoice,
        unknownChoice,
        base,
        {
          ...base,
          id: "507feafe-e82b-4df4-91ba-4f1aeb987508",
          requestId: "607feafe-e82b-4df4-91ba-4f1aeb987508",
        },
        accepted,
        { ...base, id: "707feafe-e82b-4df4-91ba-4f1aeb987508" },
        accepted,
        { ...accepted, choiceId: "deny" },
      ];
      await f.input.push(`${commands.map((command) => JSON.stringify(command)).join("\n")}\n`);
    }
    if (
      event.kind === "approval-disposition" &&
      events.filter((e) => e.kind === "approval-disposition").length === 9
    )
      f.proc.complete();
  }
  expect(events.filter((e) => e.kind === "approval-disposition")).toMatchObject([
    { status: "rejected", reason: "invalid-decision" },
    { status: "rejected", reason: "choice-unavailable" },
    { status: "rejected", reason: "choice-unavailable" },
    { status: "rejected", reason: "decision-conflict" },
    { status: "rejected", reason: "request-unavailable" },
    { status: "sent" },
    { status: "rejected", reason: "request-unavailable" },
    { status: "sent" },
    { status: "rejected", reason: "decision-conflict" },
  ]);
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
    { id: 7, result: { decision: "accept" } },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a request cleared before turn acknowledgement is never published as answerable", async () => {
  const f = setup(true);
  const requestApproval = f.proc.requestApproval.bind(f.proc);
  f.proc.requestApproval = () => {
    requestApproval();
    f.proc.emitLine(
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { threadId: saved.sessionId, requestId: 7 },
      }),
    );
  };
  f.proc.afterStart = () => f.proc.complete();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) events.push(event);
  expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("native command session choices retain their scope with the current optional request fields", async () => {
  const f = setup();
  f.proc.requestApproval = () =>
    f.proc.emitLine(
      JSON.stringify({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: saved.sessionId,
          turnId: "native-turn",
          itemId: "command",
          startedAtMs: 0,
          command: "echo fixture",
          cwd: saved.cwd,
          kind: "command",
          environmentId: null,
          approvalId: null,
          additionalPermissions: null,
          commandActions: [],
          networkApprovalContext: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          reason: "Fixture scope",
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
        },
      }),
    );
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      expect(event.choices).toEqual([
        { id: "once", label: "Approve once", scope: "once" },
        { id: "session", label: "Approve for this native session", scope: "session" },
        { id: "deny", label: "Deny", scope: "deny" },
        { id: "cancel", label: "Cancel this response", scope: "cancel" },
      ]);
      expect(event.details).toContain("echo fixture");
      expect(event.details).toContain("Fixture scope");
      expect(event.details).toContain("future requests");
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: "session" })}\n`,
      );
    }
    if (event.kind === "approval-disposition") f.proc.complete();
  }
  expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
    { id: 7, result: { decision: "acceptForSession" } },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a native persistent command rule shows its exact argument prefix and forwards only the offered rule", async () => {
  const f = setup();
  const prefix = ["/bin/zsh", "-lc", "echo fixture"];
  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } };
  f.proc.requestApproval = () =>
    f.proc.emitLine(
      JSON.stringify({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: saved.sessionId,
          turnId: "native-turn",
          itemId: "command",
          startedAtMs: 0,
          command: "/bin/zsh -lc 'echo fixture'",
          cwd: saved.cwd,
          kind: "command",
          environmentId: "local",
          commandActions: [{ type: "unknown", command: "echo fixture" }],
          proposedExecpolicyAmendment: prefix,
          availableDecisions: ["accept", rule, "cancel"],
        },
      }),
    );
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      expect(event.choices).toContainEqual({
        id: "rule",
        label: "Approve and save this rule",
        scope: "persistent",
      });
      expect(event.details).toContain(JSON.stringify(prefix));
      expect(event.details).toContain("Future matching commands");
      expect(event.details).toContain("Environment: local");
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: "rule" })}\n`,
      );
    }
    if (event.kind === "approval-disposition") f.proc.complete();
  }
  expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
    { id: 7, result: { decision: rule } },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("file approval includes the complete matching patch before an answer is offered", async () => {
  const f = setup(true);
  const changes = [
    { path: "/fixture/added.txt", kind: { type: "add" }, diff: "+hello 界\n" },
    {
      path: "/fixture/old.txt",
      kind: { type: "update", move_path: "/fixture/new.txt" },
      diff: "-old\n+new\n",
    },
    { path: "/fixture/deleted.txt", kind: { type: "delete" }, diff: "-removed\n" },
  ];
  f.proc.requestApproval = () => {
    f.proc.emitLine(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: saved.sessionId,
          turnId: "native-turn",
          startedAtMs: 0,
          item: { id: "patch", type: "fileChange", status: "inProgress", changes },
        },
      }),
    );
    f.proc.emitLine(
      JSON.stringify({
        id: 7,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: saved.sessionId,
          turnId: "native-turn",
          itemId: "patch",
          startedAtMs: 0,
          reason: "Apply the fixture patch",
          grantRoot: null,
        },
      }),
    );
  };
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      expect(event.category).toBe("file-change");
      for (const change of changes) {
        expect(event.details).toContain(change.path);
        expect(event.details).toContain(change.diff);
      }
      expect(event.details).toContain("/fixture/new.txt");
      expect(event.details).toContain("Apply the fixture patch");
      expect(event.details).toContain("future changes to these same files");
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: "once" })}\n`,
      );
    }
    if (event.kind === "approval-disposition") f.proc.complete();
  }
  expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
    { id: 7, result: { decision: "accept" } },
  ]);
  expect(events.filter((event) => event.kind === "tool")).toMatchObject([
    { name: "file_change", input: expect.stringContaining("/fixture/added.txt") },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test.each(["turn", "session", "deny"] as const)(
  "permission subsets are exact and preserve the chosen duration: %s",
  async (choiceId) => {
    const f = setup();
    const permissions = {
      fileSystem: {
        entries: [
          { path: { type: "path", path: "/fixture/output" }, access: "write" },
          { path: { type: "path", path: "/fixture/input" }, access: "read" },
        ],
      },
      network: { enabled: true },
    };
    f.proc.requestApproval = () =>
      f.proc.emitLine(
        JSON.stringify({
          id: 7,
          method: "item/permissions/requestApproval",
          params: {
            threadId: saved.sessionId,
            turnId: "native-turn",
            itemId: "permissions",
            startedAtMs: 0,
            cwd: saved.cwd,
            environmentId: "local",
            reason: "Fixture permission subset",
            permissions,
          },
        }),
      );
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(codexCli, options, f.deps)) {
      events.push(event);
      if (event.kind === "approval-request") {
        expect(event.category).toBe("permissions");
        expect(event.choices).toEqual([
          { id: "turn", label: "Grant for this response", scope: "turn" },
          { id: "session", label: "Grant for this native session", scope: "session" },
          { id: "deny", label: "Deny", scope: "deny" },
        ]);
        expect(event.details).toContain('Write access: "/fixture/output"');
        expect(event.details).toContain('Read access: "/fixture/input"');
        expect(event.details).toContain("Network access: enabled");
        expect(event.details).toContain("Fixture permission subset");
        await f.input.push(
          `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId })}\n`,
        );
      }
      if (event.kind === "approval-disposition") f.proc.complete();
    }
    expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
    expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([
      {
        id: 7,
        result: {
          permissions: choiceId === "deny" ? {} : permissions,
          scope: choiceId === "session" ? "session" : "turn",
        },
      },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);

test("invalid native UTF-8 cannot become a changed but answerable command", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  const deps: RunnerDeps = {
    ...f.deps,
    signal: (_proc, signal) => f.deps.signal(f.proc, signal),
    spawn: (argv, options) => {
      const proc = f.deps.spawn(argv, options);
      return {
        exited: proc.exited,
        stderr: proc.stderr,
        stdin: proc.stdin,
        disposeOutput: () => proc.disposeOutput(),
        stdout: (async function* () {
          for await (const chunk of proc.stdout) {
            const bytes =
              typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice();
            const text = new TextDecoder().decode(bytes);
            const at = text.indexOf("echo fixture");
            if (at !== -1) bytes[at] = 255;
            yield bytes;
          }
        })(),
      };
    },
  };
  for await (const event of streamTurn(codexCli, options, deps)) {
    events.push(event);
    if (event.kind === "approval-request") f.proc.complete();
  }
  expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { retryable: false },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("effective settings mismatch reports structured no-prompt evidence after cleanup", async () => {
  const f = setup();
  f.proc.resumeModel = "changed-model";
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "done") expect(f.proc.hasExited).toBe(true);
  }
  const evidence = {
    reason: "native-settings-mismatch",
    phase: "resume",
    prompt: "not-submitted",
    process: "unknown",
  };
  expect(events).toMatchObject([
    { kind: "failure", retryable: false, nativeApproval: evidence },
    { kind: "done", cause: "failed", failure: { nativeApproval: evidence } },
  ]);
  expect(
    f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.method === "turn/start"),
  ).toEqual([]);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("invalid environment entries use the established refusal before native spawn", async () => {
  const f = setup();
  let spawns = 0;
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(
    codexCli,
    { ...options, env: { "BAD-KEY": "fixture" } },
    {
      ...f.deps,
      spawn: (argv, options) => {
        spawns++;
        return f.deps.spawn(argv, options);
      },
    },
  ))
    events.push(event);
  expect(spawns).toBe(0);
  expect(events).toMatchObject([
    { kind: "failure", class: "rejected", issue: "invalid-env" },
    { kind: "done", cause: "failed", failure: { issue: "invalid-env" } },
  ]);
});

test("a classified native failure revokes pending answers and retains its failure classification", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  let requestId = "";
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") {
      requestId = event.requestId;
      f.proc.emitStderr("invalid api key");
    }
    if (event.kind === "error") {
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId, choiceId: "once" })}\n`,
      );
      f.input.close();
    }
  }
  expect(f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7)).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: {
      class: "auth",
      nativeApproval: { reason: "native-process-failed", prompt: "acknowledged" },
    },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("a synchronous native spawn error closes the input and returns terminal evidence", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, {
    ...f.deps,
    spawn: () => {
      throw new Error("fixture spawn failure");
    },
  }))
    events.push(event);
  expect(events).toMatchObject([
    { kind: "error" },
    {
      kind: "failure",
      class: "transport",
      nativeApproval: {
        reason: "spawn-failed",
        phase: "preflight",
        prompt: "not-submitted",
        process: "unknown",
      },
    },
    { kind: "done", cause: "failed", exitCode: 127 },
  ]);
  expect(f.input.isClosed).toBe(true);
  expect(f.clock.pendingTimerCount).toBe(0);
});

test.each(["clean", "refused", "spawn-failed"] as const)(
  "native approval boundary logs retain attempt correlation: %s",
  async (variant) => {
    const f = setup();
    const logs: Record<string, unknown>[] = [];
    const deps: RunnerDeps = {
      ...f.deps,
      log: (event) => {
        logs.push(event);
      },
      turnId: "caller-attempt",
      ...(variant === "spawn-failed"
        ? {
            spawn: () => {
              throw new Error("fixture spawn failure");
            },
          }
        : {}),
    };
    const opts =
      variant === "refused" ? { ...options, nativeSettingsFingerprint: "b".repeat(64) } : options;
    for await (const event of streamTurn(codexCli, opts, deps))
      if (event.kind === "approval-request") f.proc.complete();
    expect(logs.map((event) => event.event)).toEqual(
      variant === "refused" ? ["rejected"] : ["spawn", "exit"],
    );
    for (const log of logs) {
      expect(log.turnId).toBe("caller-attempt");
      expect(log.harness).toBe("codex");
      expect(log.sessionId).toBe(saved.sessionId);
      expect(log).not.toHaveProperty("prompt");
      expect(log).not.toHaveProperty("details");
    }
    if (variant !== "refused")
      expect(logs.at(-1)).toMatchObject({ cause: variant === "clean" ? "clean" : "failed" });
  },
);

test("repeated generated request identity never exposes two different native actions under one control", async () => {
  const f = setup();
  f.proc.requestApproval = () => {
    for (const id of [7, 8])
      f.proc.emitLine(
        JSON.stringify({
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: saved.sessionId,
            turnId: "native-turn",
            itemId: `command-${id}`,
            startedAtMs: 0,
            command: `echo fixture-${id}`,
            cwd: saved.cwd,
            availableDecisions: ["accept", "cancel"],
          },
        }),
      );
  };
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (
      event.kind === "approval-request" &&
      events.filter((e) => e.kind === "approval-request").length === 2
    ) {
      await f.input.push(
        `${JSON.stringify({ v: 1, op: "approval", id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: "once" })}\n`,
      );
    }
    if (event.kind === "approval-disposition") f.proc.complete();
  }
  expect(events.filter((event) => event.kind === "approval-request")).toHaveLength(1);
  expect(
    f.proc.stdinLines.map((line) => JSON.parse(line)).filter((v) => v.id === 7 || v.id === 8),
  ).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { retryable: false },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test("an oversized decision reports the framing defect without exposing its payload", async () => {
  const f = setup();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, f.deps)) {
    events.push(event);
    if (event.kind === "approval-request") await f.input.push("x".repeat(4097));
  }
  const failure = events.find((event) => event.kind === "failure");
  expect(failure?.kind === "failure" && failure.message).toContain("frame-too-large");
  expect(failure?.kind === "failure" && failure.message).not.toContain("xxxx");
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { nativeApproval: { reason: "approval-channel-lost" } },
  });
  expect(f.clock.pendingTimerCount).toBe(0);
});

test.each([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
])(
  "a native method requiring an answer cannot be silently ignored without its RPC id: %s",
  async (method) => {
    const f = setup();
    f.proc.requestApproval = () =>
      f.proc.emitLine(
        JSON.stringify({ method, params: { threadId: saved.sessionId, turnId: "native-turn" } }),
      );
    f.proc.afterStart = () => f.proc.complete();
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(codexCli, options, f.deps)) events.push(event);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { nativeApproval: { reason: "unsupported-native-interaction" } },
    });
    expect(events.filter((event) => event.kind === "approval-request")).toEqual([]);
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);

test("unhandled native notifications leave bounded diagnostics without copying their payloads", async () => {
  const f = setup();
  const logs: Record<string, unknown>[] = [];
  f.proc.requestApproval = () => {
    for (let index = 0; index < 100; index++)
      f.proc.emitLine(
        JSON.stringify({
          method: `fixture/state-${index}`,
          params: { detail: "fixture-not-for-log" },
        }),
      );
  };
  f.proc.afterStart = () => f.proc.complete();
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, options, {
    ...f.deps,
    log: (event) => {
      logs.push(event);
    },
  }))
    events.push(event);
  const exit = logs.find((event) => event.event === "exit");
  expect(exit?.ignoredNativeNotificationCount).toBe(100);
  expect(exit?.ignoredNativeMethods).toEqual(
    Array.from({ length: 32 }, (_, index) => `fixture/state-${index}`),
  );
  expect(JSON.stringify(logs)).not.toContain("fixture-not-for-log");
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
});

test.each(["thread", "turn"] as const)(
  "a foreign native message cannot disappear into a clean result: %s",
  async (different) => {
    const f = setup();
    f.proc.requestApproval = () =>
      f.proc.emitLine(
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: different === "thread" ? "foreign-thread" : saved.sessionId,
            turnId: different === "turn" ? "foreign-turn" : "native-turn",
            item: { type: "agentMessage", id: "foreign-message", text: "foreign transcript" },
          },
        }),
      );
    f.proc.afterStart = () => f.proc.complete();
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(codexCli, options, f.deps)) events.push(event);
    expect(events.filter((event) => event.kind === "message")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { nativeApproval: { reason: "unsupported-native-interaction" } },
    });
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);

test.each(["valid", "malformed"] as const)(
  "native approval turns retain the existing HCN question outcome: %s",
  async (variant) => {
    const f = setup();
    const body =
      variant === "valid"
        ? '{"question":"Which fixture?","options":["A","B"],"recommended":"A"}'
        : "not json";
    const text = ["Choose a fixture.", "```hcn-question", body, "```"].join("\n");
    f.proc.requestApproval = () =>
      f.proc.emitLine(
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: saved.sessionId,
            turnId: "native-turn",
            item: { type: "agentMessage", id: "answer", text },
          },
        }),
      );
    f.proc.afterStart = () => f.proc.complete();
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(codexCli, { ...options, questions: "ask" }, f.deps))
      events.push(event);
    if (variant === "valid") {
      expect(events.filter((event) => event.kind === "question")).toMatchObject([
        { question: "Which fixture?", options: ["A", "B"], recommended: "A" },
      ]);
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        cause: "awaiting-input",
        escalation: { mode: "ask", detection: "block" },
      });
    } else {
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        cause: "failed",
        failure: { class: "task", retryable: false },
        escalation: { mode: "ask", detection: "malformed" },
      });
    }
    expect(f.clock.pendingTimerCount).toBe(0);
  },
);
