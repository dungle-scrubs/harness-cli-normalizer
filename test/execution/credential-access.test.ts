/**
 * Issue #425: cursor's locked-keychain stderr classifies as an auth wall
 * with kind credential-access, not a native failure. The supervisor retains
 * the recognized line and the stderr after it as a typed observation,
 * independent of the rolling stderr tail, and each runner settles it at a
 * nonzero exit with that exit code. These tests read the runners' events,
 * not the supervisor's private buffers.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  failureFromCredentialAccess,
  failureFromStderrTail,
  failureFromTerminalError,
} from "../../src/execution/failure.js";
import { openSession } from "../../src/execution/open-session.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { detectAuthFailureInLine } from "../../src/interpretation/limits.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { claudeInitNaming, FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

/** The captured native stderr (ticket #425): two lines, exit 1. */
const CAPTURED_FIRST = "Error: Your macOS login keychain is locked.";
const CAPTURED_SECOND = "Run security unlock-keychain and try again.";
const COLORED_FIRST = "\u001b[31mError:\u001b[0m Your macOS login keychain is locked.";
/** More stderr after the wall than the rolling tail keeps (20 lines). */
const LONG_TAIL = Array.from({ length: 30 }, (_, i) => `    at frame${i} (synthetic.js:1:1)`);

type Failure = Extract<HarnessEvent, { kind: "failure" }>;
type Done = Extract<HarnessEvent, { kind: "done" }>;

const failuresOf = (events: readonly HarnessEvent[]): Failure[] =>
  events.filter((e): e is Failure => e.kind === "failure");

const doneOf = (events: readonly HarnessEvent[]): Done => {
  const done = events.at(-1);
  expect(done?.kind).toBe("done");
  return done as Done;
};

/** Let the runner's pumps and queue drain what has been written so far. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Start one streamTurn over a fake process; events collect as they stream. */
const startTurn = (
  h: HarnessDescriptor,
  options: { signal?: AbortSignal; autoExit?: boolean } = {},
) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const events: HarnessEvent[] = [];
  const finished = (async () => {
    for await (const e of streamTurn(
      h,
      { prompt: "hi", ...(options.signal ? { signal: options.signal } : {}) },
      {
        spawn: spawner.spawn,
        clock: new FakeClock(),
        signal: fakeSignal({ autoExit: options.autoExit ?? true }).signal,
      },
    )) {
      events.push(e);
    }
    return events;
  })();
  return { proc, events, finished };
};

/** The one credential-access failure, checked against done field for field. */
const expectCredentialFailure = (events: readonly HarnessEvent[], exitCode: number): Failure => {
  const auth = failuresOf(events).filter((f) => f.authKind === "credential-access");
  expect(auth).toHaveLength(1);
  const failure = auth[0] as Failure;
  expect(failure).toMatchObject({ class: "auth", retryable: true, nativeExitCode: exitCode });
  const { kind: _kind, ...summary } = failure;
  expect(doneOf(events).failure).toEqual(summary);
  return failure;
};

describe("detectAuthFailureInLine (cursor credential-access)", () => {
  test("the captured sentence with its native Error prefix classifies", () => {
    expect(detectAuthFailureInLine(cursorCli, CAPTURED_FIRST)).toBe("credential-access");
  });

  test("the bare sentence without a prefix classifies too", () => {
    expect(detectAuthFailureInLine(cursorCli, "Your macOS login keychain is locked.")).toBe(
      "credential-access",
    );
  });

  test("ANSI coloring around the sentence does not break the match", () => {
    expect(detectAuthFailureInLine(cursorCli, COLORED_FIRST)).toBe("credential-access");
  });

  test("cursor's existing auth kinds still match, ahead of the new one", () => {
    expect(
      detectAuthFailureInLine(cursorCli, "Authentication required. Please run 'agent login' first"),
    ).toBe("not-logged-in");
    expect(detectAuthFailureInLine(cursorCli, "The provided API key is invalid")).toBe(
      "invalid-key",
    );
  });

  test("unrelated keychain prose stays unmatched", () => {
    expect(detectAuthFailureInLine(cursorCli, "keychain locked on another machine")).toBeNull();
    expect(detectAuthFailureInLine(cursorCli, CAPTURED_SECOND)).toBeNull();
  });

  test("the sentence is cursor-only: no other harness matches it", () => {
    for (const h of [claudeCode, codexCli, piCli, museCode]) {
      expect(detectAuthFailureInLine(h, CAPTURED_FIRST)).toBeNull();
    }
  });
});

