/**
 * The opencode decoder over the real captures in
 * test/fixtures/opencode-1.19.5 (see that directory's VERIFICATION.md for
 * the exact commands). The captures are byte-for-byte harness output: the
 * decoder is pinned against them, not against synthetic records.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { failureFromTerminalError } from "../../src/execution/failure.js";
import { opencodeCli } from "../../src/knowledge/opencode.js";

const DIR = join(import.meta.dirname, "..", "fixtures", "opencode-1.19.5");
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
const lines = (name: string): string[] =>
  read(name)
    .split("\n")
    .filter((line) => line.trim() !== "");

const decode = (name: string) => {
  const state = freshDecodeState(null, "opencode");
  return lines(name).flatMap((line) =>
    decodeLine(opencodeCli, line, state, "opencode/big-pickle", "message"),
  );
};

describe("opencode stream decoding (1.19.5 captures)", () => {
  test("a tool-using turn yields identity, a tool pair, a message and usage", () => {
    const events = decode("tool-use.jsonl");
    const identity = events.find((event) => event.kind === "identity");
    expect(identity).toMatchObject({
      sessionId: "ses_e3bed97d6ffeLGuUWZNirc2Ono",
      authority: "harness-minted",
    });

    const tool = events.find((event) => event.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", name: "read" });
    const result = events.find((event) => event.kind === "tool-result");
    expect(result).toMatchObject({ kind: "tool-result", name: "read", isError: false });
    expect(String((result as { result?: unknown }).result)).toContain("hello");

    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "hello" });

    // One usage event per step, scoped to that step's message.
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      kind: "usage",
      scope: "message",
      inputTokens: 16108,
      outputTokens: 56,
      totalTokens: 17956,
      cacheReadTokens: 1792,
    });
    expect(usage[1]).toMatchObject({ kind: "usage", scope: "message", outputTokens: 3 });
  });

  test("the resume capture continues the same session", () => {
    const events = decode("resume.jsonl");
    expect(events).toContainEqual({
      kind: "identity",
      sessionId: "ses_e3bed97d6ffeLGuUWZNirc2Ono",
      authority: "harness-minted",
      capabilities: expect.anything(),
    });
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "resumed" });
    expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
  });

  test("an unknown model is one terminal error and a task failure", () => {
    const events = decode("bad-model.jsonl");
    const error = events.find((event) => event.kind === "error");
    expect(error).toMatchObject({ kind: "error", terminal: true });
    expect((error as { message: string }).message).toContain("Unexpected server error");
    expect(
      failureFromTerminalError(opencodeCli, (error as { message: string }).message),
    ).toMatchObject({ class: "task", retryable: false });
    // The identity still arrives: the error line carries the session id.
    expect(events.find((event) => event.kind === "identity")).toMatchObject({
      kind: "identity",
      authority: "harness-minted",
    });
  });

  test("the unknown session id refuses on stderr with exit 1 and no stdout", () => {
    expect(lines("missing-session.jsonl")).toEqual([]);
    expect(read("missing-session.err")).toContain("Session not found");
    expect(read("missing-session.exit").trim()).toBe("1");
  });

  test("the captures came from the version the descriptor is verified against", () => {
    expect(read("version.txt").trim()).toBe(opencodeCli.verifiedAgainst);
  });
});
