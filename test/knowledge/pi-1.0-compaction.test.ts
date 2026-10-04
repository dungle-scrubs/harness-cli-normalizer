import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { piCli } from "../../src/knowledge/pi.js";

interface CompactionResult {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly estimatedTokensAfter?: number;
  readonly details?: unknown;
  readonly usage?: unknown;
}
interface RecordValue extends Partial<CompactionResult> {
  readonly type: string;
  readonly id?: string;
  readonly reason?: string;
  readonly result?: CompactionResult;
  readonly message?: {
    readonly role: string;
    readonly content: string | readonly { readonly type: string; readonly text?: string }[];
  };
}
const records = (name: string): RecordValue[] =>
  readFileSync(new URL(`../fixtures/pi-1.0.0/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const textOf = (row: RecordValue): string => {
  const content = row.message?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map((block) => block.text ?? "").join("\n");
};

for (const mode of ["json", "rpc"] as const) {
  test(`Pi 1.0 ${mode} automatic compaction installs matching replacement and survives later-process recall`, () => {
    const native = records(`compaction-${mode}.native.ndjson`);
    expect(native.filter((row) => row.type === "compaction_start")).toEqual([
      expect.objectContaining({ reason: "threshold" }),
    ]);
    const end = native.find((row) => row.type === "compaction_end");
    expect(end).toMatchObject({ reason: "threshold", aborted: false, willRetry: false });
    const result = end?.result;
    expect(result).toBeDefined();
    if (!result) return;
    const session = records(`compaction-${mode}.session.jsonl`);
    const installed = session.find((row) => row.type === "compaction");
    expect(installed).toMatchObject({
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
      details: result.details,
      usage: result.usage,
    });
    const seed = session.find(
      (row) => row.message?.role === "user" && textOf(row).includes("SYNTHETIC-MARKER-"),
    );
    expect(seed).toBeDefined();
    const marker = seed && textOf(seed).match(/SYNTHETIC-MARKER-[A-F0-9-]+/)?.[0];
    expect(marker).toBeDefined();
    const keptIndex = session.findIndex((row) => row.id === result.firstKeptEntryId);
    expect(keptIndex).toBeGreaterThan(session.indexOf(seed as RecordValue));
    expect(result.summary).toContain(marker);
    expect(result.tokensBefore).toBe(53313);
    expect(result.estimatedTokensAfter).toBeLessThan(result.tokensBefore);
    const recall = records(`compaction-${mode}.recall.ndjson`);
    expect(
      recall
        .filter((row) => row.message?.role === "user")
        .map(textOf)
        .join("\n"),
    ).not.toContain(marker);
    expect(
      recall
        .filter((row) => row.type === "message_end" && row.message?.role === "assistant")
        .map(textOf),
    ).toContain(marker);
    const state = freshDecodeState(null);
    const normalized = native.flatMap((row) =>
      decodeLine(piCli, JSON.stringify(row), state, "openai-codex/gpt-6.1-sol"),
    );
    expect(normalized.filter((event) => event.kind === "compaction")).toEqual([
      { kind: "compaction", state: "started", trigger: "auto" },
      {
        kind: "compaction",
        state: "compacted",
        trigger: "auto",
        tokensBefore: result.tokensBefore,
        tokensAfter: result.estimatedTokensAfter,
      },
    ]);
  });
}

test("Pi resultless automatic compaction stays aborted even if Pi later recompacts", () => {
  const native = records("compaction-abort.native.ndjson");
  const state = freshDecodeState(null);
  const normalized = native.flatMap((row) =>
    decodeLine(piCli, JSON.stringify(row), state, "openai-codex/gpt-6.1-sol"),
  );
  const ends = native.filter((row) => row.type === "compaction_end");
  expect(ends[0]).toMatchObject({ reason: "threshold", aborted: true, willRetry: false });
  expect(ends[0]?.result).toBeUndefined();
  expect(
    normalized.filter((event) => event.kind === "compaction").map((event) => event.state),
  ).toEqual(["started", "aborted", "started", "compacted"]);
});

test("Pi's accepted malformed extension boundary is preserved as a native observation", () => {
  const native = records("compaction-malformed.native.ndjson");
  const end = native.find((row) => row.type === "compaction_end");
  expect(end).toMatchObject({
    aborted: false,
    result: { firstKeptEntryId: "synthetic-nonexistent-boundary" },
  });
  const state = freshDecodeState(null);
  const normalized = native.flatMap((row) =>
    decodeLine(piCli, JSON.stringify(row), state, "openai-codex/gpt-6.1-sol"),
  );
  expect(normalized).toContainEqual(
    expect.objectContaining({ kind: "compaction", state: "compacted" }),
  );
});