describe("failureFromCredentialAccess", () => {
  test("auth class, retryable, kind, exit code, native diagnostic, owner remedy", () => {
    const f = failureFromCredentialAccess("cursor", `${CAPTURED_FIRST}\n${CAPTURED_SECOND}`, 1);
    expect(f.class).toBe("auth");
    expect(f.retryable).toBe(true);
    expect(f.authKind).toBe("credential-access");
    expect(f.nativeExitCode).toBe(1);
    // The whole native diagnostic rides in the summary.
    expect(f.message).toContain(CAPTURED_FIRST);
    expect(f.message).toContain(CAPTURED_SECOND);
    // The remedy names the owner and the actual execution context.
    expect(f.message).toMatch(/owner must restore cursor credential access/);
    expect(f.message).toMatch(/context this run executed in/);
    // No automatic unlock, no password handling, no cross-shell promise.
    expect(f.message).toMatch(/never unlocks keychains or enters passwords/);
    expect(f.message).toMatch(/different shell or SSH session is not guaranteed/);
  });

  test("the remedy names the harness it is given, not a hardcoded one", () => {
    const f = failureFromCredentialAccess("pi", CAPTURED_FIRST, 1);
    expect(f.message).toMatch(/owner must restore pi credential access/);
    expect(f.message).not.toContain("cursor");
  });

  test("an unknown exit code is omitted, not recorded as data", () => {
    const f = failureFromCredentialAccess("cursor", CAPTURED_FIRST);
    expect(f).not.toHaveProperty("nativeExitCode");
  });

  test("secret-shaped tokens in the native diagnostic are redacted", () => {
    const f = failureFromCredentialAccess("cursor", "keychain locked token=abc123", 1);
    expect(f.message).not.toContain("token=abc123");
    expect(f.message).toContain("[redacted]");
  });
});

describe("failureFromTerminalError (credential-access)", () => {
  test("routes the captured sentence to auth with the message and no exit code", () => {
    const f = failureFromTerminalError(cursorCli, `${CAPTURED_FIRST} - and more`);
    expect(f.class).toBe("auth");
    expect(f.authKind).toBe("credential-access");
    expect(f.message).toContain(CAPTURED_FIRST);
    expect(f).not.toHaveProperty("nativeExitCode");
  });

  test("other harnesses classify the same sentence as a work verdict, not auth", () => {
    const f = failureFromTerminalError(piCli, CAPTURED_FIRST);
    expect(f.class).toBe("task");
  });
});

describe("failureFromStderrTail keeps its generic classes", () => {
  test("the supervisor observation owns credential access: the tail scan does not rescan it", () => {
    const f = failureFromStderrTail(cursorCli, 1, [CAPTURED_FIRST, CAPTURED_SECOND]);
    expect(f.class).toBe("native");
    expect(f.authKind).toBeUndefined();
  });

  test("the same tail on another harness stays native", () => {
    const f = failureFromStderrTail(piCli, 1, [CAPTURED_FIRST]);
    expect(f.class).toBe("native");
    expect(f.nativeExitCode).toBe(1);
  });

  test("cursor's no-session and unrelated native errors stay native", () => {
    expect(failureFromStderrTail(cursorCli, 1, ["No previous chats found."]).class).toBe("native");
    expect(failureFromStderrTail(cursorCli, 1, ["Error: something else broke"]).class).toBe(
      "native",
    );
  });
});

