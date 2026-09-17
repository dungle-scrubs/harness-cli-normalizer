/**
 * RFC-05: the inspect descriptor dump reads the cursor effortSlugs
 * families alongside effortsByModel. The field serializes as absent on
 * the four existing harnesses, so their output stays byte-identical.
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

  test("cursor's dump includes the effortSlugs families", async () => {
    expect(await dumpVocabularyKeys("cursor")).toContain("effortSlugs");
  });
});
