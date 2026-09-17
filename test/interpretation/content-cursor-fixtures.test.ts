/**
 * RFC-05 Phase 4: cursor decoder tests over normalized captures, not
 * synthetic records. Each fixture is a verbatim spike stream-json capture
 * (see test/fixtures/cursor-2026.09.10-fd3934a/README.md); the suite pins
 * the decoding-table rows the representative probes exercise, including
 * the assistant-shape discriminator, both toolCallId paths, the split
 * unknown-call_id outcomes, and the denial message text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ContentEvent } from "../../src/interpretation/content.js";
import {
  contentEventsWithState,
  freshCursorReaderState,
} from "../../src/interpretation/content.js";
import { detectTrustRefusal } from "../../src/interpretation/limits.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const DIR = join(import.meta.dirname, "..", "fixtures", "cursor-2026.09.10-fd3934a");
const read = (file: string): string => readFileSync(join(DIR, file), "utf8");

/** Feed every line of a stream fixture through the stateful reader. */
const decoded = (file: string): ContentEvent[] => {
  let state = freshCursorReaderState();
  const events: ContentEvent[] = [];
  for (const line of read(file).split("\n")) {
    if (line.trim() === "") continue;
    const out = contentEventsWithState(
      "cursor",
      JSON.parse(line) as Record<string, unknown>,
      state,
    );
    events.push(...out.events);
    if (out.state !== null) state = out.state;
  }
  return events;
};

const kinds = (events: readonly ContentEvent[]): string[] => events.map((e) => e.kind);

describe("cursor granularity fixtures", () => {
  test("probe 11 (partial, tool-free): deltas are tokens, the flush is one message", () => {
    const events = decoded("probe-11.ndjson");
    const tokens = events.filter((e) => e.kind === "token");
    const messages = events.filter((e) => e.kind === "message");
    expect(tokens).toHaveLength(21);
    expect(tokens[0]).toMatchObject({ kind: "token", text: "River" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "message", role: "assistant" });
    expect(kinds(events)).not.toContain("tool");
    expect(kinds(events)).not.toContain("error");
  });

  test("probe 11b (bare stream): one message, zero tokens", () => {
    const events = decoded("probe-11b.ndjson");
    expect(events.filter((e) => e.kind === "token")).toHaveLength(0);
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "pong" });
  });

  test("probe 43 (partial with tools): the same delta shape plus one tool pair", () => {
    const events = decoded("probe-43.ndjson");
    expect(events.filter((e) => e.kind === "token")).toHaveLength(2);
    expect(events).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "READ-OK",
    });
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(1);
    expect(kinds(events)).not.toContain("error");
  });
});

describe("cursor assistant-shape discriminator on fixtures", () => {
  test("probe 13: a segment with both fields is a message, not a token", () => {
    const events = decoded("probe-13.ndjson");
    expect(events.filter((e) => e.kind === "token")).toHaveLength(0);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: "message", role: "assistant" });
    expect(messages[1]).toEqual({ kind: "message", role: "assistant", text: "DONE" });
  });

  test("probe 13: read then edit calls each emit one tool event, successes nothing", () => {
    const events = decoded("probe-13.ndjson");
    expect(events.filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", name: "readToolCall", input: expect.anything() },
      { kind: "tool", name: "editToolCall", input: expect.anything() },
    ]);
    expect(kinds(events)).not.toContain("error");
  });
});

describe("cursor denial fixtures", () => {
  test("probe 15: three started denials plus the unknown webSearch pair", () => {
    const events = decoded("probe-15.ndjson");
    const tools = events.filter((e) => e.kind === "tool");
    const errors = events.filter((e) => e.kind === "error");
    // Three started calls plus the unknown-call_id webSearch completion,
    // which emits its tool event first so no denial lacks an invocation.
    expect(tools.map((e) => (e as { name: string }).name)).toEqual([
      "webFetchToolCall",
      "shellToolCall",
      "shellToolCall",
      "webSearchToolCall",
    ]);
    expect(errors).toHaveLength(4);
  });

  test("probe 15: denial message text pinned, including the empty-reason form", () => {
    const events = decoded("probe-15.ndjson");
    const messages = events
      .filter((e) => e.kind === "error")
      .map((e) => (e as { message: string }).message);
    expect(messages).toContain("cursor denied webFetchToolCall: User Rejected");
    expect(messages).toContain("cursor denied webSearchToolCall: User Rejected");
    expect(
      messages.filter((m) => m === "cursor denied shellToolCall (no reason given)"),
    ).toHaveLength(2);
    for (const e of events) {
      if (e.kind !== "error") continue;
      const denial = (e as { denial?: { tool: string; reason: string } }).denial;
      expect(denial).toMatchObject({ tool: expect.any(String), reason: expect.any(String) });
    }
  });

  test("probe 20: the query pair before started feeds the ask call; the turn still ends success", () => {
    const events = decoded("probe-20.ndjson");
    expect(events.filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", name: "askQuestionToolCall", input: expect.anything() },
    ]);
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: "error",
      message:
        "cursor denied askQuestionToolCall: Questions skipped by the user, continue with the information you already have",
      denial: {
        tool: "askQuestionToolCall",
        reason: "Questions skipped by the user, continue with the information you already have",
      },
    });
    expect(events.some((e) => e.kind === "error" && (e as { terminal?: boolean }).terminal)).toBe(
      false,
    );
  });
});

describe("cursor --force success shapes", () => {
  test("probe 51: a pre-approved query pair before started emits nothing; success emits no denial", () => {
    const events = decoded("probe-51.ndjson");
    expect(events.filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", name: "webSearchToolCall", input: expect.anything() },
    ]);
    expect(kinds(events)).not.toContain("error");
  });

  test("probe 52: a mid-call pair plus a shell call with no pair at all", () => {
    const events = decoded("probe-52.ndjson");
    expect(
      events.filter((e) => e.kind === "tool").map((e) => (e as { name: string }).name),
    ).toEqual(["webFetchToolCall", "shellToolCall"]);
    expect(kinds(events)).not.toContain("error");
  });
});

describe("cursor non-stream fixture evidence", () => {
  test("probe 01 stderr detects the trust gate on its first line", () => {
    const lines = read("trust-01.stderr.txt")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines[0]).toMatch(/Workspace Trust Required/);
    expect(lines.some((line) => detectTrustRefusal(cursorCli, line))).toBe(true);
    expect(detectTrustRefusal(cursorCli, "all done")).toBe(false);
  });

  test("probe 50 help pins the prompt-join evidence: a variadic prompt with no -- handling", () => {
    const help = read("help-50.stdout.txt");
    expect(help).toContain("Usage: agent [options] [command] [prompt...]");
    expect(help).not.toMatch(/--\s+.*separator|end-of-options/i);
  });

  test("models.txt is the 223-entry transcription source", () => {
    const lines = read("models.txt").split("\n");
    const entries = lines.filter((l) => l.includes(" - "));
    expect(entries).toHaveLength(223);
    expect(new Set(entries.map((l) => l.split(" - ")[0])).size).toBe(223);
    expect([...cursorCli.vocabulary.models].sort()).toEqual(
      entries.map((l) => (l.split(" - ")[0] as string).trim()).sort(),
    );
  });
});
