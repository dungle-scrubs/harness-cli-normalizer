/**
 * The canonical cursor tool-outcome helpers (moved from content.ts, issue
 * #440 round 2): the legacy CLI result arm byte-preserved, and the SDK
 * status/value wrapper arm the installed @cursor/sdk 1.0.38 actually
 * produces - shell success AND failure both arrive as status:success
 * (exitCode is the only failure signal), while rejection, timeout and
 * spawn errors all arrive as status:error with the reason text preserved
 * in error.message but the rejection category destroyed. A denial is
 * classified only from an explicit rejected payload, never from prose.
 */
import { describe, expect, test } from "vitest";
import {
  cursorDenialEvent,
  cursorToolOutcome,
} from "../../src/interpretation/cursor-tool-outcome.js";

describe("cursorToolOutcome (legacy CLI result arm, byte-preserved)", () => {
  test("rejected keeps its reason; error is an error; success exitCode decides isError", () => {
    expect(cursorToolOutcome({ result: { rejected: { reason: "no" } } }, "readToolCall")).toEqual({
      kind: "rejected",
      reason: "no",
      isError: true,
    });
    expect(cursorToolOutcome({ result: { rejected: {} } }, "shellToolCall")).toEqual({
      kind: "rejected",
      reason: "",
      isError: true,
    });
    expect(cursorToolOutcome({ result: { error: "boom" } }, "shellToolCall")).toEqual({
      kind: "error",
      isError: true,
    });
    expect(cursorToolOutcome({ result: { success: { exitCode: 3 } } }, "shellToolCall")).toEqual({
      kind: "success",
      isError: true,
    });
    expect(cursorToolOutcome({ result: { success: { exitCode: 0 } } }, "shellToolCall")).toEqual({
      kind: "success",
      isError: false,
    });
    // The legacy shell special case: success with no exitCode carries no
    // isError claim at all.
    expect(cursorToolOutcome({ result: { success: {} } }, "shellToolCall")).toEqual({
      kind: "success",
    });
    expect(cursorToolOutcome({ result: { success: { content: "x" } } }, "readToolCall")).toEqual({
      kind: "success",
      isError: false,
    });
    expect(cursorToolOutcome({ result: {} }, "readToolCall")).toBeNull();
    expect(cursorToolOutcome({ result: { weird: 1 } }, "readToolCall")).toEqual({
      kind: "unknown",
    });
  });
});

describe("cursorToolOutcome (SDK status/value wrapper arm)", () => {
  // The real SDK shell wrapper (seven/03.ndjson): success AND failure both
  // map to status:success with the exitCode as the only failure signal.
  const shell = (exitCode: number) => ({
    status: "success",
    value: { exitCode, signal: "", stdout: "", stderr: "", executionTime: 1 },
  });

  test("a nonzero exitCode under status success is an error; zero is not; error wrappers are errors", () => {
    expect(cursorToolOutcome({ result: shell(7) }, "shell")).toEqual({
      kind: "success",
      isError: true,
    });
    expect(cursorToolOutcome({ result: shell(0) }, "shell")).toEqual({
      kind: "success",
      isError: false,
    });
    // A task/read-style success value carries no exitCode: not an error.
    expect(
      cursorToolOutcome({ result: { status: "success", value: { content: "x" } } }, "read"),
    ).toEqual({ kind: "success", isError: false });
    expect(cursorToolOutcome({ result: { status: "weird" } }, "shell")).toEqual({
      kind: "unknown",
    });
  });

  test("an error status still reports failure when diagnostic data is missing or null", () => {
    for (const result of [{ status: "error" }, { status: "error", error: null }]) {
      expect(cursorToolOutcome({ result }, "shell")).toEqual({ kind: "error", isError: true });
    }
  });

  test("timeout, spawn-error and rejection-looking error wrappers are generic errors, never denials", () => {
    // The SDK's actual conversions (installed @cursor/sdk 1.0.38,
    // dist/cjs/748.js): timeout, rejected and spawnError shell results all
    // become {status:'error', error:{message,...}}. The reason text
    // survives in error.message, but the rejection category does not - so
    // rejection-looking text must stay a generic error, never a denial.
    const wrappers = [
      {
        status: "error",
        error: { message: "Command timed out after 5ms", command: "slow", workingDirectory: "/w" },
      },
      {
        status: "error",
        error: {
          message: "sandbox denied the command",
          command: "rm -rf /",
          workingDirectory: "/w",
        },
      },
      {
        status: "error",
        error: { message: "Command rejected", command: "x", workingDirectory: "/w" },
      },
      {
        status: "error",
        error: { message: "Failed to spawn command", command: "y", workingDirectory: "/w" },
      },
    ];
    for (const wrapper of wrappers) {
      expect(cursorToolOutcome({ result: wrapper }, "shell")).toEqual({
        kind: "error",
        isError: true,
      });
    }
  });
});

describe("cursorDenialEvent (moved verbatim)", () => {
  test("the denial observation names the tool and its reason, or the absence of one", () => {
    expect(cursorDenialEvent("shell", "sandbox denied")).toEqual({
      kind: "error",
      message: "cursor denied shell: sandbox denied",
      denial: { tool: "shell", reason: "sandbox denied" },
    });
    expect(cursorDenialEvent("shell", "")).toEqual({
      kind: "error",
      message: "cursor denied shell (no reason given)",
      denial: { tool: "shell", reason: "" },
    });
  });
});
