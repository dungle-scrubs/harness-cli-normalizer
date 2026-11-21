import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { contentEventsWithState, freshReaderState } from "../../src/interpretation/content.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const root = join(import.meta.dirname, "../fixtures/cursor-sdk-1.4.2");
const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("the SDK descriptor anchor has passing native capability tripwires", () => {
  expect(cursorCli.verifiedAgainst).toBe("1.4.2");
  expect(cursorCli.versionSource).toEqual({ kind: "npm", package: "@cursor/sdk" });
  const seven = Object.values(json("seven.snapshot.json").results.cursor);
  expect(seven).toHaveLength(7);
  for (const scenario of seven) expect(scenario).toMatchObject({ status: "pass" });
  const questions = json("questions.snapshot.json");
  expect(questions.results.cursor.status).toBe("pass");
  expect(questions.observations.cursor).toEqual(cursorCli.escalation.observedOn);
  expect(questions.observations.cursor.version).toBe(cursorCli.verifiedAgainst);
  expect(
    json("models.json").models.find((model: { id: string }) => model.id === "grok-4.7"),
  ).toBeDefined();
});

test("the captured SDK shell call retains its invocation and result exactly once", () => {
  let state = freshReaderState("cursor");
  const events = readFileSync(join(root, "seven/03.ndjson"), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      const output = contentEventsWithState("cursor", JSON.parse(line), state);
      state = output.state;
      return output.events;
    });
  expect(events.filter((event) => event.kind === "tool")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "tool-result")).toHaveLength(1);
  expect(events.some((event) => event.kind === "message" && event.text.includes("seventest"))).toBe(
    true,
  );
});

const records = (name: string): Record<string, unknown>[] =>
  readFileSync(join(root, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const inputTokensOf = (record: Record<string, unknown>): number | undefined => {
  const event = record.event as { type?: string; usage?: { inputTokens?: number } } | undefined;
  return event?.type === "usage" ? event.usage?.inputTokens : undefined;
};

test("the SDK compaction ladder drops input tokens back after each peak and finishes cleanly", () => {
  expect(cursorCli.nativeContextManagement).toEqual({
    kind: "auto-compaction",
    modes: ["headless-turn"],
  });
  const ladder = records("compaction-ladder.ndjson");
  const inputs = ladder.flatMap((record) => inputTokensOf(record) ?? []);
  expect(inputs).toEqual(json("compaction.provenance.json").facts.inputTokenSawtooth);
  expect(inputs).toHaveLength(15);
  // A replacement shows as a fall from a peak to a context a third its size or less;
  // without one, each file read only grows the input.
  const drops = inputs.flatMap((value, i) => {
    const previous = inputs[i - 1];
    return previous !== undefined && previous > 700_000 && value < previous / 2 ? [i] : [];
  });
  expect(drops).toEqual([4, 7, 10, 13]);
  expect(Math.max(...inputs)).toBeGreaterThan(1_000_000);
  const turnEnds = ladder.filter((record) => record.hcn === "turn-end");
  expect(turnEnds).toHaveLength(15);
  for (const end of turnEnds) expect(end).toMatchObject({ status: "finished" });
});

test("a separate SDK worker resumes the compacted agent and recalls the marker exactly", () => {
  const ladder = records("compaction-ladder.ndjson");
  const recall = records("compaction-later-recall.ndjson");
  const agentOf = (rs: Record<string, unknown>[]) =>
    rs.find((record) => record.hcn === "opened")?.agentId;
  expect(agentOf(recall)).toBe(agentOf(ladder));
  let state = freshReaderState("cursor");
  const events = recall.flatMap((record) => {
    const output = contentEventsWithState("cursor", record, state);
    state = output.state;
    return output.events;
  });
  const messages = events.flatMap((event) => (event.kind === "message" ? [event.text] : []));
  expect(messages).toEqual(["LANTERN-1121"]);
  expect(recall.at(-1)).toEqual({ hcn: "turn-end", status: "finished" });
});
