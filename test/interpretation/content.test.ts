import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contentEventsOf } from "../../src/interpretation/content.js";
import type { HarnessName } from "../../src/knowledge/descriptor.js";

const fixture = (name: string): unknown[] =>
  readFileSync(join(import.meta.dirname, "../fixtures/harnesses", `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

const allContent = (harness: HarnessName, lines: unknown[]) =>
  lines.flatMap((line) => contentEventsOf(harness, line));

const messageText = (harness: HarnessName, lines: unknown[]): string =>
  allContent(harness, lines)
    .filter(
      (e): e is Extract<ReturnType<typeof allContent>[number], { kind: "message" }> =>
        e.kind === "message",
    )
    .map((e) => e.text)
    .join("");

describe("per-harness content decoding (real CLI fixtures)", () => {
  test("codex: agent_message becomes an assistant message; item error becomes an error", () => {
    const lines = fixture("codex");
    const content = allContent("codex", lines);
    expect(messageText("codex", lines)).toContain("alpha");
    expect(content.some((e) => e.kind === "error")).toBe(true); // the skills-budget notice
    expect(content.every((e) => e.kind !== "token")).toBe(true); // codex has no token deltas
  });

  test("pi: text_delta becomes tokens and message_end becomes the assistant message", () => {
    const lines = fixture("pi");
    const content = allContent("pi", lines);
    const tokens = content.filter((e) => e.kind === "token");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((e) => (e.kind === "token" ? e.text : "")).join("")).toContain("alpha");
    expect(messageText("pi", lines)).toContain("alpha");
  });

  test("muse: run_output_delta becomes tokens and run_terminal becomes the message", () => {
    const lines = fixture("muse");
    const content = allContent("muse", lines);
    const tokens = content.filter((e) => e.kind === "token");
    expect(tokens.length).toBeGreaterThan(0);
    expect(messageText("muse", lines)).toContain("alpha");
  });

  test("unrelated records and non-objects yield no content", () => {
    expect(contentEventsOf("codex", { type: "turn.started" })).toEqual([]);
    expect(contentEventsOf("pi", { type: "agent_start" })).toEqual([]);
    expect(contentEventsOf("muse", { record_type: "status" })).toEqual([]);
    expect(contentEventsOf("claude", "not an object")).toEqual([]);
  });
});
