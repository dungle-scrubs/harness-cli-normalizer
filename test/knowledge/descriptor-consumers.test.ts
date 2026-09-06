/**
 * RFC-02 change 7 (Testing Strategy item 4): the descriptor's own rule -
 * "adding a key without a consumer arm would be dead data that can only
 * drift" (descriptor.ts header) - enforced. Every field path on a
 * descriptor, to depth two and excluding array elements, must be read by
 * at least one source file outside the knowledge layer. A field only the
 * descriptors and their type mention is dead data.
 *
 * The lucid-era fields (contextHook, resumeLast, presence) pass through
 * their interpretation readers; whether those readers stay is RFC-02 open
 * questions 2 and 3, not this test's decision.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const SRC = join(import.meta.dirname, "../../src");

/** Every .ts source outside src/knowledge, concatenated. */
const readersText = (): string => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "knowledge") walk(full);
        continue;
      }
      if (entry.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(SRC);
  return out.join("\n");
};

/** Dotted field paths to depth two; arrays and null leaves contribute
 * their own name only. */
const fieldPaths = (value: unknown, prefix: string, depth: number, into: Set<string>): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    into.add(path);
    if (depth < 2) fieldPaths(inner, path, depth + 1, into);
  }
};

/** Fields whose consumer lands in a later RFC-02 ticket. Each entry names
 * the ticket that removes it; an entry that outlives its ticket is drift. */
const PENDING: Readonly<Record<string, string>> = {};

describe("every descriptor field has a consumer outside the knowledge layer", () => {
  const paths = new Set<string>();
  for (const h of [claudeCode, codexCli, piCli, museCode]) fieldPaths(h, "", 1, paths);
  // turnOptions keys are the closed TurnOptionKey vocabulary, read by
  // name through the tuple, not as property accesses.
  const candidates = [...paths].filter(
    (p) => !p.startsWith("turnOptions.") && PENDING[p] === undefined,
  );
  const text = readersText();

  test.each(candidates)("%s is read somewhere outside src/knowledge", (path) => {
    const leaf = path.split(".").at(-1) as string;
    const access = new RegExp(`(?:\\.|\\["|\\b)${leaf}\\b`);
    expect(access.test(text), `descriptor field ${path} has no reader outside knowledge`).toBe(
      true,
    );
  });
});
