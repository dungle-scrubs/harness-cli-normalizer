import { readFileSync } from "node:fs";
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

test("Muse retains a permission transaction as one opaque native record with exact child strings", () => {
  const capture = readFileSync(
    new URL("../fixtures/muse-1.4.2-R4684.1/retained-frame-session.jsonl", import.meta.url),
    "utf8",
  );
  const lines = capture.trim().split("\n");
  const frame = JSON.parse(lines[0] as string);
  const history = parseMuseHistory(capture);
  expect(history.entries).toHaveLength(lines.length);
  const first = history.entries[0];
  expect(first).toBeDefined();
  if (!first) throw new Error("Missing retained frame");
  expect(encodeJson(first.original)).toBe(lines[0]);
  expect(history.identityRecord.stream).toEqual({
    kind: "session",
    id: "01a10134-76a3-79f0-a7ed-bdad567bda19",
  });
  const record = normalizeMuse(first, "01a10134-76a3-79f0-a7ed-bdad567bda19");
  expect(record.nativeId).toBe(frame.transaction_id);
  expect(record.kind).toBe("record");
  expect(record.originalKind).toBe("saved-record");
  expect(record.normalized).toMatchObject({
    kind: "unknown",
    role: null,
    timestamp: null,
    parts: [],
  });
  expect(record.position?.value).toBe("0");
  expect(history.entries[1]?.offset).toBe(Buffer.byteLength(`${lines[0]}\n`));
});

const permissionFrame = (
  records: readonly unknown[] = [
    envelope("first", 1, { kind: "permission" }),
    envelope("second", 2, { kind: "permission" }),
  ],
) => ({
  retained_frame: "session_permission_transaction",
  frame_schema_version: 1,
  outer_log_ordinal: 1,
  transaction_id: "native-transaction",
  children: records.map((record, child_index) => ({
    child_index,
    record_json: JSON.stringify(record),
  })),
  content_sha256: "opaque-vendor-checksum",
});

test("permission-frame children share exact session identity and sequence order with ordinary records", () => {
  const frame = permissionFrame();
  const after = envelope("after", 3, { kind: "assistant_message_committed", text: "after frame" });
  const history = parseMuseHistory(jsonl([frame, after]));
  expect(history.entries).toHaveLength(2);
  const next = history.entries[1];
  if (!next) throw new Error("Missing post-frame record");
  expect(normalizeMuse(next, sessionId).normalized.parts[0]?.text).toBe("after frame");
  for (const records of [
    [
      envelope("first", 1, {}),
      { ...envelope("second", 2, {}), stream: { kind: "session", id: "other" } },
    ],
    [envelope("same", 1, {}), envelope("same", 2, {})],
    [envelope("first", 2, {}), envelope("second", 1, {})],
    [envelope("first", 1, {}), envelope("second", 1, {})],
    [{ ...envelope("first", 1, {}), schema_version: 2 }],
    [{ ...envelope("first", 1, {}), recorded_at: "1" }],
    [{ ...envelope("first", 1, {}), sequence: 1.5 }],
    [{ ...envelope("first", 1, {}), payload: null }],
  ])
    expect(() => parseMuseHistory(jsonl([permissionFrame(records), after]))).toThrow();
  expect(() => parseMuseHistory(jsonl([frame, { ...after, sequence: 2 }]))).toThrow("sequence");
  expect(() => parseMuseHistory(jsonl([envelope("prior", 2, {}), frame]))).toThrow("sequence");
  expect(() => parseMuseHistory(jsonl([frame, { ...after, id: "first" }]))).toThrow(
    "record identity",
  );
});