describe("streamTurn settles the credential-access observation at exit (FakeProcess)", () => {
  test("the captured stderr plus exit 1 yields one auth failure carrying both lines", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.emitStderr(CAPTURED_SECOND);
    run.proc.exit(1);
    const events = await run.finished;
    const failure = expectCredentialFailure(events, 1);
    expect(failure.message).toContain(`${CAPTURED_FIRST}\n${CAPTURED_SECOND}`);
    expect(doneOf(events)).toMatchObject({ exitCode: 1, cause: "failed" });
    // The diagnostic is in the failure, so no crash tail event repeats it.
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
  });

  test("nothing is reported before the exit decides the turn", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.emitStderr(CAPTURED_SECOND);
    await settle();
    expect(run.events.filter((e) => e.kind === "failure" || e.kind === "error")).toEqual([]);
    run.proc.exit(1);
    expectCredentialFailure(await run.finished, 1);
  });

  test.each([
    ["plain", CAPTURED_FIRST],
    ["colored", COLORED_FIRST],
  ])(
    "a %s credential line survives a stderr tail longer than the rolling buffer",
    async (_shape, first) => {
      const run = startTurn(cursorCli);
      run.proc.emitStderr(first);
      run.proc.emitStderr(CAPTURED_SECOND);
      for (const line of LONG_TAIL) run.proc.emitStderr(line);
      run.proc.exit(1);
      const events = await run.finished;
      expect(failuresOf(events).map((f) => f.class)).toEqual(["auth"]);
      const failure = expectCredentialFailure(events, 1);
      expect(failure.message).toContain(`${first}\n${CAPTURED_SECOND}`);
    },
  );

  test("the retained diagnostic is redacted and bounded", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.emitStderr("retry with password=hunter2");
    for (let i = 0; i < 10; i++) run.proc.emitStderr("x".repeat(1000));
    run.proc.exit(1);
    const failure = expectCredentialFailure(await run.finished, 1);
    expect(failure.message).not.toContain("hunter2");
    expect(failure.message).toContain("[redacted]");
    const diagnostic = /^Authentication failed \(credential-access: ([\s\S]*)\) - the owner/.exec(
      failure.message,
    )?.[1];
    expect(diagnostic?.startsWith(CAPTURED_FIRST)).toBe(true);
    // The existing 4096-character diagnostic bound.
    expect(diagnostic?.length).toBe(4096);
  });

  test("a transport line in the same stderr does not outrank the observation", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.emitStderr("socket hang up");
    run.proc.exit(1);
    const events = await run.finished;
    expect(failuresOf(events).map((f) => f.class)).toEqual(["auth"]);
    expectCredentialFailure(events, 1);
  });

  test("an existing auth kind still fails the turn per line, before the exit", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr("Authentication required. Please run 'agent login' first");
    await settle();
    expect(run.events.map((e) => e.kind)).toEqual(["failure", "error"]);
    expect(run.events[0]).toMatchObject({ class: "auth", authKind: "not-logged-in" });
    expect(run.events[0]).not.toHaveProperty("nativeExitCode");
    expect(run.events[1]).toMatchObject({ message: "auth wall: not-logged-in" });
    run.proc.exit(1);
    const events = await run.finished;
    expect(failuresOf(events)).toHaveLength(1);
    expect(doneOf(events).failure).toMatchObject({ class: "auth", authKind: "not-logged-in" });
  });

  test("exit 0 with the keychain sentence records no failure", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.exit(0);
    const events = await run.finished;
    expect(failuresOf(events)).toEqual([]);
    expect(doneOf(events).cause).toBe("clean");
  });

  test("a signal-only exit keeps the killed report with the line as tail evidence", async () => {
    const run = startTurn(cursorCli);
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.exit(null);
    const events = await run.finished;
    expect(failuresOf(events)).toEqual([]);
    expect(doneOf(events)).toMatchObject({ exitCode: null, cause: "killed" });
    expect(events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", message: CAPTURED_FIRST },
    ]);
  });

  test("a caller abort keeps its authority over a later nonzero exit", async () => {
    const abort = new AbortController();
    const run = startTurn(cursorCli, { signal: abort.signal, autoExit: false });
    abort.abort();
    run.proc.emitStderr(CAPTURED_FIRST);
    run.proc.exit(1);
    const events = await run.finished;
    expect(failuresOf(events)).toEqual([]);
    expect(doneOf(events)).toMatchObject({ cause: "killed" });
    expect(doneOf(events).failure).toBeUndefined();
  });
});

/** A session-capable descriptor that exposes the kind: cursor itself has
 * no session mode, so the session runner is exercised synthetically. */
const SESSION_WITH_KIND: HarnessDescriptor = {
  ...claudeCode,
  authMatchers: [
    { pattern: "Your macOS login keychain is locked\\.", kind: "credential-access" },
    ...claudeCode.authMatchers,
  ],
};
const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const result = JSON.stringify({ type: "result", subtype: "success" });

const openFake = () => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const session = openSession(
    SESSION_WITH_KIND,
    { sessionId: sid, questions: "none" },
    { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
  );
  return { proc, session, turns: session.turns[Symbol.asyncIterator]() };
};

const drain = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

describe("openSession settles the observation with the turn lifecycle (synthetic descriptor)", () => {
  test("an open turn at a nonzero exit reports credential access with that exit code", async () => {
    const { proc, session, turns } = openFake();
    session.send({ id: "s1", text: "hi" });
    // Native uuid evidence publishes the input's turn (issue #426).
    proc.emitLine(claudeInitNaming(sid, proc));
    const turn = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitStderr(CAPTURED_FIRST);
    proc.emitStderr(CAPTURED_SECOND);
    for (const line of LONG_TAIL) proc.emitStderr(line);
    proc.exit(3);
    const events = await drain(turn);
    const failure = expectCredentialFailure(events, 3);
    expect(failure.message).toContain(`${CAPTURED_FIRST}\n${CAPTURED_SECOND}`);
    expect(failure.message).toMatch(/owner must restore claude credential access/);
    // Session mode keeps its crash cause for every class.
    expect(doneOf(events)).toMatchObject({ exitCode: 3, cause: "crash" });
    await session.close();
  });

  test("an observation from a finished turn is not reported by the next one", async () => {
    const { proc, session, turns } = openFake();
    session.send({ id: "s1", text: "first" });
    proc.emitLine(claudeInitNaming(sid, proc));
    const first = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitStderr(CAPTURED_FIRST);
    await settle();
    proc.emitLine(result);
    const firstEvents = await drain(first);
    expect(failuresOf(firstEvents)).toEqual([]);
    expect(doneOf(firstEvents).cause).toBe("clean");

    session.send({ id: "s2", text: "second" });
    // The process dies before any native record names s2: the attempt is
    // still owed its turn and its failure (issue #426).
    const nextTurn = turns.next();
    proc.exit(1);
    const second = (await nextTurn).value as AsyncIterable<HarnessEvent>;
    const secondEvents = await drain(second);
    expect(failuresOf(secondEvents).filter((f) => f.authKind === "credential-access")).toEqual([]);
    expect(doneOf(secondEvents).failure).toMatchObject({ class: "native", nativeExitCode: 1 });
    await session.close();
  });
});
