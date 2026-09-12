import { expect, test } from "vitest";
import {
  claudeBranch,
  normalizeClaude,
  parseClaudeHistory,
} from "../../src/interpretation/transcript/claude.js";
import { encodeJson } from "../../src/interpretation/transcript/json.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const answerId = "33333333-3333-4333-8333-333333333333";
const row = (type: string, uuid: string, parentUuid: string | null, content: unknown) => ({
  cwd: "/synthetic",
  isSidechain: false,
  message: { content, role: type },
  parentUuid,
  sessionId,
  timestamp: "2026-09-12T00:00:00.000Z",
  type,
  uuid,
  version: "2.1.233",
});
const jsonl = (rows: readonly unknown[]): string =>
  `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`;

test("Claude retains metadata, abandoned branches and unknown native values in saved order", () => {
  const rows = [
    { type: "custom-title", customTitle: "Synthetic", sessionId },
    row("user", userId, null, "synthetic question"),
    row("assistant", answerId, userId, "abandoned answer"),
    row("assistant", "44444444-4444-4444-8444-444444444444", userId, "selected answer"),
    { type: "last-prompt", sessionId, leafUuid: answerId, explicit: true },
    { type: "future", exact: "DECIMAL_TOKEN", nested: { uuid: "opaque" } },
  ];
  const input = jsonl(rows).replace('"DECIMAL_TOKEN"', "1.234567890123456789");
  const history = parseClaudeHistory(input);
  expect(history.identityRecord.sessionId).toBe(sessionId);
  expect(`${history.entries.map(({ original }) => encodeJson(original)).join("\n")}\n`).toBe(input);
  expect(history.entries[0]?.offset).toBe(0);
  expect(history.entries[1]?.offset).toBe(new TextEncoder().encode(jsonl([rows[0]])).length);
});

test("Claude rejects a second conversation identity instead of mixing its history", () => {
  const input = jsonl([
    row("user", userId, null, "first conversation"),
    { ...row("assistant", answerId, userId, "other conversation"), sessionId: "other" },
  ]);
  expect(() => parseClaudeHistory(input)).toThrow("conversation identity");
});

test("Claude rejects conflicting native message IDs instead of selecting a last-wins record", () => {
  expect(() =>
    parseClaudeHistory(
      jsonl([
        row("user", userId, null, "question"),
        row("assistant", answerId, userId, "first answer"),
        row("assistant", answerId, userId, "conflicting answer"),
      ]),
    ),
  ).toThrow("entry identity");
});

test("Claude tool results retain all call identities and native content paths", () => {
  const input = jsonl([
    row("assistant", answerId, null, [
      { type: "tool_use", id: "call-1", name: "synthetic_tool", input: { value: "opaque" } },
    ]),
    row("user", userId, answerId, [
      { type: "tool_result", tool_use_id: "call-1", content: "first tool output" },
      { type: "tool_result", tool_use_id: "call-2", content: "second tool output", is_error: true },
    ]),
  ]);
  const history = parseClaudeHistory(input);
  const records = history.entries.map((entry) => normalizeClaude(entry, sessionId));
  expect(records[0]?.normalized.parts[0]).toMatchObject({
    kind: "tool-call",
    toolCallId: "call-1",
    toolName: "synthetic_tool",
  });
  expect(records[1]?.normalized.kind).toBe("tool-result");
  expect(
    records[1]?.normalized.parts.map((part) => [part.toolCallId, part.text, part.originalPath]),
  ).toEqual([
    ["call-1", "first tool output", ["message", "content", 0]],
    ["call-2", "second tool output", ["message", "content", 1]],
  ]);
  expect(records[1]?.normalized.relationships["tool-call"]).toMatchObject({
    basis: "native-field",
    originalPaths: [
      ["message", "content", 0, "tool_use_id"],
      ["message", "content", 1, "tool_use_id"],
    ],
    targets: [
      {
        kind: "tool-call",
        nativeId: "call-1",
        scope: { conversationId: sessionId, harness: "claude" },
      },
      {
        kind: "tool-call",
        nativeId: "call-2",
        scope: { conversationId: sessionId, harness: "claude" },
      },
    ],
  });
  expect(`${records.map(({ original }) => encodeJson(original)).join("\n")}\n`).toBe(input);
});

test("Claude text, thinking and embedded media preserve their native content paths", () => {
  const history = parseClaudeHistory(
    jsonl([
      row("user", userId, null, "plain question"),
      row("assistant", answerId, userId, [
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "retained reasoning", signature: "opaque" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "SYNTHETIC" } },
        { type: "image", source: { type: "url", url: "https://example.invalid/image" } },
        { type: "future", text: "opaque future field" },
      ]),
    ]),
  );
  const records = history.entries.map((entry) => normalizeClaude(entry, sessionId));
  expect(records[0]?.normalized.parts[0]).toMatchObject({
    kind: "text",
    text: "plain question",
    originalPath: ["message", "content"],
  });
  expect(
    records[1]?.normalized.parts.map(({ kind, contentStatus, text }) => ({
      kind,
      contentStatus,
      text,
    })),
  ).toEqual([
    { kind: "text", contentStatus: "included", text: "answer" },
    { kind: "thinking", contentStatus: "included", text: "retained reasoning" },
    { kind: "image", contentStatus: "included", text: null },
    { kind: "image", contentStatus: "not-included", text: null },
    { kind: "unknown", contentStatus: "unknown", text: null },
  ]);
  expect(records[1]?.normalized.timestamp).toBe("1789171200");
});

