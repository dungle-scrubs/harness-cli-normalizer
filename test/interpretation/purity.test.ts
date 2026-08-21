import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Gate 2->3 guard: the interpretation layer is 100% pure. No file under
 * src/interpretation or src/knowledge (recursively) may import outside
 * itself or reach for ambient impurity - purity is enforced here, not
 * promised in comments. Only relative imports are allowed.
 */
const NON_RELATIVE_IMPORT = new RegExp(
  [
    String.raw`from\s+["'](?![./])`,
    String.raw`import\s+["'](?![./])`,
    String.raw`import\s*\(\s*["'](?![./])`,
    String.raw`require\s*\(\s*["'](?![./])`,
  ].join("|"),
);

const AMBIENT_IMPURITY = new RegExp(
  [
    String.raw`\bprocess\.[A-Za-z_]`,
    String.raw`\bfetch\(`,
    String.raw`\bperformance\.`,
    String.raw`\bcrypto\.`,
    String.raw`\bBun\.`,
    String.raw`\bnew Date\(`,
    String.raw`\bglobalThis\b`,
  ].join("|"),
);

const IMPURITY = new RegExp(`${NON_RELATIVE_IMPORT.source}|${AMBIENT_IMPURITY.source}`);

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
        expect(
          NON_RELATIVE_IMPORT.test(source),
          `${layer}/${file} imports a non-relative specifier`,
        ).toBe(false);
        expect(AMBIENT_IMPURITY.test(source), `${layer}/${file} contains ambient impurity`).toBe(
          false,
        );
        expect(IMPURITY.test(source), `${layer}/${file} contains an impurity`).toBe(false);
      }
    });
  }
});
