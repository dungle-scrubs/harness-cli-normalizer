import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/antigravity-1.2.16/${file}`, import.meta.url), "utf8");

const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null, antigravityCli.name);
  return read(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(antigravityCli, line, state, "gemini-3.8-flash-medium"));
};

test("antigravity's verification anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  expect(Object.values(seven.results.antigravity)).toHaveLength(7);
  for (const cell of Object.values(seven.results.antigravity))
    expect(cell).toMatchObject({ status: "pass" });
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.antigravity.status).toBe("pass");
  expect(questions.observations.antigravity).toEqual(antigravityCli.escalation.observedOn);
  expect(questions.observations.antigravity.version).toBe(antigravityCli.verifiedAgainst);
});

test("a native antigravity turn still decodes identity, tokens and the final message", () => {
  const events = decoded("seven-01.ndjson");
  expect(events.some((event) => event.kind === "identity")).toBe(true);
  expect(events.some((event) => event.kind === "token")).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ kind: "message", text: "alpha\n" }));
});

test("native resumed recall decodes the original session and marker", () => {
  const events = decoded("seven-06.ndjson");
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "identity",
      sessionId: "82070cad-6388-4a35-baef-73b04ec7a56e",
    }),
  );
  expect(
    events
      .filter((event) => event.kind === "token")
      .map((event) => event.text)
      .join(""),
  ).toBe("marlin\n");
  expect(events.filter((event) => event.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "marlin\n" },
  ]);
  expect(events.filter((event) => event.kind === "error")).toEqual([]);
});

test("native automatic checkpoints retain the summary and saved HCN later-process marker recall", () => {
  const stream = decoded("compaction-stream.ndjson");
  expect(stream).toContainEqual(
    expect.objectContaining({ kind: "compaction", state: "compacted" }),
  );
  const [checkpoint] = JSON.parse(read("checkpoint-store.snapshot.json"));
  expect(checkpoint.type).toBe("CHECKPOINT");
  expect(checkpoint.content).toContain("LANTERN-903");
  const recall = read("later-recall.ndjson")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(recall).toContainEqual({ kind: "message", role: "assistant", text: "LANTERN-903\n" });
  expect(recall.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
  const native = decoded("later-recall.native.ndjson");
  expect(native).toContainEqual(
    expect.objectContaining({
      kind: "identity",
      sessionId: "e0910c0c-7cca-4652-8022-a2b8f09459b7",
    }),
  );
  expect(native.filter((event) => event.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "LANTERN-903\n" },
  ]);
  expect(native.filter((event) => event.kind === "error")).toEqual([]);
});

test("native capacity and print-mode context failures are not successful turns", () => {
  const capacity = decoded("native-capacity-failure.ndjson");
  expect(capacity).toContainEqual({
    kind: "error",
    terminal: true,
    message:
      "antigravity turn ended with status ERROR: Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server)",
  });
  expect(capacity.filter((event) => event.kind === "message")).toEqual([]);
  const context = read("context-native.ndjson")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(context.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  expect(context.at(-1).failure.message).toContain("/context is not available in print mode");
});

test("the native antigravity decision response contains a valid escalation block", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});

const identityOf = (file: string): Extract<HarnessEvent, { kind: "identity" }> => {
  const identity = decoded(file).find(
    (event): event is Extract<HarnessEvent, { kind: "identity" }> => event.kind === "identity",
  );
  if (identity === undefined) throw new Error(`no identity in ${file}`);
  return identity;
};
const messageText = (file: string): string | null => {
  const message = decoded(file).find(
    (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
  );
  return message?.text ?? null;
};
const toolNames = (file: string): string[] =>
  decoded(file)
    .filter((event): event is Extract<HarnessEvent, { kind: "tool" }> => event.kind === "tool")
    .map((event) => event.name);

test("current antigravity seven captures decode to the named turn outcomes", () => {
  const single = decoded("seven-01.ndjson");
  expect(identityOf("seven-01.ndjson").sessionId).toBe("53cc8f7c-c814-478f-9627-20cd4533ec77");
  expect(
    single
      .filter((event): event is Extract<HarnessEvent, { kind: "token" }> => event.kind === "token")
      .map((event) => event.text)
      .join(""),
  ).toBe("alpha\n");
  expect(single).toContainEqual(
    expect.objectContaining({ kind: "message", role: "assistant", text: "alpha\n" }),
  );

  expect(toolNames("seven-02.ndjson")).toEqual(["run_command"]);
  expect(messageText("seven-02.ndjson")).toBe("four, five, six\n");

  expect(toolNames("seven-03.ndjson")).toEqual(["run_command"]);
  expect(messageText("seven-03.ndjson")).toContain("seventest");

  const sessionCont = decoded("seven-04.ndjson");
  expect(sessionCont.filter((event) => event.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "OK\n" },
    { kind: "message", role: "assistant", text: "kestrel\n" },
  ]);
  expect(sessionCont.filter((event) => event.kind === "error")).toEqual([]);

  expect(identityOf("seven-05.ndjson").sessionId).toBe(identityOf("seven-06.ndjson").sessionId);
  expect(messageText("seven-05.ndjson")).toBe("OK\n");
  expect(messageText("seven-06.ndjson")).toBe("marlin\n");

  const killedSession = identityOf("seven-07.ndjson").sessionId;
  expect(identityOf("seven-09.ndjson").sessionId).toBe(killedSession);
  const killed = decoded("seven-08.ndjson");
  expect(killed.some((event) => event.kind === "message")).toBe(false);
  expect(killed.some((event) => event.kind === "error")).toBe(false);
  expect(messageText("seven-09.ndjson")).toBe("otter\n");
});

test("the verified antigravity public model roster matches the descriptor vocabulary", () => {
  const lines = read("models.txt")
    .split("\n")
    .map((line) => line.split("\t"));
  const nativeSlugs = lines.flatMap((cells) =>
    cells.length === 2 && cells[0] !== undefined ? [cells[0]] : [],
  );
  const labels = Object.fromEntries(
    lines.filter((cells) => cells.length === 2).map((cells) => [cells[0], cells[1]]),
  );
  expect(nativeSlugs).toHaveLength(14);
  for (const slug of nativeSlugs) {
    expect(labels[slug]).toBeTruthy();
  }
  expect(new Set(nativeSlugs)).toEqual(new Set(antigravityCli.vocabulary.models));
  expect(antigravityCli.vocabulary.extensible).toBe(true);
});

test("the antigravity version file matches the descriptor's verified version", () => {
  const version = read("version.txt").trim();
  expect(version).toBe(antigravityCli.verifiedAgainst);
  expect(version).toBe("1.2.16");
});
