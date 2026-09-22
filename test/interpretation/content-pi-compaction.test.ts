import { describe, expect, test } from "vitest";
import { contentEventsOf } from "../../src/interpretation/content.js";

/**
 * ADR 0009, pi's mapping (#239). The two bracketing records are quoted
 * verbatim from the 0.87.0 probe in
 * `docs/research/2026-09-22-compaction-signals/pi/`, with the 1010-character
 * summary elided the way that document elides it. The decoder reads one
 * record at a time and holds no state between them.
 */

const start = { type: "compaction_start", reason: "threshold" };

const end = {
  type: "compaction_end",
  reason: "threshold",
  result: {
    summary: "No prior history.\n\n---\n\n**Turn Context (split turn):**",
    firstKeptEntryId: "436ffedd",
    tokensBefore: 58656,
    estimatedTokensAfter: 39452,
    usage: {
      input: 18768,
      output: 377,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 169,
      totalTokens: 19145,
    },
    details: { readFiles: [], modifiedFiles: [] },
  },
  aborted: false,
  willRetry: false,
};

describe("pi compaction decoding", () => {
  test("the start record opens the pause, with threshold normalized to auto", () => {
    expect(contentEventsOf("pi", start)).toEqual([
      { kind: "compaction", state: "started", trigger: "auto" },
    ]);
  });

  test("the end record carries the counts pi reported, and nothing hcn derived", () => {
    expect(contentEventsOf("pi", end)).toEqual([
      {
        kind: "compaction",
        state: "compacted",
        trigger: "auto",
        tokensBefore: 58656,
        tokensAfter: 39452,
      },
    ]);
  });

  test("one compaction yields exactly one start and one end", () => {
    const crossing = [start, end].flatMap((r) => contentEventsOf("pi", r));
    expect(crossing.map((e) => (e.kind === "compaction" ? e.state : e.kind))).toEqual([
      "started",
      "compacted",
    ]);
  });

  test("pi's three reason words map onto the shared trigger vocabulary", () => {
    const triggerOf = (reason: string): string | undefined => {
      const [event] = contentEventsOf("pi", { type: "compaction_start", reason });
      return event !== undefined && event.kind === "compaction" ? event.trigger : undefined;
    };
    expect(triggerOf("threshold")).toBe("auto");
    expect(triggerOf("manual")).toBe("manual");
    expect(triggerOf("overflow")).toBe("overflow");
    // An unknown word invents no trigger; the state still reports.
    expect(contentEventsOf("pi", { type: "compaction_start", reason: "sideways" })).toEqual([
      { kind: "compaction", state: "started" },
    ]);
    expect(contentEventsOf("pi", { type: "compaction_start" })).toEqual([
      { kind: "compaction", state: "started" },
    ]);
  });

  test("an aborted end record is detected by its flag, with the result key ABSENT", () => {
    // docs/rpc.md says `result` is null on an abort. The implementation
    // emits `result: undefined` and JSON.stringify drops the key, so on the
    // wire it is absent. A reader testing `result === null` sees nothing,
    // which is the trap this asserts against.
    expect(
      contentEventsOf("pi", { type: "compaction_end", reason: "threshold", aborted: true }),
    ).toEqual([{ kind: "compaction", state: "aborted", trigger: "auto" }]);
    // The documented shape must work too, in case a build matches the docs.
    expect(
      contentEventsOf("pi", {
        type: "compaction_end",
        reason: "manual",
        result: null,
        aborted: true,
      }),
    ).toEqual([{ kind: "compaction", state: "aborted", trigger: "manual" }]);
  });

  test("a resultless end record that was not aborted reports failed, not compacted", () => {
    // Reporting `compacted` with no counts would say a compaction succeeded
    // when pi's own failure path ran.
    expect(
      contentEventsOf("pi", { type: "compaction_end", reason: "overflow", aborted: false }),
    ).toEqual([{ kind: "compaction", state: "failed", trigger: "overflow" }]);
  });

  test("an end record with no counts still reports the state and invents no numbers", () => {
    expect(
      contentEventsOf("pi", {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s", tokensBefore: "lots" },
        aborted: false,
      }),
    ).toEqual([{ kind: "compaction", state: "compacted", trigger: "auto" }]);
  });

  test("the records pi already decoded are untouched by the compaction arms", () => {
    expect(
      contentEventsOf("pi", {
        type: "tool_execution_start",
        toolName: "bash",
        args: { cmd: "ls" },
      }),
    ).toEqual([{ kind: "tool", name: "bash", input: { cmd: "ls" } }]);
    expect(
      contentEventsOf("pi", {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
    ).toEqual([{ kind: "token", text: "hi" }]);
    // A record carrying a `reason` that is not a compaction record must not
    // be swallowed: piCompaction returns null and the rest of pi runs.
    expect(contentEventsOf("pi", { type: "agent_settled", reason: "threshold" })).toEqual([]);
  });
});
