/**
 * RFC-05 Phase 3: cursor carries transcript: null (out of v1), so a cursor
 * transcript read refuses as transcript-divergence BEFORE root computation.
 * Without the descriptor-driven check the request would fall into the
 * pi-default else branch and resolve a pi root for a cursor request.
 */
import { describe, expect, test } from "vitest";
import { transcript } from "../../src/cli/transcript.js";

const run = async (
  args: readonly string[],
): Promise<{ lines: string[]; exitCode: number | undefined }> => {
  const lines: string[] = [];
  const write = process.stdout.write;
  const saved = process.exitCode;
  process.stdout.write = ((chunk: unknown, cb?: (error?: Error | null) => void) => {
    lines.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  let code: number | undefined;
  try {
    await transcript([...args]);
    code = process.exitCode;
  } finally {
    process.stdout.write = write;
    process.exitCode = saved;
  }
  return { lines, exitCode: code };
};

describe("cursor transcript divergence", () => {
  test("a cursor transcript read refuses divergence, never a pi root", async () => {
    const { lines, exitCode } = await run([
      "read",
      "cursor",
      "--id",
      "0199a4c5-1111-2222-3333-444455556666",
    ]);
    expect(exitCode).toBe(2);
    const result = JSON.parse(lines.at(-1) ?? "{}") as {
      failure?: { issue?: string; message?: string };
    };
    expect(result.failure?.issue).toBe("transcript-divergence");
  });
});