test("permission frames reject unsupported variants and malformed framing without discarding children", () => {
  const frame = permissionFrame();
  for (const variant of [
    { ...frame, retained_frame: "future_variant" },
    { ...frame, frame_schema_version: 2 },
    { ...frame, frame_schema_version: "1" },
  ])
    expect(() => parseMuseHistory(jsonl([variant]))).toThrowError(
      expect.objectContaining({
        issue: "guarantee-unmet",
        requirement: "format",
        message: expect.stringMatching(/\S/),
      }),
    );
  for (const invalid of [
    { ...frame, children: [] },
    { ...frame, children: null },
    { ...frame, children: [null] },
    { ...frame, transaction_id: "" },
    { ...frame, transaction_id: null },
    { ...frame, content_sha256: null },
    { ...frame, outer_log_ordinal: -1 },
    { ...frame, outer_log_ordinal: 0.5 },
    { ...frame, outer_log_ordinal: "1" },
    { ...frame, children: [...frame.children].reverse() },
    { ...frame, children: frame.children.map((child) => ({ ...child, child_index: 0 })) },
    { ...frame, children: [{ ...frame.children[0], child_index: "0" }] },
    { ...frame, children: [{ child_index: 0, record_json: {} }] },
    { ...frame, children: [{ child_index: 0, record_json: "[]" }] },
    { ...frame, children: [{ child_index: 0, record_json: '{"truncated":' }] },
  ])
    expect(() => parseMuseHistory(jsonl([invalid]))).toThrowError(
      expect.objectContaining({ issue: "source-malformed", message: expect.stringMatching(/\S/) }),
    );
  expect(() => parseMuseHistory(`${JSON.stringify(frame).slice(0, -20)}\n`)).toThrow();
  const duplicateOuterKey = JSON.stringify(frame).replace(
    '"outer_log_ordinal":1',
    '"outer_log_ordinal":1,"outer_log_ordinal":2',
  );
  expect(() => parseMuseHistory(`${duplicateOuterKey}\n`)).toThrow("Invalid native JSON");
  const duplicateChildKey = JSON.stringify(envelope("one", 1, {})).replace(
    '"id":"one"',
    '"id":"one","id":"two"',
  );
  expect(() =>
    parseMuseHistory(
      jsonl([
        {
          ...frame,
          children: [{ child_index: 0, record_json: duplicateChildKey }],
        },
      ]),
    ),
  ).toThrow("Invalid native JSON");
  const later = { ...permissionFrame([envelope("third", 3, {})]), outer_log_ordinal: 2 };
  expect(() => parseMuseHistory(jsonl([frame, later]))).toThrowError(
    expect.objectContaining({
      issue: "source-malformed",
      message: expect.stringContaining("transaction identity"),
    }),
  );
  expect(() =>
    parseMuseHistory(jsonl([frame, { ...later, transaction_id: "next", outer_log_ordinal: 1 }])),
  ).toThrowError(
    expect.objectContaining({
      issue: "source-malformed",
      message: expect.stringContaining("frame order"),
    }),
  );
});

test("frame checksums stay opaque and child sequence integers never round through Number", () => {
  const huge = ["9007199254740993", "9007199254740994", "9007199254740995"] as const;
  const records = [envelope("first", 1, {}), envelope("second", 2, {})].map((record, index) =>
    JSON.stringify(record).replace(`"sequence":${index + 1}`, `"sequence":${huge[index]}`),
  );
  const frame = {
    ...permissionFrame(),
    content_sha256: "not-an-authenticated-digest",
    children: records.map((record_json, child_index) => ({ record_json, child_index })),
  };
  const plain = JSON.stringify(envelope("after", 3, {}))
    .replace('"sequence":3', `"sequence":${huge[2]}`)
    .replace('"recorded_at":1771088000123456', '"recorded_at":9007199254740993123456');
  const source = `${JSON.stringify(frame)}\n${plain}\n`;
  const history = parseMuseHistory(source);
  expect(history.entries).toHaveLength(2);
  expect(encodeJson(history.entries[0]?.original)).toBe(JSON.stringify(frame));
  expect(encodeJson(history.entries[1]?.original)).toBe(plain);
  const sameAfterRounded = JSON.stringify({
    ...frame,
    children: [
      frame.children[0],
      { ...frame.children[1], record_json: records[1]?.replace(huge[1], huge[0]) },
    ],
  });
  expect(() => parseMuseHistory(`${sameAfterRounded}\n${plain}\n`)).toThrow("sequence");
});

test("an empty permission frame after a valid envelope cannot silently disappear", () => {
  const preceding = envelope("preceding", 0, {});
  const empty = permissionFrame([]);
  expect(() => parseMuseHistory(jsonl([preceding, empty]))).toThrowError(
    expect.objectContaining({ issue: "source-malformed" }),
  );
});

test("a missing Muse history identity is a structured source refusal", () => {
  expect(() => parseMuseHistory("")).toThrowError(
    expect.objectContaining({ issue: "source-malformed", message: expect.stringMatching(/\S/) }),
  );
  expect(parseMuseHistory(jsonl([envelope("first", 1, {})])).headers).toEqual([]);
});

test("an ordinary envelope's permission-frame extension remains an opaque field", () => {
  const ordinary = {
    ...envelope("ordinary", 1, { kind: "assistant_message_committed", text: "ordinary message" }),
    retained_frame: "session_permission_transaction",
  };
  const history = parseMuseHistory(jsonl([ordinary]));
  const entry = history.entries[0];
  if (!entry) throw new Error("Missing ordinary envelope");
  expect(normalizeMuse(entry, sessionId)).toMatchObject({
    kind: "record",
    nativeId: "ordinary",
    originalKind: "saved-record",
    normalized: { kind: "message", parts: [{ text: "ordinary message" }] },
  });
  expect(encodeJson(entry.original)).toBe(JSON.stringify(ordinary));
});

test("Muse reads original event envelopes without exporter rounding or dropping unknown payloads", () => {
  const source = jsonl([
    envelope("first", 42, { kind: "started", prompt: "synthetic question" }),
    {
      ...envelope("second", 43, { kind: "future", value: "EXACT_NUMBER" }),
      opaque: { retained: true },
      retained_frame: "opaque field on an ordinary envelope",
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
  expect(() => parseMuseHistory(jsonl([{ ...valid, schema_version: 99 }]))).toThrow(
    "Unestablished native Muse envelope schema.",
  );
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
