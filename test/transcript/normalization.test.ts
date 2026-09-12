import { expect, test } from "vitest";
import { normalizePi, parsePiHistory } from "../../src/interpretation/transcript/pi.js";

test("custom Pi entry kinds preserve fields without inventing recognized content or relationships", () => {
  const history = parsePiHistory(
    '{"type":"session","version":3,"id":"synthetic","cwd":"/synthetic"}\n{"type":"vendor_extension","id":"entry","parentId":null,"fromId":"not-a-branch","firstKeptEntryId":"not-compaction","message":{"role":"toolResult","toolCallId":"not-a-call"},"content":"opaque"}\n',
  );
  const entry = history.entries[0];
  if (!entry) throw new Error("Missing synthetic entry");
  const record = normalizePi(entry, "synthetic");
  expect(record.normalized.kind).toBe("unknown");
  expect(record.normalized.parts).toEqual([]);
  expect(record.normalized.relationships["branch-origin"].state).toBe("unknown");
  expect(record.normalized.relationships["first-kept-entry"].state).toBe("unknown");
  expect(record.normalized.relationships["tool-call"].state).toBe("unknown");
  expect(record.original.fromId).toBe("not-a-branch");
});

test("Pi branch summaries expose only the verified native branch origin", () => {
  const history = parsePiHistory(
    '{"type":"session","version":3,"id":"synthetic","cwd":"/synthetic"}\n{"type":"branch_summary","id":"summary","parentId":"a","fromId":"a","summary":"synthetic"}\n',
  );
  const entry = history.entries[0];
  if (!entry) throw new Error("Missing entry");
  const relation = normalizePi(entry, "synthetic").normalized.relationships["branch-origin"];
  expect(relation.state).toBe("known");
  expect(relation.targets[0]?.nativeId).toBe("a");
  expect(relation.targets[0]?.kind).toBe("entry");
});

test("native format versions use exact decimal equality", () => {
  const source =
    '{"type":"session","version":3.0000000000000000001,"id":"synthetic","cwd":"/synthetic"}\n';
  expect(() => parsePiHistory(source)).toThrow();
  expect(parsePiHistory(source.replace("3.0000000000000000001", "30e-1")).entries).toEqual([]);
});
