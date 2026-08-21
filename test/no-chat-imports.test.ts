import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Gate 3->4 guard: the normalizer never imports chat/protocol types
 * (PLAN.md 3.2 seam). The dependency is one-way - lucid-v2 maps
 * HarnessEvents into frames; a non-lucid consumer can use this runner
 * standalone. Enforced here, not promised.
 */
describe("normalizer / chat-protocol seam", () => {
  test("no src file imports lucid, protocol frames, or chat types", () => {
    const dir = join(import.meta.dirname, "../src");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const FORBIDDEN = /["'][^"'\n]*(lucid|\/frames|chat-protocol|\/reducer)[^"'\n]*["']/;
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(FORBIDDEN.test(source), `src/${file} imports across the chat seam`).toBe(false);
    }
  });
});
