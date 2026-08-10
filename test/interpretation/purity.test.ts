import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Gate 2->3 guard: the interpretation layer is 100% pure. No file under
 * src/interpretation or src/knowledge (recursively) may import Node
 * builtins, dynamically import them, or reach for ambient impurity -
 * purity is enforced here, not promised in comments.
 */
const IMPURITY = new RegExp(
  [
    String.raw`from\s+["']node:`,
    String.raw`import\s*\(\s*["']node:`,
    String.raw`require\(`,
    String.raw`\bprocess\.env\b`,
    String.raw`\bDate\.now\(`,
    String.raw`\bMath\.random\(`,
    String.raw`\bBun\.(spawn|file|write)\b`,
  ].join("|"),
);

describe("interpretation layer purity", () => {
  for (const layer of ["interpretation", "knowledge"] as const) {
    test(`src/${layer} imports no I/O modules (recursive)`, () => {
      const dir = join(import.meta.dirname, "../../src", layer);
      const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
        f.endsWith(".ts"),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(join(dir, file), "utf8");
        expect(IMPURITY.test(source), `${layer}/${file} contains an impurity`).toBe(false);
      }
    });
  }
});
