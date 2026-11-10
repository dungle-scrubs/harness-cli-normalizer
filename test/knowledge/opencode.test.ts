/**
 * The opencode descriptor: facts about the OpenCode CLI as data,
 * verified against opencode 1.19.5 (captures in
 * test/fixtures/opencode-1.19.5).
 */
import { describe, expect, test } from "vitest";
import { failureFromTerminalError } from "../../src/execution/failure.js";
import {
  buildLaunchArgv,
  buildResumeArgv,
  streamingGranularityOf,
} from "../../src/interpretation/argv.js";
import { contentEventsOf } from "../../src/interpretation/content.js";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { parseResumeCommand } from "../../src/interpretation/parse-resume.js";
import { opencodeCli } from "../../src/knowledge/opencode.js";

const sessionId = "ses_e3bed97d6ffeLGuUWZNirc2Ono";

describe("opencode descriptor (first slice)", () => {
  test("launch is `opencode run` with the json event stream", () => {
    const argv = buildLaunchArgv(opencodeCli, { prompt: "hi" });
    expect(argv).toEqual(["opencode", "run", "hi", "--format", "json"]);
    // The stream carries whole text parts, no deltas.
    expect(streamingGranularityOf(opencodeCli, argv)).toBe("message");
  });

  test("the model rides the native --model flag", () => {
    const argv = buildLaunchArgv(opencodeCli, { prompt: "hi", model: "opencode/big-pickle" });
    expect(argv).toEqual([
      "opencode",
      "run",
      "hi",
      "--format",
      "json",
      "--model",
      "opencode/big-pickle",
    ]);
  });

  test("resume re-enters by --session and an unknown id is an error", () => {
    const argv = buildResumeArgv(opencodeCli, { prompt: "hi", sessionId });
    expect(argv).toEqual(["opencode", "run", "--session", sessionId, "hi", "--format", "json"]);
    expect(opencodeCli.resume.onMissing).toBe("error");
    expect(parseResumeCommand([opencodeCli], `opencode run -s ${sessionId} "hi"`)).toMatchObject({
      harness: "opencode",
      sessionId,
    });
  });

  test("identity is harness-minted from the sessionID every line carries", () => {
    const decoded = decodeIdentity(opencodeCli, { type: "step_start", sessionID: sessionId }, null);
    expect(decoded).toMatchObject({ sessionId, identity: sessionId, outcome: "announced" });
    // The same id on the next line is not news.
    expect(
      decodeIdentity(opencodeCli, { type: "text", sessionID: sessionId }, sessionId),
    ).toMatchObject({ outcome: "duplicate", identity: null });
  });

  test("the free roster rotates, so the model vocabulary stays open", () => {
    expect(opencodeCli.vocabulary.models).toEqual([]);
    expect(opencodeCli.vocabulary.extensible).toBe(true);
    expect(opencodeCli.vocabulary.modelFlag).toBe("--model");
  });

  test("the first slice expresses no turn option and no transcript surface", () => {
    expect(opencodeCli.turnOptions).toEqual({});
    expect(opencodeCli.transcript).toBeNull();
    expect(opencodeCli.sessionMode).toBeNull();
    expect(opencodeCli.capabilities.session).toBe(false);
    expect(opencodeCli.escalation).toEqual({ supported: false });
  });

  test("a passthrough tail refuses: `run` joins trailing text into the prompt", () => {
    expect(opencodeCli.launch.passthrough).toBe("prompt-joins");
  });

  test("the reader maps one tool_use line to a tool and its result", () => {
    const events = contentEventsOf("opencode", {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: {
          status: "completed",
          input: { filePath: "/tmp/note.txt" },
          output: "hello",
        },
      },
    });
    expect(events).toEqual([
      {
        kind: "tool",
        name: "read",
        input: { filePath: "/tmp/note.txt" },
        callId: "call_1",
      },
      {
        kind: "tool-result",
        name: "read",
        callId: "call_1",
        result: "hello",
        isError: false,
      },
    ]);
  });

  test("a text part is one assistant message", () => {
    expect(
      contentEventsOf("opencode", { type: "text", part: { type: "text", text: "hello" } }),
    ).toEqual([{ kind: "message", role: "assistant", text: "hello" }]);
  });

  test("the free-tier and Go-plan walls classify as a usage limit", () => {
    for (const name of ["FreeUsageLimitError", "GoUsageLimitError"]) {
      const message = `opencode error: UnknownError: rate limited [responseBody: {"name":"${name}"}]`;
      expect(failureFromTerminalError(opencodeCli, message)).toMatchObject({
        class: "usage-limit",
        code: "usage-limit",
        retryable: true,
      });
    }
  });

  test("a long provider message cannot push the free-tier wall out of the matchers' window", () => {
    const [event] = contentEventsOf("opencode", {
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "x".repeat(8192),
          statusCode: 429,
          responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
        },
      },
    });
    if (event?.kind !== "error") throw new Error("expected a terminal error event");
    expect(failureFromTerminalError(opencodeCli, event.message)).toMatchObject({
      class: "usage-limit",
      code: "usage-limit",
    });
  });

  test("an unknown model is a plain terminal error, not an auth or limit wall", () => {
    const [event] = contentEventsOf("opencode", {
      type: "error",
      error: {
        name: "UnknownError",
        data: { message: "Unexpected server error. Check server logs for details." },
      },
    });
    if (event?.kind !== "error") throw new Error("expected a terminal error event");
    expect(event.terminal).toBe(true);
    expect(failureFromTerminalError(opencodeCli, event.message)).toMatchObject({
      class: "task",
      retryable: false,
    });
  });
});
