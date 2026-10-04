import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/pi-1.0.0/${file}`, import.meta.url), "utf8");
interface NativeRecord {
  readonly type?: string;
  readonly kind?: string;
  readonly cause?: string;
  readonly event?: NativeRecord;
  readonly entry?: {
    readonly customType?: string;
    readonly data: { readonly active?: readonly string[] };
  };
}
const records = (file: string): NativeRecord[] =>
  read(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null);
  return read(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(piCli, line, state, "openai-codex/gpt-6.1-sol"));
};

test("Pi 1.0 has seven passing capability probes and a version-attested question probe", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  expect(Object.values(seven.results.pi)).toHaveLength(7);
  for (const cell of Object.values(seven.results.pi)) {
    expect(cell).toMatchObject({ status: "pass" });
  }
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.pi.status).toBe("pass");
  expect(questions.observations.pi).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    version: "1.0.0",
    date: "2026-10-03",
  });
});

test("Pi 1.0 native deltas reconstruct the final message without duplicate tokens", () => {
  const events = decoded("fresh.ndjson");
  expect(events.some((event) => event.kind === "identity")).toBe(true);
  const tokens = events
    .filter((event): event is Extract<HarnessEvent, { kind: "token" }> => event.kind === "token")
    .map((event) => event.text)
    .join("");
  const messages = events.filter(
    (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
  );
  expect(tokens).toBe("alpha");
  expect(messages.map((event) => event.text)).toEqual(["alpha"]);
});

test("Pi 1.0 question evidence parses as escalation rather than native failure", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});

test("historical Pi provider-only capture records a native failure with exit 1", () => {
  const events = records("provider-only.hcn.ndjson");
  expect(events).toContainEqual(expect.objectContaining({ kind: "failure", class: "native" }));
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "crash",
    failure: { class: "native", nativeExitCode: 1 },
  });
});

test("explicit native extension grants remain strict after Pi runtime registration", () => {
  const surface = records("strict-tools.ndjson").find(
    (record) =>
      record.type === "entry_appended" && record.entry?.customType === "validation-surface",
  );
  expect(surface?.entry?.data.active).toEqual(["read"]);
  expect(surface?.entry?.data).toMatchObject({ instruction: false, skillA: false, skillB: false });
});

test("Pi resumes a synthetic MCP tool and preserves its normalized tool event", () => {
  const native = records("mcp-resume.ndjson");
  expect(native).toContainEqual(
    expect.objectContaining({ type: "tool_execution_start", toolName: "mcp__quartz__quartz" }),
  );
  expect(decoded("mcp-resume.ndjson")).toContainEqual(
    expect.objectContaining({ kind: "tool", name: "mcp__quartz__quartz" }),
  );
});

test("Pi RPC acknowledges native steering and settles two turns", () => {
  const native = records("rpc-live.ndjson");
  expect(native).toContainEqual(
    expect.objectContaining({
      id: "hcn-send:steer",
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "queued" },
    }),
  );
  expect(native.filter((record) => record.type === "agent_settled")).toHaveLength(2);
  const messages = decoded("rpc-live.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text);
  expect(messages).toContain("STEER_QUARTZ_731");
  expect(messages).toContain("SECOND_QUARTZ_731");
});

test("a failed Pi turn remains a task failure and the same process recovers on the primary model", async () => {
  const native = records("recovery.native.ndjson");
  expect(native.filter((row) => row.type === "agent_settled")).toHaveLength(2);
  expect(native).toContainEqual(
    expect.objectContaining({
      type: "response",
      command: "set_model",
      success: false,
      error: "Model not found: openai-codex/undefined",
    }),
  );
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const session = openSession(
    piCli,
    { sessionId: "f196e289-a768-45cc-aa06-971804ce0a38", questions: "none" },
    {
      spawn: spawner.spawn,
      clock: new FakeClock(),
      signal: fakeSignal().signal,
    },
  );
  const turns = session.turns[Symbol.asyncIterator]();
  const lines = read("recovery.native.ndjson").trim().split("\n");
  let cursor = 0;
  const replayThroughSettled = () => {
    while (cursor < lines.length) {
      const line = lines[cursor++];
      if (line === undefined) break;
      proc.emitLine(line);
      if (JSON.parse(line).type === "agent_settled") break;
    }
  };
  const failedSend = session.send({ id: "recovery-failed-turn", text: "fail deterministically" });
  const failedTurn = (await turns.next()).value as SessionTurn;
  expect(failedTurn.inputId).toBe("recovery-failed-turn");
  replayThroughSettled();
  const failed: HarnessEvent[] = [];
  for await (const event of failedTurn) failed.push(event);
  expect(await failedSend.settled).toEqual({ disposition: "started" });
  expect(failed.filter((event) => event.kind === "failure")).toEqual([
    expect.objectContaining({ class: "task", retryable: false }),
  ]);
  expect(failed.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  const recoveredSend = session.send({ id: "recovery-success-turn", text: "recover" });
  const recoveredTurn = (await turns.next()).value as SessionTurn;
  expect(recoveredTurn.inputId).toBe("recovery-success-turn");
  replayThroughSettled();
  const recovered: HarnessEvent[] = [];
  for await (const event of recoveredTurn) recovered.push(event);
  expect(await recoveredSend.settled).toEqual({ disposition: "started" });
  expect(recovered.filter((event) => event.kind === "failure")).toEqual([]);
  expect(recovered.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(recovered).toContainEqual({
    kind: "message",
    role: "assistant",
    text: "HCN_RECOVERY_OK_03_OTTER",
  });
  for (const line of lines.slice(cursor)) proc.emitLine(line);
  expect(spawner.calls).toHaveLength(1);
  await session.close();
  expect((await turns.next()).done).toBe(true);
});

for (const [file, count] of [
  ["session-skills-fresh.ndjson", 2],
  ["session-skills-resumed.ndjson", 1],
] as const) {
  test(`Pi session skills allowlist holds across ${file}`, () => {
    const probes = records(file).filter(
      (row) => row.type === "entry_appended" && row.entry?.customType === "validation-surface",
    );
    expect(probes).toHaveLength(count);
    for (const row of probes) {
      expect(row.entry?.data).toMatchObject({ skillA: true, skillB: false });
    }
  });
}
