import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildResumeArgv,
  streamingGranularityOf,
} from "../../src/interpretation/argv.js";
import { contentEventsOf } from "../../src/interpretation/content.js";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { encodeSessionInput, resolveSessionInput } from "../../src/interpretation/session-input.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

const sessionId = "cz7UbUOZ06-NAY4j";

describe("popeye descriptor (RFC-02 P5 entry)", () => {
  test("launch is headless with the hcn stream pin", () => {
    const argv = buildLaunchArgv(popeyeCli, { prompt: "hi" });
    // Positional prompt rides before the stream flags (verified live:
    // `popeye -p "hi" --mode hcn` parses and streams).
    expect(argv).toEqual(["popeye", "-p", "hi", "--mode", "hcn"]);
    expect(streamingGranularityOf(popeyeCli, argv)).toBe("token");
  });

  test("resume re-enters by flag and unknown ids stay errors", () => {
    const argv = buildResumeArgv(popeyeCli, { prompt: "hi", sessionId });
    expect(argv).toEqual(["popeye", "--resume", sessionId, "-p", "hi", "--mode", "hcn"]);
    expect(popeyeCli.resume.onMissing).toBe("error");
  });

  test("identity is harness-minted from the hcn identity record", () => {
    const decoded = decodeIdentity(popeyeCli, { kind: "identity", sessionId }, null);
    expect(decoded).toMatchObject({ sessionId, identity: sessionId, outcome: "announced" });
  });

  test("effort and grant flags render from data", () => {
    expect(popeyeCli.turnOptions.effort).toEqual({
      kind: "effort",
      render: { kind: "flag-value", flag: "--effort" },
    });
    expect(popeyeCli.tools).toMatchObject({
      includeFlag: "--tools",
      excludeFlag: "--exclude-tools",
      includeIsStrictAllowlist: true,
    });
    expect(popeyeCli.turnOptions.access).toEqual({
      kind: "access",
      renders: { read: "tool-preset", write: null },
    });
  });

  test("session input encodes the popeye prompt frame", () => {
    const input = resolveSessionInput(popeyeCli);
    expect(input).toEqual({ kind: "popeye-rpc-prompt" });
    expect(
      JSON.parse(encodeSessionInput(input, "hello", { busy: false, id: "s1", sessionId })),
    ).toEqual({ _tag: "prompt", content: "hello", id: "hcn-send:s1", sessionId });
  });

  test("the hcn reader maps token, message, tool, and terminal error", () => {
    expect(contentEventsOf("popeye", { kind: "token", text: "Hi" })).toEqual([
      { kind: "token", text: "Hi" },
    ]);
    expect(
      contentEventsOf("popeye", { kind: "message", role: "assistant", text: "Done." }),
    ).toEqual([{ kind: "message", role: "assistant", text: "Done." }]);
    expect(contentEventsOf("popeye", { kind: "tool", name: "read-file" })).toEqual([
      { kind: "tool", name: "read-file" },
    ]);
    expect(contentEventsOf("popeye", { kind: "error", message: "boom", terminal: true })).toEqual([
      { kind: "error", message: "boom", terminal: true },
    ]);
    expect(contentEventsOf("popeye", { kind: "done", exitCode: 0 })).toEqual([]);
  });
});
