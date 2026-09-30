/**
 * Codex session records: the codex-jsonrpc input kind encodes JSON-RPC
 * requests (turn/start idle, turn/steer busy with the tracked native turn
 * id) and decodes responses/notifications into the closed SessionRecord
 * kinds. Every field name here is descriptor-owned interpretation data;
 * the runner branches on kinds only (ADR 0005). Protocol evidence:
 * test/fixtures/codex-0.159.2/session (codex-cli 0.159.2 app-server).
 */
import { describe, expect, test } from "vitest";
import {
  decodeSessionRecord,
  encodeIdentityProbe,
  encodeSessionInput,
  IDENTITY_PROBE_ID,
  INITIALIZE_ID,
  resolveSessionInput,
  SEND_ID,
} from "../../src/interpretation/session-input.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { SessionInputContract } from "../../src/knowledge/descriptor.js";

const input: SessionInputContract = { kind: "codex-jsonrpc" };
const THREAD = "01a0f0db-4c47-77e1-a299-22e74c5d41df";
const TURN = "01a0f0db-4d72-72d3-b289-54be7290ba03";

describe("codex session input encoding", () => {
  test("the descriptor declares the codex-jsonrpc contract", () => {
    expect(resolveSessionInput(codexCli)).toEqual({ kind: "codex-jsonrpc" });
    expect(codexCli.sessionMode?.flags).toEqual(["app-server"]);
    expect(codexCli.sessionMode?.idFlag).toBeNull();
    expect(codexCli.sessionMode?.resumeFlag).toBeNull();
    expect(codexCli.sessionMode?.turnEnd).toEqual({ method: "turn/completed" });
  });

  test("an idle send encodes turn/start carrying the thread id and the send id", () => {
    expect(
      encodeSessionInput(input, "hello worker", { busy: false, id: "in-1", sessionId: THREAD }),
    ).toBe(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: `${SEND_ID}:in-1`,
        method: "turn/start",
        params: { threadId: THREAD, input: [{ text: "hello worker", type: "text" }] },
      })}\n`,
    );
  });

  test("a busy send encodes turn/steer with the tracked native turn id", () => {
    expect(
      encodeSessionInput(input, "guidance", {
        busy: true,
        id: "in-2",
        sessionId: THREAD,
        activeTurnId: TURN,
      }),
    ).toBe(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: `${SEND_ID}:in-2`,
        method: "turn/steer",
        params: {
          threadId: THREAD,
          expectedTurnId: TURN,
          input: [{ text: "guidance", type: "text" }],
        },
      })}\n`,
    );
  });

  test("a busy send with an unknown native turn id renders an empty precondition (the harness rejects it)", () => {
    const line = encodeSessionInput(input, "racy", { busy: true, id: "in-3", sessionId: THREAD });
    expect(line).toContain('"expectedTurnId":""');
    expect(line).toContain('"method":"turn/steer"');
  });

  test("the identity probe is the initialize handshake plus the thread open", () => {
    expect(encodeIdentityProbe(codexCli, { clientVersion: "0.9.2" })).toBe(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: { clientInfo: { name: "hcn", version: "0.9.2" } },
      })}\n${JSON.stringify({
        jsonrpc: "2.0",
        id: IDENTITY_PROBE_ID,
        method: "thread/start",
        params: {},
      })}\n`,
    );
  });

  test("a resume probe opens thread/resume with the requested id", () => {
    const probe = encodeIdentityProbe(codexCli, {
      sessionId: THREAD,
      isResume: true,
      clientVersion: "0.9.2",
    });
    expect(probe).toContain(`"method":"thread/resume"`);
    expect(probe).toContain(`"params":{"threadId":"${THREAD}"}`);
    expect(
      probe?.startsWith(`{"jsonrpc":"2.0","id":"${INITIALIZE_ID}","method":"initialize"`),
    ).toBe(true);
  });
});

describe("codex session record decoding", () => {
  test("the initialize response is ignored", () => {
    expect(
      decodeSessionRecord(codexCli, { id: INITIALIZE_ID, result: { userAgent: "x" } }),
    ).toEqual({
      kind: "ignored",
    });
  });

  test("the thread open response announces harness-minted identity via the descriptor's id field", () => {
    expect(
      decodeSessionRecord(codexCli, {
        id: IDENTITY_PROBE_ID,
        result: { thread: { id: THREAD, model: "gpt-6-astra" } },
      }),
    ).toEqual({ kind: "identity", sessionId: THREAD });
  });

  test("a failed thread open surfaces, never silently", () => {
    expect(
      decodeSessionRecord(codexCli, {
        id: IDENTITY_PROBE_ID,
        error: { code: -32600, message: "Not initialized" },
      }),
    ).toEqual({
      kind: "probe-failed",
      message: `jsonrpc request failed: "hcn-identity" - Not initialized`,
    });
  });

  test("a turn/start response is a command receipt naming the native turn", () => {
    expect(
      decodeSessionRecord(codexCli, {
        id: `${SEND_ID}:in-1`,
        result: { turn: { id: TURN, status: "inProgress" } },
      }),
    ).toEqual({ inputId: "in-1", kind: "command-accepted", nativeTurnId: TURN });
  });

  test("a steer response is a command receipt with the steered turn id", () => {
    expect(
      decodeSessionRecord(codexCli, { id: `${SEND_ID}:in-2`, result: { turnId: TURN } }),
    ).toEqual({ inputId: "in-2", kind: "command-accepted", nativeTurnId: TURN });
  });

  test("a failed steer precondition is a rejected receipt carrying the native message", () => {
    expect(
      decodeSessionRecord(codexCli, {
        id: `${SEND_ID}:in-2`,
        error: { code: -32600, message: "no active turn to steer" },
      }),
    ).toEqual({
      inputId: "in-2",
      kind: "command-failed",
      message: `jsonrpc request failed: "hcn-send:in-2" - no active turn to steer`,
    });
  });

  test("turn/completed delimits the turn; the harness's own status is the verdict", () => {
    expect(
      decodeSessionRecord(codexCli, {
        method: "turn/completed",
        params: { threadId: THREAD, turn: { id: TURN, status: "completed", error: null } },
      }),
    ).toEqual({ kind: "turn-end", isError: false });
    expect(
      decodeSessionRecord(codexCli, {
        method: "turn/completed",
        params: {
          threadId: THREAD,
          turn: { id: TURN, status: "failed", error: { message: "boom" } },
        },
      }),
    ).toEqual({ kind: "turn-end", isError: true });
  });

  test("every other notification is content for the stream decoder", () => {
    expect(
      decodeSessionRecord(codexCli, {
        method: "item/completed",
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: { type: "agentMessage", id: "m1", text: "hi" },
        },
      }),
    ).toEqual({ kind: "content" });
  });
});
