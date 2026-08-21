import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, test } from "vitest";

/**
 * Claude's persistent-session input vocabulary belongs to its knowledge
 * descriptor and interpretation encoder. Execution may dispatch a closed
 * contract kind, but must not own Claude's `user` protocol value.
 */
describe("execution layer dual-runtime invariant", () => {
  test("no execution source except node-deps.ts imports node:child_process or calls process.kill (Bun lane parity)", () => {
    const dir = join(import.meta.dirname, "../src/execution");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (file === "node-deps.ts" || file.endsWith("/node-deps.ts")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, `src/execution/${file} must not import node:child_process`).not.toMatch(
        /node:child_process/,
      );
      expect(source, `src/execution/${file} must not call process.kill`).not.toMatch(
        /process\.kill/,
      );
      expect(source, `src/execution/${file} must not call Bun.spawn`).not.toMatch(/Bun\.spawn/);
    }
  });
});

describe("execution layer protocol ownership", () => {
  test("no execution source contains Claude's session-input protocol value", () => {
    const dir = join(import.meta.dirname, "../src/execution");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const scanner = createScanner(true, undefined, readFileSync(join(dir, file), "utf8"));
      const violations: number[] = [];
      let token = scanner.scan();
      while (token !== SyntaxKind.EndOfFile) {
        if (
          (token === SyntaxKind.StringLiteral ||
            token === SyntaxKind.NoSubstitutionTemplateLiteral) &&
          scanner.getTokenValue() === "user"
        ) {
          violations.push(scanner.getTokenStart());
        }
        token = scanner.scan();
      }

      expect(
        violations,
        `src/execution/${file} owns Claude protocol value at offsets ${violations.join(", ")}`,
      ).toEqual([]);
    }
  });
});
