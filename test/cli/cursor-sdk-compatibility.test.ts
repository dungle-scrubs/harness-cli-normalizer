/**
 * Legacy-vs-SDK parity through the built CLI (issue #440 round 2). Each
 * existing raw Cursor CLI fixture is normalized twice, independently:
 *
 * - the legacy oracle is the PRODUCTION reader (contentEventsWithState,
 *   which already folds usageEventsOf per record) over the raw fixture
 *   lines - never a new snapshot of expected output;
 * - the SDK side is the actual built CLI (dist/cli.js) driven end to end
 *   through the scripted fake SDK, whose callback/stream script is derived
 *   from the raw fixture TEXT by the timestamp/model_call_id discriminator
 *   and the tool/usage fields - never from the oracle's output.
 *
 * The two backends keep their own native tool names (readToolCall in the
 * legacy protocol, read in the SDK protocol); the comparison asserts each
 * side's literal native name plus the lossless shared fields (ids, args,
 * result payloads, counters), not a renaming of one onto the other. The
 * CLI's system/task_notification bookkeeping record has no native SDK
 * equivalent (SDK 1.0.38 raises task records, not notifications; its
 * SDKTaskMessage comes from the summary) so the #438 case compares the
 * token/message vectors and explains the excluded bookkeeping rather than
 * fabricating a native event.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { contentEventsWithState, freshReaderState } from "../../src/interpretation/content.js";
import { ndjsonOf, runCliWithFakeSdk, sendOf } from "./cursor-sdk-fixture.js";
import { deriveSdkScript } from "./cursor-sdk-script.js";

const agentId = "agent-da354f73-06a8-4bb8-8c6f-e88da9f95eb1";

type Line = Record<string, unknown>;
type ScriptEntry = Record<string, unknown>;

const fixtureLines = (name: string): Line[] =>
  readFileSync(new URL(`../fixtures/cursor-2026.09.10-fd3934a/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);

/** The legacy oracle: the production reader over the raw lines. */
const legacyEventsOf = (lines: readonly Line[]): Line[] => {
  let state = freshReaderState("cursor");
  const events: Line[] = [];
  for (const record of lines) {
    const step = contentEventsWithState("cursor", record, state);
    events.push(...(step.events as Line[]));
    state = step.state;
  }
  return events;
};

const CONTENT_KINDS = new Set(["token", "message", "tool", "tool-result", "usage"]);
const contentOf = (events: readonly Line[]): Line[] =>
  events.filter((event) => CONTENT_KINDS.has(event.kind as string));

/** Run the built CLI over a derived script and return its full event
 * stream (identity through done); parity callers filter to content kinds. */
const sdkEventsOf = async (
  scriptEvents: readonly ScriptEntry[],
  runtime: "node" | "bun",
): Promise<Line[]> => {
  const run = await runCliWithFakeSdk(
    {
      script: { agentId, sends: [sendOf({ status: "finished", events: [...scriptEvents] })] },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    },
    runtime,
  );
  try {
    expect(run.status, run.stderr).toBe(0);
    return ndjsonOf(run.stdout) as Line[];
  } finally {
    run.cleanup();
  }
};

/** Compare the two backends' normalization of one fixture, honestly: same
 * content kinds in the same order, same token/message text, same tool
 * invocations (ids, args) and results (lossless shared fields) with each
 * protocol's literal native tool names, and every legacy-reported usage
 * counter equal on the SDK side (native SDK enrichment like totalTokens is
 * additive, not a mismatch). */
