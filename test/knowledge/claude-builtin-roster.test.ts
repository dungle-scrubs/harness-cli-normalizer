import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { asRecord } from "../../src/interpretation/shape.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const FIXTURES = join(import.meta.dirname, "../fixtures");
const CAPTURE = /\.(ndjson|jsonl)$/;

interface InitToolList {
  readonly file: string;
  readonly version: string;
  readonly tools: readonly string[];
}

/** The first init event's version and tool list in one capture. */
const readInitToolList = (full: string): { version: string; tools: string[] } | null => {
  for (const line of readFileSync(full, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) continue;
    if (record.type !== "system" || record.subtype !== "init") continue;
    if (typeof record.claude_code_version !== "string" || !Array.isArray(record.tools)) continue;
    // One init event per file is the capture convention; a001-raw carries
    // three identical ones, so the first settles it.
    return {
      version: record.claude_code_version,
      tools: record.tools.filter((t): t is string => typeof t === "string"),
    };
  }
  return null;
};

/** Every claude init event's tool list across all committed fixtures. */
const initToolLists = (): InitToolList[] => {
  const found: InitToolList[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
        continue;
      }
      if (!CAPTURE.test(entry.name)) continue;
      if (!relative.includes("claude") && relative !== "a001-raw.ndjson") continue;
      const list = readInitToolList(join(dir, entry.name));
      if (list !== null) found.push({ file: relative, ...list });
    }
  };
  walk(FIXTURES, "");
  return found;
};

/** Names that are configuration or redaction, not harness facts. */
const isDynamicName = (name: string): boolean =>
  name.startsWith("mcp__") || name.startsWith("<redacted:");

describe("claude builtin table classifies the fixtures' init tool lists", () => {
  const lists = initToolLists();

  test("fixtures with claude init events were found", () => {
    expect(lists.length).toBeGreaterThan(0);
    // A resumed capture can legitimately carry an empty tools array
    // (claude-2.1.296/compaction.ndjson); the classification sweep below
    // only ever needs the non-empty lists.
    expect(lists.some((l) => l.tools.length > 0)).toBe(true);
  });

  test("every non-dynamic name a fixture init lists is classified", () => {
    const table = new Set(claudeCode.tools.builtins.map((t) => t.name));
    const unclassified: string[] = [];
    for (const list of lists) {
      for (const name of list.tools) {
        if (isDynamicName(name)) continue;
        if (!table.has(name)) unclassified.push(`${list.file} (${list.version}): ${name}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  test("the newest fixture (verifiedAgainst) is fully classified", () => {
    const table = new Set(claudeCode.tools.builtins.map((t) => t.name));
    const newest = lists.filter((l) => l.version === claudeCode.verifiedAgainst);
    expect(newest.length).toBeGreaterThan(0);
    const names = new Set(newest.flatMap((l) => l.tools.filter((name) => !isDynamicName(name))));
    for (const name of names) expect(table.has(name)).toBe(true);
    // The read preset's closed inventory must itself be classified
    // builtins: the preset names them in --tools.
    const readValue = claudeCode.turnOptions.access;
    const read =
      readValue?.kind === "access" &&
      readValue.renders.read !== null &&
      typeof readValue.renders.read === "object"
        ? readValue.renders.read.value
        : undefined;
    expect(read).toBe("Read,Grep,Glob,WebFetch,WebSearch");
    for (const name of (read ?? "").split(",")) expect(table.has(name)).toBe(true);
  });

  test("no builtin is a dynamic MCP name", () => {
    for (const builtin of claudeCode.tools.builtins) {
      expect(builtin.name.startsWith("mcp__")).toBe(false);
      expect(builtin.name.startsWith("<redacted:")).toBe(false);
    }
  });
});
