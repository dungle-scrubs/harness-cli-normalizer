import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { contentEventsWithState, freshReaderState } from "../../src/interpretation/content.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const root = join(import.meta.dirname, "../fixtures/cursor-sdk-1.0.38");
const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("the SDK descriptor anchor has passing native capability tripwires", () => {
  expect(cursorCli.verifiedAgainst).toBe("1.0.38");
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
