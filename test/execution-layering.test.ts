import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, test } from "vitest";

/**
 * A harness's persistent-session wire vocabulary belongs to its knowledge
 * descriptor and the interpretation encoder/decoder (ADR 0005, RFC-02
 * change 4). Execution dispatches on closed contract kinds and must own
 * none of the protocol literals: claude's `user` record type, and pi
 * rpc's command and response vocabulary including hcn's own marker ids.
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

/** Literals that belong to a harness's session protocol, not to execution. */
const PROTOCOL_LITERALS = new Set([
  "user",
  "response",
  "get_state",
  "prompt",
  "agent_settled",
  "result",
  "hcn-identity",
  "hcn-send",
]);

describe("execution layer protocol ownership", () => {
  test("no execution source contains a session-protocol literal", () => {
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
          PROTOCOL_LITERALS.has(scanner.getTokenValue())
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