test("Claude exposes native parent and fork references without merging another conversation", () => {
  const parentId = "55555555-5555-4555-8555-555555555555";
  const history = parseClaudeHistory(
    jsonl([
      row("user", userId, null, "question"),
      row("assistant", answerId, userId, "answer"),
      {
        type: "fork-context-ref",
        sessionId,
        parentSessionId: parentId,
        parentLastUuid: "parent-entry",
      },
      { type: "future", parentUuid: "opaque", parentSessionId: "opaque", parentLastUuid: "opaque" },
    ]),
  );
  const relationships = history.entries.map(
    (entry) => normalizeClaude(entry, sessionId).normalized.relationships,
  );
  expect(relationships[0]?.["parent-entry"]).toMatchObject({
    state: "none",
    basis: "native-field",
    originalPaths: [["parentUuid"]],
  });
  expect(relationships[1]?.["parent-entry"].targets[0]).toMatchObject({
    kind: "entry",
    nativeId: userId,
  });
  expect(relationships[2]?.["parent-conversation"].targets[0]).toMatchObject({
    kind: "conversation",
    nativeId: parentId,
    scope: { conversationId: parentId },
  });
  expect(relationships[2]?.["branch-origin"].targets[0]).toMatchObject({
    kind: "entry",
    nativeId: "parent-entry",
    scope: { conversationId: parentId },
  });
  expect(relationships[3]?.["parent-entry"].state).toBe("unknown");
  expect(relationships[3]?.["parent-conversation"].state).toBe("unknown");
});

test("Claude saved selection follows the explicit leaf, including rewinds, rather than the final message", () => {
  const history = parseClaudeHistory(
    jsonl([
      row("user", userId, null, "question"),
      row("assistant", answerId, userId, "answer"),
      { type: "last-prompt", sessionId, leafUuid: userId, explicit: true, rewound: true },
      { type: "last-prompt", sessionId, lastPrompt: "display metadata only" },
    ]),
  );
  expect(claudeBranch(history, sessionId)).toMatchObject({
    state: "known",
    view: "saved",
    selection: { kind: "entry", nativeId: userId, scope: { conversationId: sessionId } },
  });
});

test("Claude rejects malformed known transcript rows while preserving unfamiliar record payloads", () => {
  const valid = row("user", userId, null, "question");
  for (const invalid of [
    { ...valid, uuid: null },
    { ...valid, parentUuid: 42 },
    { ...valid, message: "not a message object" },
    { ...valid, message: {} },
    { ...valid, message: { role: "assistant", content: "contradictory role" } },
    { ...valid, message: { role: "user", content: 42 } },
    { ...valid, sessionId: "" },
    { ...valid, type: "" },
  ])
    expect(() => parseClaudeHistory(jsonl([invalid]))).toThrow();
});

test("Claude retains compaction boundaries and native system text without hiding earlier history", () => {
  const history = parseClaudeHistory(
    jsonl([
      row("user", userId, null, "before compaction"),
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        uuid: answerId,
        parentUuid: null,
        logicalParentUuid: userId,
        sessionId,
        compactMetadata: {
          trigger: "auto",
          preservedSegment: { headUuid: userId, anchorUuid: answerId, tailUuid: userId },
        },
      },
    ]),
  );
  expect(history.entries).toHaveLength(2);
  const entry = history.entries[1];
  if (!entry) throw new Error("Missing compaction entry");
  const record = normalizeClaude(entry, sessionId);
  expect(record.normalized.kind).toBe("compaction");
  expect(record.normalized.role).toBe("system");
  expect(record.normalized.parts[0]).toMatchObject({
    text: "Conversation compacted",
    originalPath: ["content"],
  });
  expect(record.normalized.relationships["first-kept-entry"]).toMatchObject({
    basis: "native-field",
    originalPaths: [["compactMetadata", "preservedSegment", "headUuid"]],
    targets: [{ kind: "entry", nativeId: userId }],
  });
  expect(record.original.logicalParentUuid).toBe(userId);
});

test("Claude keeps unfamiliar UUID fields opaque instead of treating them as entry identities", () => {
  const history = parseClaudeHistory(
    jsonl([row("user", userId, null, "question"), { type: "future", uuid: userId, opaque: true }]),
  );
  const entry = history.entries[1];
  if (!entry) throw new Error("Missing retained entry");
  const record = normalizeClaude(entry, sessionId);
  expect(record.nativeId).toBeNull();
  expect(record.original.uuid).toBe(userId);
  expect(record.position).not.toBeNull();
});

test("Claude main-file identity cannot come from an opaque future field or an agent sidechain", () => {
  expect(() => parseClaudeHistory(jsonl([{ type: "future", sessionId }]))).toThrow(
    "conversation identity",
  );
  expect(() =>
    parseClaudeHistory(
      jsonl([
        {
          ...row("user", userId, null, "agent question"),
          isSidechain: true,
          agentId: "native-agent",
        },
      ]),
    ),
  ).toThrow("Agent transcript");
});
