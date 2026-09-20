import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { failureFromTerminalError } from "../../src/execution/failure.js";
import { contentEventsOf } from "../../src/interpretation/content.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";

const fixture = (name: string): string[] =>
  readFileSync(new URL(`../fixtures/antigravity-1.2.7/${name}.ndjson`, import.meta.url), "utf8")
    .trim()
    .split("\n");

describe("Antigravity stream-json decoding", () => {
  test("decodes authenticated init, token, usage, and terminal response shapes", () => {
    const state = freshDecodeState(null, "antigravity");
    const events = fixture("success").flatMap((line) =>
      decodeLine(antigravityCli, line, state, "gemini-3.8-flash-medium", "token"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "identity",
        sessionId: "2316118f-b9fa-4bc0-95b7-a4138c5fcf11",
        authority: "harness-minted",
      }),
    );
    expect(events).toContainEqual({ kind: "token", text: "alpha" });
    expect(events).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "alpha\n",
    });
  });

  test("decodes a completed documented tool record once", () => {
    const events = contentEventsOf("antigravity", JSON.parse(fixture("tool")[0] ?? "null"));
    expect(events).toEqual([
      {
        kind: "tool",
        name: "run_command",
        input: { CommandLine: "echo seventest" },
      },
    ]);
  });

  test("turns every non-success native result into a terminal error", () => {
    const [line] = fixture("unknown-model");
    const events = decodeLine(
      antigravityCli,
      line ?? "",
      freshDecodeState(null, "antigravity"),
      "",
    );
    const error = events.find((event) => event.kind === "error");
    expect(error).toMatchObject({ kind: "error", terminal: true });
    expect(error?.message).toContain("invalid model selection");
    expect(failureFromTerminalError(antigravityCli, error?.message ?? "")).toMatchObject({
      class: "task",
      retryable: false,
    });
  });

  test("uses the captured ERROR tool record for denials without making them terminal", () => {
    const events = contentEventsOf(
      "antigravity",
      JSON.parse(fixture("permission-denied")[1] ?? "null"),
    );
    expect(events).toEqual([
      {
        kind: "tool",
        name: "run_command",
        input: {
          CommandLine:
            "printf denied-probe > /Users/kevin/hcn-antigravity-denied-probe-20260919.txt",
        },
      },
      {
        kind: "error",
        message: expect.stringContaining(
          "antigravity tool run_command failed: permission check failed",
        ),
        denial: {
          tool: "run_command",
          reason: expect.stringContaining("user denied permission to run command"),
        },
      },
    ]);
  });

  test("keeps one native conversation identity across two persistent turns", () => {
    const ids = fixture("persistent-session").map((line) => {
      const record = JSON.parse(line) as {
        step_update?: { conversation_id?: string };
        result?: { conversation_id?: string };
      };
      return record.step_update?.conversation_id ?? record.result?.conversation_id;
    });
    expect(new Set(ids)).toEqual(new Set(["d297ac09-9d33-4fb3-b696-b8ae081c239e"]));
  });

  test("labels a fresh identity from an unknown resume id as harness-minted", () => {
    const requested = "11111111-1111-4111-8111-111111111111";
    const [line] = fixture("unknown-conversation");
    const events = decodeLine(
      antigravityCli,
      line ?? "",
      freshDecodeState(requested, "antigravity"),
      "gemini-3.8-flash-medium",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "identity",
        sessionId: "ac3f6157-837c-444e-a11e-2b40993569d3",
        authority: "harness-minted",
      }),
    );
  });
});

describe("Antigravity stream-json boundary records", () => {
  test("ignores malformed, unrelated, partial, and in-progress step updates", () => {
    const records = [
      { event: "step_update" },
      { event: "step_update", step_update: { step_type: "agent_response", text_delta: 1 } },
      {
        event: "step_update",
        step_update: { step_type: "agent_response", state: "DONE", text_delta: 1 },
      },
      { event: "step_update", step_update: { step_type: "tool", state: "RUNNING" } },
      { event: "usage", result: { status: "ERROR" } },
    ];

    for (const record of records) {
      expect(contentEventsOf("antigravity", record)).toEqual([]);
    }
  });

  test("uses the documented tool-name fallbacks and includes parameters only when present", () => {
    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_name: "shell_fallback",
          tool_info: {},
        },
      }),
    ).toEqual([{ kind: "tool", name: "shell_fallback" }]);

    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: { step_type: "tool", state: "DONE", text_delta: "not a token" },
      }),
    ).toEqual([{ kind: "tool", name: "tool" }]);

    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_info: { name: "read_file", error: null },
        },
      }),
    ).toEqual([{ kind: "tool", name: "read_file" }]);
  });

  test("surfaces structured tool errors without inventing a permission denial", () => {
    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ERROR",
          tool_info: {
            name: "read_file",
            error: { type: "IO_ERROR", message: "file disappeared" },
          },
        },
      }),
    ).toEqual([
      { kind: "tool", name: "read_file" },
      { kind: "error", message: "antigravity tool read_file failed: file disappeared" },
    ]);

    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ERROR",
          tool_info: { name: "read_file", error: "opaque failure" },
        },
      }),
    ).toEqual([
      { kind: "tool", name: "read_file" },
      { kind: "error", message: "antigravity tool read_file failed: opaque failure" },
    ]);

    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ERROR",
          tool_info: { name: "read_file", error: { code: 500 } },
        },
      }),
    ).toEqual([
      { kind: "tool", name: "read_file" },
      { kind: "error", message: 'antigravity tool read_file failed: {"code":500}' },
    ]);
  });

  test("recognizes denial variants only inside the structured native error", () => {
    const [tool, error] = contentEventsOf("antigravity", {
      event: "step_update",
      step_update: {
        step_type: "tool",
        state: "ERROR",
        tool_info: {
          name: "run_command",
          error: { type: "NOT_ALLOWED", message: "policy blocked this call" },
        },
      },
    });

    expect(tool).toEqual({ kind: "tool", name: "run_command" });
    expect(error).toEqual({
      kind: "error",
      message: "antigravity tool run_command failed: policy blocked this call",
      denial: { tool: "run_command", reason: "policy blocked this call" },
    });

    const compactDenial = contentEventsOf("antigravity", {
      event: "step_update",
      step_update: {
        step_type: "tool",
        state: "ERROR",
        tool_info: {
          name: "run_command",
          error: { type: "notallowed", message: "policy blocked this call" },
        },
      },
    });
    expect(compactDenial[1]).toMatchObject({
      kind: "error",
      denial: { tool: "run_command", reason: "policy blocked this call" },
    });
  });

  test("malformed and incomplete result records fail closed", () => {
    expect(contentEventsOf("antigravity", { event: "result" })).toEqual([
      { kind: "error", message: "antigravity result was malformed", terminal: true },
    ]);
    expect(contentEventsOf("antigravity", { event: "result", result: {} })).toEqual([
      {
        kind: "error",
        message: "antigravity turn ended with status INVALID: no native error detail",
        terminal: true,
      },
    ]);
  });

  test("a successful result emits only a non-empty string response", () => {
    for (const response of [undefined, "", 1]) {
      expect(
        contentEventsOf("antigravity", {
          event: "result",
          result: { status: "SUCCESS", response },
        }),
      ).toEqual([]);
    }
    expect(
      contentEventsOf("antigravity", {
        event: "result",
        result: { status: "SUCCESS", response: "done" },
      }),
    ).toEqual([{ kind: "message", role: "assistant", text: "done" }]);
  });
});