const expectParity = (
  fixture: string,
  legacy: readonly Line[],
  sdkEvents: readonly Line[],
): void => {
  const legacyContent = contentOf(legacy);
  const sdk = contentOf(sdkEvents);
  expect(
    legacyContent.map((event) => event.kind),
    fixture,
  ).toEqual(sdk.map((event) => event.kind));
  const legacyTokens = legacyContent.filter((event) => event.kind === "token");
  const sdkTokens = sdk.filter((event) => event.kind === "token");
  expect(sdkTokens.map((event) => event.text)).toEqual(legacyTokens.map((event) => event.text));
  const legacyMessages = legacyContent.filter((event) => event.kind === "message");
  const sdkMessages = sdk.filter((event) => event.kind === "message");
  expect(sdkMessages.map((event) => event.text)).toEqual(legacyMessages.map((event) => event.text));
  const legacyTools = legacyContent.filter((event) => event.kind === "tool");
  const sdkTools = sdk.filter((event) => event.kind === "tool");
  expect(sdkTools).toHaveLength(legacyTools.length);
  for (let index = 0; index < legacyTools.length; index += 1) {
    const legacyTool = legacyTools[index] as { name: string; callId: string; input?: unknown };
    const sdkTool = sdkTools[index] as { name: string; callId: string; input?: unknown };
    // Literal native names per protocol, never a remap to force equality.
    expect(legacyTool.name).toBe(
      sdkTool.name === "read" ? "readToolCall" : `${sdkTool.name}ToolCall`,
    );
    expect(sdkTool.callId).toBe(legacyTool.callId);
    expect(sdkTool.input).toEqual(legacyTool.input);
  }
  const legacyResults = legacyContent.filter((event) => event.kind === "tool-result");
  const sdkResults = sdk.filter((event) => event.kind === "tool-result");
  expect(sdkResults).toHaveLength(legacyResults.length);
  for (let index = 0; index < legacyResults.length; index += 1) {
    const legacyResult = legacyResults[index] as {
      name: string;
      callId: string;
      result?: Record<string, unknown>;
      isError?: boolean;
    };
    const sdkResult = sdkResults[index] as {
      name: string;
      callId: string;
      result?: { status?: string; value?: Record<string, unknown> };
      isError?: boolean;
    };
    expect(sdkResult.callId).toBe(legacyResult.callId);
    expect(sdkResult.isError ?? false).toBe(legacyResult.isError ?? false);
    // The legacy result carries the raw success payload; the SDK wraps it
    // in {status:'success', value:{...}} - compare the shared fields
    // losslessly instead of pretending byte-identical provider payloads.
    const legacySuccess = legacyResult.result?.success as Record<string, unknown> | undefined;
    expect(sdkResult.result?.status).toBe(legacySuccess === undefined ? undefined : "success");
    for (const [field, value] of Object.entries(sdkResult.result?.value ?? {})) {
      expect(value).toEqual(legacySuccess?.[field]);
    }
  }
  const legacyUsage = legacyContent.filter((event) => event.kind === "usage");
  const sdkUsage = sdk.filter((event) => event.kind === "usage");
  expect(sdkUsage).toHaveLength(legacyUsage.length);
  for (let index = 0; index < legacyUsage.length; index += 1) {
    for (const [field, value] of Object.entries(legacyUsage[index] ?? {})) {
      if (field === "kind" || field === "scope" || field === "inputIncludesCache") continue;
      expect(sdkUsage[index]?.[field]).toBe(value);
    }
  }
};

describe("selected legacy fixture compatibility through the built SDK CLI", () => {
  // This adapter checks shared content fields, not every native CLI record.
  // probe-13/15/20/51/52 and other dated fixture sets are not replayed here.
  // In particular, it does not map probe-15's webSearch arguments or compare
  // probe-20's explicit CLI rejection with the SDK's generic error wrapper.
  // The historical reader has full-corpus tests; SDK shell error wrappers,
  // sparse errors and native Task steps have separate checks. Do not expand
  // this adapter's coverage claim without implementing those native shapes.
  const fixtures = ["probe-11.ndjson", "probe-11b.ndjson", "probe-43.ndjson"] as const;

  for (const fixture of fixtures) {
    test(`${fixture}: the built CLI normalizes the derived SDK script to the production reader's events (node)`, async () => {
      const lines = fixtureLines(fixture);
      const legacy = legacyEventsOf(lines);
      const sdk = await sdkEventsOf(deriveSdkScript(lines), "node");
      expectParity(fixture, legacy, sdk);
    });
  }

  for (const fixture of ["probe-11.ndjson", "probe-43.ndjson"] as const) {
    test(`${fixture}: the same parity under the Bun runtime`, async () => {
      const lines = fixtureLines(fixture);
      const legacy = legacyEventsOf(lines);
      const sdk = await sdkEventsOf(deriveSdkScript(lines), "bun");
      expectParity(`${fixture} (bun)`, legacy, sdk);
    });
  }
});

