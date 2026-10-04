/**
 * Cursor re-verification on 2026.09.15-d2fe57e: the smoke snapshots plus a
 * re-capture of the decoding corpus (test/fixtures/cursor-2026.09.15-d2fe57e).
 * Live model output varies between captures, so these assertions pin the
 * decoding rows each probe exercises rather than exact token counts; the
 * 2026.09.10-fd3934a corpus keeps its exact-count suite.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { buildSpawnArgv } from "../../src/interpretation/argv.js";
import type { ContentEvent } from "../../src/interpretation/content.js";
import {
  contentEventsWithState,
  freshCursorReaderState,
} from "../../src/interpretation/content.js";
import { detectTrustRefusal } from "../../src/interpretation/limits.js";
import { resolveEffortSlug } from "../../src/interpretation/vocabulary.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const DIR = join(import.meta.dirname, "..", "fixtures", "cursor-2026.09.15-d2fe57e");
const SNAPSHOT_DIR = join(import.meta.dirname, "..", "fixtures", "cursor-2026.10.01-e373342");
const read = (file: string): string => readFileSync(join(DIR, file), "utf8");

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

const ofKind = <K extends ContentEvent["kind"]>(events: readonly ContentEvent[], kind: K) =>
  events.filter((e): e is Extract<ContentEvent, { kind: K }> => e.kind === kind);

const toolNames = (events: readonly ContentEvent[]): string[] =>
  ofKind(events, "tool").map((e) => e.name);

describe("cursor verification anchor", () => {
  test("smoke:seven and smoke:questions pass on the verified version", () => {
    const seven = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "seven.snapshot.json"), "utf8"));
    for (const [name, cell] of Object.entries(seven.results.cursor))
      expect(cell).toMatchObject({ status: name === "session-cont(1proc)" ? "skip" : "pass" });
    const questions = JSON.parse(
      readFileSync(join(SNAPSHOT_DIR, "questions.snapshot.json"), "utf8"),
    );
    expect(questions.results.cursor.status).toBe("pass");
    expect(questions.observations.cursor).toEqual(cursorCli.escalation.observedOn);
    expect(questions.observations.cursor.version).toBe(cursorCli.verifiedAgainst);
  });
});

describe("cursor re-captured decoding rows", () => {
  test("partial tool-free stream: deltas are tokens, the flush is one message", () => {
    const events = decoded("probe-11.ndjson");
    expect(ofKind(events, "token").length).toBeGreaterThan(1);
    expect(ofKind(events, "message")).toHaveLength(1);
    expect(toolNames(events)).toEqual([]);
    expect(ofKind(events, "error")).toEqual([]);
  });

  test("bare stream: full-text messages, zero tokens", () => {
    const events = decoded("probe-11b.ndjson");
    expect(ofKind(events, "token")).toEqual([]);
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "pong" });
  });

  test("plain stream tool turn: segments with both fields are messages, one tool per call", () => {
    const events = decoded("probe-13.ndjson");
    expect(ofKind(events, "token")).toEqual([]);
    expect(toolNames(events)).toEqual(["readToolCall", "editToolCall"]);
    expect(ofKind(events, "message").at(-1)).toEqual({
      kind: "message",
      role: "assistant",
      text: "DONE",
    });
    expect(ofKind(events, "error")).toEqual([]);
  });

  test("partial tool turn: the same delta shape plus the tool", () => {
    const events = decoded("probe-43.ndjson");
    expect(ofKind(events, "token").length).toBeGreaterThan(0);
    expect(toolNames(events)).toEqual(["readToolCall"]);
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "READ-OK" });
    expect(ofKind(events, "error")).toEqual([]);
  });

  test("web fetch denial pins the reason-bearing message", () => {
    const errors = ofKind(decoded("probe-15.ndjson"), "error");
    expect(errors).toContainEqual({
      kind: "error",
      message: "cursor denied webFetchToolCall: User Rejected",
      denial: { tool: "webFetchToolCall", reason: "User Rejected" },
    });
  });

  test("shell denials pin the empty-reason message form", () => {
    const events = decoded("probe-15s.ndjson");
    const shell = ofKind(events, "error").filter((e) => e.denial?.tool === "shellToolCall");
    expect(shell.length).toBeGreaterThan(0);
    for (const error of shell)
      expect(error).toEqual({
        kind: "error",
        message: "cursor denied shellToolCall (no reason given)",
        denial: { tool: "shellToolCall", reason: "" },
      });
    expect(toolNames(events).filter((name) => name === "shellToolCall")).toHaveLength(shell.length);
  });

  test("ask-question: the query pair before started feeds one denied, non-terminal call", () => {
    const events = decoded("probe-20.ndjson");
    expect(toolNames(events)).toEqual(["askQuestionToolCall"]);
    expect(ofKind(events, "error")).toEqual([
      {
        kind: "error",
        message:
          "cursor denied askQuestionToolCall: Questions skipped by the user, continue with the information you already have",
        denial: {
          tool: "askQuestionToolCall",
          reason: "Questions skipped by the user, continue with the information you already have",
        },
      },
    ]);
  });

  test("--force web search and fetch succeed with no denial", () => {
    expect(toolNames(decoded("probe-51.ndjson"))).toEqual(["webSearchToolCall"]);
    expect(ofKind(decoded("probe-51.ndjson"), "error")).toEqual([]);
    expect(toolNames(decoded("probe-52.ndjson"))).toEqual(["webFetchToolCall"]);
    expect(ofKind(decoded("probe-52.ndjson"), "error")).toEqual([]);
  });

  test("--force shell runs with no query pair and no denial", () => {
    expect(read("probe-52s.ndjson")).not.toContain("interaction_query");
    const events = decoded("probe-52s.ndjson");
    expect(toolNames(events)).toEqual(["shellToolCall"]);
    expect(ofKind(events, "error")).toEqual([]);
  });
});

test("current native resumed recall decodes the original session and marker", () => {
  const state = freshDecodeState("a57de06c-d5f4-4b1e-975c-11045b754c33", "cursor");
  const events = readFileSync(join(SNAPSHOT_DIR, "seven-05.ndjson"), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(cursorCli, line, state, "gpt-5-mini"));
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "identity",
      sessionId: "a57de06c-d5f4-4b1e-975c-11045b754c33",
    }),
  );
  expect(
    events
      .filter((event) => event.kind === "token")
      .map((event) => event.text)
      .join(""),
  ).toBe("marlin");
  expect(events.filter((event) => event.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "marlin" },
  ]);
  expect(events.filter((event) => event.kind === "error")).toEqual([]);
});

test("current automatic compaction hooks expose no usable accounting and saved HCN later recall succeeds", () => {
  const hooks = readFileSync(join(SNAPSHOT_DIR, "preCompact.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(hooks.length).toBeGreaterThan(0);
  for (const hook of hooks) {
    expect(hook).toMatchObject({
      trigger: "auto",
      cursor_version: "2026.10.01-e373342",
      context_usage_percent: 0,
      context_tokens: 0,
      context_window_size: 0,
    });
    expect(hook.messages_to_compact).toBeGreaterThan(0);
  }
  const recall = readFileSync(join(SNAPSHOT_DIR, "later-recall.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(recall).toContainEqual({ kind: "message", role: "assistant", text: "LANTERN-903" });
  expect(recall.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
  const state = freshDecodeState(null, "cursor");
  const native = readFileSync(join(SNAPSHOT_DIR, "later-recall.native.ndjson"), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(cursorCli, line, state, "gpt-5-mini"));
  expect(native.filter((event) => event.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "LANTERN-903" },
  ]);
  expect(native.filter((event) => event.kind === "error")).toEqual([]);
});

test("current Cursor family selectors render the native high-effort slugs", () => {
  for (const stem of ["grok-4.7", "claude-opus-5-5", "claude-sonnet-5-5"]) {
    const model = resolveEffortSlug(cursorCli, stem, "high");
    const argv = buildSpawnArgv(cursorCli, { prompt: "Reply only OK.", model });
    expect(argv[argv.indexOf("--model") + 1]).toBe(`${stem}-high`);
  }
});

describe("cursor re-captured non-stream evidence", () => {
  test("the trust gate still reads Workspace Trust Required", () => {
    const lines = read("trust-01.stderr.txt")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.some((line) => detectTrustRefusal(cursorCli, line))).toBe(true);
  });

  test("help keeps the variadic prompt usage", () => {
    expect(read("help.stdout.txt")).toContain("Usage: agent [options] [command] [prompt...]");
  });

  test("agent models lists exactly the transcribed slugs", () => {
    const entries = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "cursor-2026.10.01-e373342", "models.txt"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.includes(" - "))
      .map((line) => (line.split(" - ")[0] as string).trim());
    expect(entries).toHaveLength(246);
    expect([...cursorCli.vocabulary.models].sort()).toEqual([...entries].sort());
  });
});
