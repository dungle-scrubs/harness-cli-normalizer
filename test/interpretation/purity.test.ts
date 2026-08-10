import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Gate 2->3 guard: the interpretation layer is 100% pure. No file in
 * src/interpretation (or src/knowledge) may import Node builtins or perform
 * I/O - purity is enforced here, not promised in comments.
 */
describe("interpretation layer purity", () => {
  const layers = ["interpretation", "knowledge"] as const;

  for (const layer of layers) {
    test(`src/${layer} imports no I/O modules`, () => {
      const dir = join(__dirname, "../../src", layer);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue;
        const source = readFileSync(join(dir, file), "utf8");
        expect(source, `${layer}/${file} imports a node builtin`).not.toMatch(
          /from\s+["']node:|require\(|child_process|Bun\.(spawn|file|write)/,
        );
      }
    });
  }
});
