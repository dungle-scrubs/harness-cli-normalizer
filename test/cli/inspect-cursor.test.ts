/**
 * RFC-05 Phase 2: the inspect descriptor dump reads the effortSlugs
 * families alongside effortsByModel. Cursor joins the shared descriptor
 * set (and becomes addressable here) in Phase 3; until then the field
 * serializes as absent and existing harness output stays byte-identical.
 */
import { describe, expect, test } from "vitest";
import { inspect } from "../../src/cli/inspect.js";

const dumpVocabularyKeys = async (harness: string): Promise<string[]> => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await inspect(harness, []);
  } finally {
    process.stdout.write = original as typeof process.stdout.write;
  }
  const dump = JSON.parse(chunks.join("")) as {
    vocabulary: Record<string, unknown>;
  };
  return Object.keys(dump.vocabulary).sort();
};

describe("inspect family display", () => {
  test("existing harnesses render no effortSlugs field", async () => {
    expect(await dumpVocabularyKeys("claude")).toEqual([
      "aliases",
      "efforts",
      "extensible",
      "modelFlag",
      "models",
    ]);
    expect(await dumpVocabularyKeys("codex")).toEqual([
      "aliases",
      "efforts",
      "effortsByModel",
      "extensible",
      "modelFlag",
      "models",
    ]);
  });
});
