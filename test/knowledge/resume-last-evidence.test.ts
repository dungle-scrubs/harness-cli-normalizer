/**
 * RFC-06 Phase 4: filed native resume-last captures still decode on the
 * pinned descriptors. Each fixture is a tools-off recall run with the exact
 * HCN-rendered argv (see the README in each version directory): the stream
 * must announce an id and carry the planted recall marker, with no hook
 * records (excluded at filing) and no secret-shaped text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";

const read = (dir: string): string =>
  readFileSync(new URL(`../fixtures/${dir}/resume-last.ndjson`, import.meta.url), "utf8");

const decoded = (h: HarnessDescriptor, dir: string, model: string): HarnessEvent[] => {
  const state = freshDecodeState(null, h.name);
  return read(dir)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(h, line, state, model));
};

const messages = (events: HarnessEvent[]): string[] =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
    .map((e) => e.text);

const identities = (events: HarnessEvent[]): string[] =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: "identity" }> => e.kind === "identity")
    .map((e) => e.sessionId);

describe("RFC-06 Phase 4 filed resume-last captures", () => {
  test("claude fork recall announces the fork id and carries the marker", () => {
    // Identity is not asserted through decode here, and that is
    // deliberate: decode announces claude identity only from system/init,
    // which was excluded at filing (account connector names), and a
    // result record's session_id is never an announce record. So decode
    // yields no identity event on this fixture, asserted below. The fork
    // id is read structurally from result.session_id instead, while the
    // recall marker goes through decode like the other harnesses.
    const resultLine = read("claude-2.1.278")
      .trim()
      .split("\n")
      .find((line) => JSON.parse(line).type === "result");
    if (resultLine === undefined) throw new Error("Missing result record in claude fixture");
    const native = JSON.parse(resultLine) as { session_id: string; result: string };
    expect(native.session_id).toBe("561ce3da-4d80-4c7e-adb9-c3226512c9da");
    const events = decoded(claudeCode, "claude-2.1.278", "claude-haiku-4-5-20251001");
    expect(identities(events)).toEqual([]);
    expect(messages(events).join("\n")).toMatch(/HERON-4/);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("codex resume-last resumes the planted thread and recalls", () => {
    const events = decoded(codexCli, "codex-0.155.1", "gpt-5.5");
    expect(identities(events)).toContain("01a0ae03-fd99-72d0-b1cf-1d6e6f1866ad");
    expect(messages(events).join("\n")).toMatch(/JUNIPER-6/);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("pi resume-last resumes the planted session and recalls", () => {
    const events = decoded(piCli, "pi-0.87.0", "zai/glm-5.2");
    expect(identities(events)).toContain("01a0adf4-7a11-74d8-9071-1d3a78312617");
    expect(messages(events).join("\n")).toMatch(/HERON-4/);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("cursor resume-last re-enters the planted session and recalls", () => {
    const events = decoded(cursorCli, "cursor-2026.09.15-d2fe57e", "auto");
    expect(identities(events)).toContain("a2f00bd8-6202-4386-9fa5-1cad56055092");
    expect(messages(events).join("\n")).toMatch(/HERON-4/);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("filed fixtures carry no hook records, connector names, or secret-shaped text", () => {
    const secret =
      /crsr_|sk-[A-Za-z0-9]{8,}|key_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]+\.eyJ|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(API_KEY|TOKEN|SECRET|PASSWORD)=|user\.email/;
    for (const dir of [
      "claude-2.1.278",
      "codex-0.155.1",
      "pi-0.87.0",
      "cursor-2026.09.15-d2fe57e",
    ]) {
      const text = read(dir);
      expect(text).not.toMatch(/hook_started|hook_response/);
      expect(text).not.toMatch(/Gmail|Google Calendar|Google Drive|reviewsion/);
      expect(text).not.toMatch(secret);
      for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
