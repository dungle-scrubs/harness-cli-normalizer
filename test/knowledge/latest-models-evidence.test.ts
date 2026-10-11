import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

const fixture = (path: string): string =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");

test("Haiku 5.5 native output attests the selected model and decodes the reply", () => {
  const lines = fixture("claude-2.1.296/haiku-5-5.ndjson").trim().split("\n");
  const native = lines.map((line) => JSON.parse(line));
  const assistants = native.filter((record) => record.type === "assistant");
  expect(assistants.length).toBeGreaterThan(0);
  for (const record of assistants) {
    expect(record.message.model).toBe("claude-haiku-5-5");
  }
  expect(native.at(-1)).toMatchObject({
    type: "result",
    is_error: false,
    result: "alpha",
    modelUsage: { "claude-haiku-5-5": { canonicalModel: "claude-haiku-5-5" } },
  });
  expect(claudeCode.vocabulary.models).toContain("claude-haiku-5-5");
  expect(claudeCode.vocabulary.aliases.haiku).toBe("claude-haiku-5-5");
  const seven = JSON.parse(fixture("claude-2.1.296/haiku-seven.snapshot.json"));
  const cells = Object.values(seven.results.claude);
  expect(cells).toHaveLength(7);
  for (const cell of cells) expect(cell).toMatchObject({ status: "pass" });
  const questions = JSON.parse(fixture("claude-2.1.296/haiku-questions.snapshot.json"));
  expect(questions.results.claude).toMatchObject({
    status: "pass",
    observedOn: { model: "claude-haiku-5-5", version: "2.1.296", date: "2026-10-11" },
  });
  const state = freshDecodeState(null, "claude");
  const events = lines.flatMap((line) => decodeLine(claudeCode, line, state, "claude-haiku-5-5"));
  expect(events).toContainEqual({ kind: "message", role: "assistant", text: "alpha" });
  expect(events.some((event) => event.kind === "failure" || event.kind === "error")).toBe(false);
});

test("Popeye 0.2.0 uses its published npm source and passing live compatibility receipt", () => {
  expect(fixture("popeye-0.2.0/version.txt").trim()).toBe(popeyeCli.verifiedAgainst);
  expect(popeyeCli.verifiedAgainst).toBe("0.2.0");
  expect(popeyeCli.versionSource).toEqual({ kind: "npm", package: "@dungle-scrubs/popeye" });
  const receipt = JSON.parse(fixture("popeye-0.2.0/seven.snapshot.json"));
  const cells = Object.values(receipt.results.popeye) as Array<{ status: string }>;
  expect(cells.filter((cell) => cell.status === "pass")).toHaveLength(6);
  expect(cells.filter((cell) => cell.status === "skip")).toHaveLength(1);
  expect(cells.filter((cell) => cell.status === "fail")).toHaveLength(0);
  const state = freshDecodeState(null, "popeye");
  const lines = fixture("popeye-0.2.0/fresh.ndjson").trim().split("\n");
  expect(JSON.parse(lines.at(-1) ?? "null")).toMatchObject({
    kind: "done",
    exitCode: 0,
    cause: "clean",
  });
  const events = lines.flatMap((line) =>
    decodeLine(popeyeCli, line, state, "qwen3.6-35b-a3b-ud-mlx"),
  );
  expect(events.find((event) => event.kind === "message")).toMatchObject({
    role: "assistant",
    text: expect.stringContaining("alpha"),
  });
  expect(events.some((event) => event.kind === "failure" || event.kind === "error")).toBe(false);
  expect(popeyeCli.escalation.supported).toBe(false);
});