describe("#438 message boundaries on both backends", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  const assistant = (text: string, extra?: Record<string, unknown>): Line => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: sid,
    ...extra,
  });
  const token = (text: string) => assistant(text, { timestamp_ms: 1 });
  const notification: Line = { type: "system", subtype: "task_notification", session_id: sid };

  // The #438 capture shape: tokens spelling a JSON verdict, the CLI's
  // bookkeeping notification, tokens spelling one sentence, then one flush
  // whose text was exactly the two joined.
  const legacyVector = [
    token('{"a":'),
    token("1}"),
    notification,
    token("Server stopped."),
    assistant('{"a":1}Server stopped.'),
  ];

  test("the built CLI fed the two complete SDK steps keeps both messages separate with token text preserved", async () => {
    const legacy = legacyEventsOf(legacyVector);
    // The CLI's system/task_notification is its own bookkeeping: the SDK
    // has no notification event (its SDKTaskMessage comes from the run
    // summary, not this record), so nothing is fabricated for it. The SDK
    // script carries the two REAL logical message boundaries - the two
    // complete onStep messages - plus their token deltas.
    const script: ScriptEntry[] = [
      { delta: { type: "text-delta", text: '{"a":' } },
      { delta: { type: "text-delta", text: "1}" } },
      { step: { type: "assistantMessage", message: { text: '{"a":1}' } } },
      { delta: { type: "text-delta", text: "Server stopped." } },
      { step: { type: "assistantMessage", message: { text: "Server stopped." } } },
    ];
    const sdk = await sdkEventsOf(script, "node");
    const comparable = (events: readonly Line[]) =>
      events
        .filter((event) => event.kind === "token" || event.kind === "message")
        .map((event) => ({ kind: event.kind, text: event.text }));
    expect(comparable(sdk)).toEqual(comparable(legacy));
    // Directly: two distinct messages, never the joined flush.
    expect(sdk.filter((event) => event.kind === "message").map((event) => event.text)).toEqual([
      '{"a":1}',
      "Server stopped.",
    ]);
  });

  test("an interleaved genuine SDK progress record keeps the boundary (both runtimes)", async () => {
    // The genuine native progress type: the SDK's own task stream record.
    // Interleaving it between the two steps proves the message boundary is
    // not an artifact of adjacency.
    for (const runtime of ["node", "bun"] as const) {
      const script: ScriptEntry[] = [
        { delta: { type: "text-delta", text: '{"a":' } },
        { delta: { type: "text-delta", text: "1}" } },
        { step: { type: "assistantMessage", message: { text: '{"a":1}' } } },
        { stream: { type: "task", status: "queuedFollowUp" } },
        { delta: { type: "text-delta", text: "Server stopped." } },
        { step: { type: "assistantMessage", message: { text: "Server stopped." } } },
      ];
      const sdk = await sdkEventsOf(script, runtime);
      expect(
        sdk
          .filter((event) => event.kind === "message" || event.kind === "progress")
          .map((event) => `${event.kind}:${event.kind === "progress" ? event.label : event.text}`),
      ).toEqual(['message:{"a":1}', "progress:queuedFollowUp", "message:Server stopped."]);
    }
  });
});

describe("literal cross-source ordering through the real CLI", () => {
  test("tool start, token, complete step, tool completion, usage, second step arrive in exactly that order", async () => {
    const script: ScriptEntry[] = [
      {
        stream: {
          type: "tool_call",
          call_id: "c1",
          name: "read",
          status: "running",
          args: { path: "/tmp/notes.txt" },
        },
      },
      { delta: { type: "text-delta", text: "partial " } },
      { step: { type: "assistantMessage", message: { text: "partial text" } } },
      {
        delta: {
          type: "tool-call-completed",
          callId: "c1",
          toolCall: {
            type: "read",
            args: { path: "/tmp/notes.txt" },
            result: { status: "success", value: { content: "x", totalLines: 1, fileSize: 1 } },
          },
        },
      },
      {
        stream: {
          type: "tool_call",
          call_id: "c1",
          name: "read",
          status: "completed",
          args: { path: "/tmp/notes.txt" },
          result: { status: "success", value: { content: "x", totalLines: 1, fileSize: 1 } },
        },
      },
      {
        stream: {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 12,
          },
        },
      },
      { step: { type: "assistantMessage", message: { text: "final" } } },
    ];
    const run = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished", events: script })] },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const content = contentOf(ndjsonOf(run.stdout));
      // Exactly the script's order: this fails if the fake collapsed the
      // callbacks ahead of the stream (the pre-fix timeline) or the two
      // onStep messages were joined into one (#438).
      expect(content.map((event) => event.kind)).toEqual([
        "tool",
        "token",
        "message",
        "tool-result",
        "usage",
        "message",
      ]);
      expect(
        content.filter((event) => event.kind === "message").map((event) => event.text),
      ).toEqual(["partial text", "final"]);
    } finally {
      run.cleanup();
    }
  });
});
