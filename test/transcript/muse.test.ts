import { expect, test } from "vitest";
import { encodeJson } from "../../src/interpretation/transcript/json.js";
import { normalizeMuse, parseMuseHistory } from "../../src/interpretation/transcript/muse.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const envelope = (id: string, sequence: number, event: unknown) => ({
  schema_version: 1,
  id,
  stream: { kind: "session", id: sessionId },
  sequence,
  recorded_at: 1771088000123456,
  record_type: "event",
  durability: "durable",
  causation_id: null,
  payload_type: "runtime.session",
  payload_schema_version: 1,
  payload: { kind: "run", run_id: "synthetic-run", event },
});
const jsonl = (rows: readonly unknown[]): string =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

test("Muse reads original event envelopes without exporter rounding or dropping unknown payloads", () => {
  const source = jsonl([
    envelope("first", 42, { kind: "started", prompt: "synthetic question" }),
    {
      ...envelope("second", 43, { kind: "future", value: "EXACT_NUMBER" }),
      opaque: { retained: true },
    },
  ]).replace('"EXACT_NUMBER"', "1.234567890123456789");
  const history = parseMuseHistory(source);
  expect(history.entries).toHaveLength(2);
  expect(`${history.entries.map((entry) => encodeJson(entry.original)).join("\n")}\n`).toBe(source);
  expect(history.identityRecord.stream).toMatchObject({ kind: "session", id: sessionId });
});

test("Muse rejects mixed native session identities and conflicting record IDs", () => {
  const first = envelope("first", 1, { kind: "started", prompt: "question" });
  const second = envelope("second", 2, { kind: "assistant_message_committed", text: "answer" });
  expect(() =>
    parseMuseHistory(jsonl([first, { ...second, stream: { kind: "session", id: "other" } }])),
  ).toThrow("session identity");
  expect(() => parseMuseHistory(jsonl([first, { ...second, id: "first" }]))).toThrow(
    "record identity",
  );
});

test("Muse requires the established envelope schema and valid native sequence metadata", () => {
  const valid = envelope("first", 42, { kind: "started", prompt: "question" });
  for (const invalid of [
    { ...valid, schema_version: 99 },
    { ...valid, sequence: -1 },
    { ...valid, sequence: 1.5 },
    { ...valid, sequence: "42" },
    { ...valid, recorded_at: null },
    { ...valid, payload_schema_version: "1" },
    { ...valid, payload: null },
    { ...valid, record_type: null },
    { ...valid, durability: false },
    { ...valid, payload_type: "" },
    { ...valid, causation_id: 42 },
  ])
    expect(() => parseMuseHistory(jsonl([invalid]))).toThrow();
});

test("Muse refuses contradictory saved sequence order instead of sorting or silently dropping records", () => {
  const first = envelope("first", 42, { kind: "started", prompt: "question" });
  for (const sequence of [41, 42]) {
    expect(() =>
      parseMuseHistory(
        jsonl([
          first,
          envelope("second", sequence, { kind: "assistant_message_committed", text: "answer" }),
        ]),
      ),
    ).toThrow("sequence");
  }
});

test("Muse normalizes documented prompt and assistant events with exact microsecond timestamps", () => {
  const history = parseMuseHistory(
    jsonl([
      envelope("first", 1, { kind: "started", prompt: "synthetic question" }),
      envelope("second", 2, { kind: "assistant_message_committed", text: "synthetic answer" }),
      {
        ...envelope("future", 3, { kind: "started", prompt: "opaque field" }),
        payload_schema_version: 2,
      },
    ]),
  );
  const records = history.entries.map((entry) => normalizeMuse(entry, sessionId));
  expect(records[0]?.normalized).toMatchObject({
    kind: "message",
    role: "user",
    timestamp: "1771088000.123456",
    parts: [
      { kind: "text", text: "synthetic question", originalPath: ["payload", "event", "prompt"] },
    ],
  });
  expect(records[1]?.normalized).toMatchObject({
    kind: "message",
    role: "assistant",
    parts: [{ kind: "text", text: "synthetic answer", originalPath: ["payload", "event", "text"] }],
  });
  expect(records[2]?.normalized.kind).toBe("unknown");
  expect(records[2]?.normalized.parts).toEqual([]);
  expect(records[2]?.nativeId).toBe("future");
  expect(records[2]?.normalized.relationships["parent-entry"].state).toBe("unknown");
});

test("Muse retains every tool call and batch result with native identities and content paths", () => {
  const history = parseMuseHistory(
    jsonl([
      envelope("calls", 1, {
        kind: "assistant_tool_calls_committed",
        tool_calls: [
          { call_id: "call-1", name: "synthetic.tool", args: { value: "kept" } },
          { id: "call-2", name: "other", args: '{"synthetic":true}' },
        ],
      }),
      envelope("results", 2, {
        kind: "tool_result_batch_committed",
        batch_id: "batch",
        results: [
          { tool_call_id: "call-1", text: "first output" },
          { tool_call_id: "call-2", text: "second output" },
        ],
      }),
    ]),
  );
  const records = history.entries.map((entry) => normalizeMuse(entry, sessionId));
  expect(
    records[0]?.normalized.parts.map((part) => [part.kind, part.toolCallId, part.toolName]),
  ).toEqual([
    ["tool-call", "call-1", "synthetic.tool"],
    ["tool-call", "call-2", "other"],
  ]);
  expect(records[1]?.normalized.kind).toBe("tool-result");
  expect(records[1]?.normalized.parts.map((part) => [part.toolCallId, part.text])).toEqual([
    ["call-1", "first output"],
    ["call-2", "second output"],
  ]);
  expect(records[1]?.normalized.relationships["tool-call"]).toMatchObject({
    basis: "native-field",
    originalPaths: [
      ["payload", "event", "results", 0, "tool_call_id"],
      ["payload", "event", "results", 1, "tool_call_id"],
    ],
    targets: [
      {
        kind: "tool-call",
        nativeId: "call-1",
        scope: { harness: "muse", conversationId: sessionId },
      },
      { nativeId: "call-2" },
    ],
  });
});

test("Muse identifies user steering without relabeling background inbox deliveries as user messages", () => {
  const history = parseMuseHistory(
    jsonl([
      envelope("display", 1, { kind: "user_prompt_display", text: "[Image 1]" }),
      envelope("steer", 2, {
        kind: "inbox_item_queued",
        source: { source: "user_steer" },
        payload: { prompt: "user steering" },
      }),
      envelope("background", 3, {
        kind: "inbox_item_queued",
        source: { source: "scheduled" },
        payload: { prompt: "background input" },
      }),
    ]),
  );
  const records = history.entries.map((entry) => normalizeMuse(entry, sessionId));
  expect(records[0]?.normalized).toMatchObject({ role: "user", parts: [{ text: "[Image 1]" }] });
  expect(records[1]?.normalized).toMatchObject({
    role: "user",
    parts: [{ text: "user steering", originalPath: ["payload", "event", "payload", "prompt"] }],
  });
  expect(records[2]?.normalized.role).toBeNull();
  expect(records[2]?.normalized.parts).toEqual([]);
});
