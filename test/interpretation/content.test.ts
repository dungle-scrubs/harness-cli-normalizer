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

describe("content-decode review regressions", () => {
  test("claude non-init system lines surface as droppable progress", () => {
    expect(contentEventsOf("claude", { type: "system", subtype: "hook_started" })).toEqual([
      { kind: "progress", label: "hook_started" },
    ]);
    // The init line is identity (handled upstream), not progress.
    expect(contentEventsOf("claude", { type: "system", subtype: "init" })).toEqual([]);
  });

  test("pi and muse are token-granular under their structured flags", async () => {
    const { streamingGranularityOf, buildLaunchArgv } = await import(
      "../../src/interpretation/argv.js"
    );
    const { piCli } = await import("../../src/knowledge/pi.js");
    const { museCode } = await import("../../src/knowledge/muse.js");
    expect(streamingGranularityOf(piCli, buildLaunchArgv(piCli, { prompt: "hi" }))).toBe("token");
    expect(streamingGranularityOf(museCode, buildLaunchArgv(museCode, { prompt: "hi" }))).toBe(
      "token",
    );
  });
});

describe("per-harness tool-call decoding (real CLI fixtures)", () => {
  test("codex command_execution becomes a shell tool event, emitted once", () => {
    const content = allContent("codex", fixture("codex-tool"));
    const tools = content.filter((e) => e.kind === "tool");
    expect(tools.length).toBe(1); // once on item.started, not double on completed
    expect(tools[0]).toMatchObject({ kind: "tool", name: "shell" });
    if (tools[0]?.kind === "tool") expect(String(tools[0].input)).toContain("echo");
  });

  test("pi tool_execution_start becomes a named tool event with args", () => {
    const content = allContent("pi", fixture("pi-tool"));
    const tools = content.filter((e) => e.kind === "tool");
    expect(tools.length).toBe(1);
    expect(tools[0]).toMatchObject({ kind: "tool", name: "bash" });
  });

  test("muse tool_result becomes a named tool event with the command", () => {
    const content = allContent("muse", fixture("muse-tool"));
    const tools = content.filter((e) => e.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0]).toMatchObject({ kind: "tool", name: "bash" });
    if (tools[0]?.kind === "tool") expect(String(tools[0].input)).toContain("echo");
  });
});

describe("terminal-error detection (silent provider/auth failures)", () => {
  test("pi stopReason=error surfaces as an error event (real minimax auth fixture)", () => {
    const content = allContent("pi", fixture("pi-autherror"));
    const errors = content.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({
      kind: "error",
      message: expect.stringContaining("stopReason"),
    });
    // No spurious message from the empty assistant content.
    expect(content.some((e) => e.kind === "message" && e.text !== "")).toBe(false);
  });
});
