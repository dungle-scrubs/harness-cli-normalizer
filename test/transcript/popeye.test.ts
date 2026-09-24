import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Json } from "../../src/interpretation/transcript/json.js";
import { object, string } from "../../src/interpretation/transcript/json.js";
import {
  normalizePopeye,
  parsePopeyeHistory,
  popeyeBranch,
} from "../../src/interpretation/transcript/popeye.js";

const itemId = (entry: { original: Record<string, unknown> }): string | null =>
  string(object(entry.original.item as Json)?.id);

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "popeye-0.1.0", "journal.jsonl");

const read = (): string => readFileSync(FIXTURE, "utf8");

describe("popeye transcript reader (RFC-02 P5)", () => {
  test("the canonical fixture parses to 23 entries under the header session", () => {
    const history = parsePopeyeHistory(read());
    expect(history.identityRecord.sessionId).toBe("p3s-01");
    expect(history.entries).toHaveLength(23);
  });

  test("message, tool-result, compaction, and metadata kinds normalize", () => {
    const history = parsePopeyeHistory(read());
    const byId = new Map(history.entries.map((entry) => [itemId(entry), entry] as const));
    const user = byId.get("p3e-02");
    if (!user) throw new Error("Missing p3e-02");
    expect(normalizePopeye(user, "p3s-01").normalized).toMatchObject({
      kind: "message",
      role: "user",
      timestamp: null,
    });
    const toolResult = byId.get("p3e-04");
    if (!toolResult) throw new Error("Missing p3e-04");
    expect(normalizePopeye(toolResult, "p3s-01").normalized).toMatchObject({
      kind: "tool-result",
      role: "tool",
    });
    const compaction = byId.get("p3e-13");
    if (!compaction) throw new Error("Missing p3e-13");
    const compacted = normalizePopeye(compaction, "p3s-01").normalized;
    expect(compacted.kind).toBe("compaction");
    expect(compacted.parts.map((part) => part.text)).toContain("Canonical compacted transcript.");
    const record = history.entries.find((entry) => entry.original.type === "record");
    if (!record) throw new Error("Missing record line");
    expect(normalizePopeye(record, "p3s-01").normalized.kind).toBe("metadata");
  });

  test("parent-entry and tool-call relationships resolve to native ids", () => {
    const history = parsePopeyeHistory(read());
    const byId = new Map(history.entries.map((entry) => [itemId(entry), entry] as const));
    const child = byId.get("p3e-03");
    if (!child) throw new Error("Missing p3e-03");
    const parent = normalizePopeye(child, "p3s-01").normalized.relationships["parent-entry"];
    expect(parent.state).toBe("known");
    expect(parent.targets[0]).toMatchObject({ kind: "entry", nativeId: "p3e-02" });
    const toolResult = byId.get("p3e-04");
    if (!toolResult) throw new Error("Missing p3e-04");
    const call = normalizePopeye(toolResult, "p3s-01").normalized.relationships["tool-call"];
    expect(call.state).toBe("known");
    expect(call.targets[0]).toMatchObject({ kind: "tool-call", nativeId: "read-call" });
  });

  test("assistant tool calls become tool-call parts", () => {
    const history = parsePopeyeHistory(read());
    const entry = history.entries.find((candidate) => itemId(candidate) === "p3e-03");
    if (!entry) throw new Error("Missing p3e-03");
    const parts = normalizePopeye(entry, "p3s-01").normalized.parts;
    expect(parts.filter((part) => part.kind === "tool-call")).toMatchObject([
      { toolCallId: "read-call", toolName: "read-file" },
    ]);
  });

  test("branch selection is the last entry", () => {
    const history = parsePopeyeHistory(read());
    expect(popeyeBranch(history, "p3s-01")).toMatchObject({
      selection: { kind: "entry", nativeId: "p3e-13" },
      state: "known",
      view: "saved",
    });
  });

  test("a torn tail parses as the intact prefix", () => {
    const torn = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "popeye-0.1.0", "journal-torn.jsonl"),
      "utf8",
    );
    // The unterminated tail line never yields; the reader sees the 23
    // intact entries. incompleteTail comes from the read layer, which
    // compares bytes against the parsed prefix.
    expect(parsePopeyeHistory(torn).entries).toHaveLength(23);
  });

  test("lines from another session refuse", () => {
    expect(() =>
      parsePopeyeHistory(
        '{"v":1,"payload":{"format":"popeye_journal","sessionId":"s1","type":"journal_header","version":1}}\n{"v":1,"payload":{"item":{"id":"e1","kind":"session_root","parentId":null,"payload":{}},"sessionId":"s2","type":"entry"}}\n',
      ),
    ).toThrow();
  });
});

test("duplicate ids and wrong versions refuse", () => {
  const header =
    '{"v":1,"payload":{"format":"popeye_journal","sessionId":"s1","type":"journal_header","version":1}}\n';
  const root = (id: string) =>
    `{"v":1,"payload":{"item":{"id":"${id}","kind":"session_root","parentId":null,"payload":{}},"sessionId":"s1","type":"entry"}}\n`;
  expect(() => parsePopeyeHistory(`${header}${root("e1")}${root("e1")}`)).toThrow();
  expect(() =>
    parsePopeyeHistory(header.replace('"version":1', '"version":2') + root("e1")),
  ).toThrow();
});
