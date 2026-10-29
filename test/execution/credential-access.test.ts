/**
 * Issue #425: cursor's locked-keychain stderr classifies as an auth wall
 * with kind credential-access, not a native failure. The wall is retained
 * in the stderr tail and classified at the harness's nonzero exit - the
 * exit code is part of the summary - and the message preserves the native
 * sentence plus an owner remedy that names the actual execution context.
 * The matcher is cursor-only; other harnesses keep native classification.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import type { FailureSummary } from "../../src/execution/failure.js";
import {
  failureFromCredentialAccess,
  failureFromStderrTail,
  failureFromTerminalError,
  retryableOf,
} from "../../src/execution/failure.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { StderrTail, superviseTurn } from "../../src/execution/supervisor.js";
import { detectAuthFailureInLine } from "../../src/interpretation/limits.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

/** The captured native stderr (ticket #425): two lines, exit 1. */
const CAPTURED_FIRST = "Error: Your macOS login keychain is locked.";
const CAPTURED_SECOND = "Run security unlock-keychain and try again.";

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
    expect(
      detectAuthFailureInLine(
        cursorCli,
        `\u001b[31mError:\u001b[0m ${"Your macOS login keychain is locked."}`,
      ),
    ).toBe("credential-access");
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
  test("auth class, family retryable, kind, exit code, native sentence, owner remedy", () => {
    const f = failureFromCredentialAccess(CAPTURED_FIRST, 1);
    expect(f.class).toBe("auth");
    expect(f.retryable).toBe(retryableOf("auth"));
    expect(f.authKind).toBe("credential-access");
    expect(f.nativeExitCode).toBe(1);
    // The captured native message rides in the summary.
    expect(f.message).toContain(CAPTURED_FIRST);
    // The remedy names the owner and the actual execution context.
    expect(f.message).toMatch(/owner must restore cursor credential access/);
    expect(f.message).toMatch(/context this run executed in/);
    // No automatic unlock, no password handling, no cross-shell promise.
    expect(f.message).toMatch(/never unlocks keychains or enters passwords/);
    expect(f.message).toMatch(/different shell or SSH session is not guaranteed/);
  });

  test("a null exit code is omitted, not recorded as data", () => {
    const f = failureFromCredentialAccess(CAPTURED_FIRST, null);
    expect(f.nativeExitCode).toBeUndefined();
  });

  test("secret-shaped tokens in the native sentence are redacted", () => {
    const f = failureFromCredentialAccess("keychain locked token=abc123", 1);
    expect(f.message).not.toContain("token=abc123");
    expect(f.message).toContain("[redacted]");
  });
});

describe("failureFromTerminalError (credential-access)", () => {
  test("routes the captured sentence to auth with the message preserved", () => {
    const f = failureFromTerminalError(cursorCli, `${CAPTURED_FIRST} - and more`);
    expect(f.class).toBe("auth");
    expect(f.authKind).toBe("credential-access");
    expect(f.message).toContain(CAPTURED_FIRST);
  });

  test("other harnesses classify the same sentence as a work verdict, not auth", () => {
    const f = failureFromTerminalError(piCli, CAPTURED_FIRST);
    expect(f.class).toBe("task");
  });
});

describe("failureFromStderrTail (credential-access)", () => {
  test("the captured two-line tail classifies auth with exit code and sentence", () => {
    const f = failureFromStderrTail(cursorCli, 1, [CAPTURED_FIRST, CAPTURED_SECOND]);
    expect(f.class).toBe("auth");
    expect(f.authKind).toBe("credential-access");
    expect(f.nativeExitCode).toBe(1);
    expect(f.message).toContain(CAPTURED_FIRST);
  });

  test("credential-access outranks a transport line in the same tail", () => {
    const f = failureFromStderrTail(cursorCli, 1, [CAPTURED_FIRST, "socket hang up"]);
    expect(f.class).toBe("auth");
  });

  test("the same tail on another harness stays native - harness scoping", () => {
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

describe("the supervisor retains the wall in the tail instead of failing per-line", () => {
  test("a credential-access line lands in the tail with no immediate failure", async () => {
    const emitted: HarnessEvent[] = [];
    const failed: FailureSummary[] = [];
    const tail = new StderrTail();
    const sup = superviseTurn(cursorCli, "ask", {
      clock: new FakeClock(),
      stallMs: 1000,
      signal: () => {},
      emit: async (e) => {
        emitted.push(e);
      },
      fail: async (f) => {
        failed.push(f);
      },
      tail,
      onStall: () => {},
      onQuestion: () => {},
    });
    await sup.stderrLine(CAPTURED_FIRST);
    await sup.stderrLine(CAPTURED_SECOND);
    expect(failed).toEqual([]);
    expect(emitted).toEqual([]);
    expect(tail.snapshot()).toEqual([CAPTURED_FIRST, CAPTURED_SECOND]);
  });

  test("an existing auth kind still fails immediately and drops the line", async () => {
    const emitted: HarnessEvent[] = [];
    const failed: FailureSummary[] = [];
    const tail = new StderrTail();
    const sup = superviseTurn(cursorCli, "ask", {
      clock: new FakeClock(),
      stallMs: 1000,
      signal: () => {},
      emit: async (e) => {
        emitted.push(e);
      },
      fail: async (f) => {
        failed.push(f);
      },
      tail,
      onStall: () => {},
      onQuestion: () => {},
    });
    await sup.stderrLine("Authentication required. Please run 'agent login' first");
    expect(failed.map((f) => f.class)).toEqual(["auth"]);
    expect(failed[0]?.authKind).toBe("not-logged-in");
    expect(emitted.map((e) => e.kind)).toEqual(["error"]);
    expect(tail.snapshot()).toEqual([]);
  });
});

describe("streamTurn end to end (FakeProcess)", () => {
  test("the captured stderr plus exit 1 yields auth credential-access and a matching done", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const pending = (async () => {
      const events: HarnessEvent[] = [];
      for await (const e of streamTurn(
        cursorCli,
        { prompt: "hi" },
        {
          spawn: spawner.spawn,
          clock: new FakeClock(),
          signal: fakeSignal().signal,
        },
      )) {
        events.push(e);
      }
      return events;
    })();
    proc.emitStderr(CAPTURED_FIRST);
    proc.emitStderr(CAPTURED_SECOND);
    proc.exit(1);
    const events = await pending;
    const failure = events.find((e) => e.kind === "failure") as Extract<
      HarnessEvent,
      { kind: "failure" }
    >;
    expect(failure).toMatchObject({
      class: "auth",
      authKind: "credential-access",
      retryable: true,
      nativeExitCode: 1,
    });
    expect(failure.message).toContain(CAPTURED_FIRST);
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.exitCode).toBe(1);
    expect(done.cause).toBe("failed");
    // done.failure agrees with the streamed failure event field for field.
    const { kind: _kind, ...failureSummary } = failure;
    expect(done.failure).toEqual(failureSummary);
  });

  test("exit 0 with the keychain sentence records no failure", async () => {
    // Classification waits for the exit: a clean exit means no wall.
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const pending = (async () => {
      const events: HarnessEvent[] = [];
      for await (const e of streamTurn(
        cursorCli,
        { prompt: "hi" },
        {
          spawn: spawner.spawn,
          clock: new FakeClock(),
          signal: fakeSignal().signal,
        },
      )) {
        events.push(e);
      }
      return events;
    })();
    proc.emitStderr(CAPTURED_FIRST);
    proc.exit(0);
    const events = await pending;
    expect(events.find((e) => e.kind === "failure")).toBeUndefined();
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.cause).toBe("clean");
  });
});
