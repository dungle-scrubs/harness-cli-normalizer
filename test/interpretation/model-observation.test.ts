/**
 * Model-observation oracle: pi self-attests the model it runs on its
 * --mode json stdout (assistant `message` records carry
 * `provider`/`model`), while the transcript-only `model_change` record
 * never appears there. decodeModelObservation reads both shapes; the
 * decoder threads the attestation into DecodeState and re-emits identity
 * with the observed model once the attestation arrives after the session
 * record. Fixture: test/fixtures/harnesses/pi-model-observed.ndjson,
 * captured live 2026-09-14 (`pi --session-id <uuid> -p --mode json
 * "Reply with only: alpha"`, pi 0.85.1, model zai/glm-5.3 per the
 * harness's own attestation).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeParsed, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { decodeIdentity, decodeModelObservation } from "../../src/interpretation/identity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";

const assistantRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "message_start",
  message: { role: "assistant", provider: "zai", model: "glm-5.3" },
  ...overrides,
});

describe("decodeModelObservation (pi attestation shapes)", () => {
  test("assistant message records yield provider + model", () => {
    expect(decodeModelObservation(assistantRecord())).toEqual({
      model: "glm-5.3",
      provider: "zai",
    });
  });

  test("the transcript model_change shape reads the same way", () => {
    expect(
      decodeModelObservation({ type: "model_change", provider: "zai", modelId: "glm-5.3" }),
    ).toEqual({ model: "glm-5.3", provider: "zai" });
  });

  test("no message, user role, blank/non-string attestation: no observation, never a refusal", () => {
    expect(decodeModelObservation({ type: "agent_start" })).toBeNull();
    expect(decodeModelObservation({ type: "message_start" })).toBeNull();
    expect(
      decodeModelObservation({ type: "message_start", message: { role: "user", model: "x" } }),
    ).toBeNull();
    expect(
      decodeModelObservation({
        type: "message_start",
        message: { role: "assistant", provider: "zai", model: "" },
      }),
    ).toBeNull();
    expect(
      decodeModelObservation({
        type: "message_start",
        message: { role: "assistant", provider: "zai", model: 42 },
      }),
    ).toBeNull();
    // A failed turn says nothing about what runs the next one.
    expect(
      decodeModelObservation({
        type: "message_end",
        message: { role: "assistant", provider: "zai", model: "glm-5.3", stopReason: "error" },
      }),
    ).toEqual({ model: "glm-5.3", provider: "zai" });
  });

  test("claude/codex/muse records carry no observation through decodeIdentity", () => {
    const init = { type: "system", subtype: "init", session_id: "a1" };
    expect(decodeIdentity(claudeCode, init, null).observedModel).toBeNull();
    expect(
      decodeIdentity(claudeCode, { ...init, message: { role: "assistant", model: "x" } }, null)
        .observedModel,
    ).toBeNull();
  });
});

describe("decodeParsed threads the attestation and re-emits identity (pi)", () => {
  const sessionLine = (id: string) =>
    ({ type: "session", version: 3, id }) as Record<string, unknown>;

  test("identity first (model empty), attestation re-emits with the observed model", () => {
    const sid = "11111111-2222-4333-8444-555555555555";
    const state = freshDecodeState();
    const first = decodeParsed(piCli, sessionLine(sid), state, "");
    expect(first.filter((e) => e.kind === "identity")).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "identity", sessionId: sid });
    const caps = (first[0] as { capabilities: { escalation: { observedOn?: unknown } } })
      .capabilities.escalation.observedOn;
    expect(caps).toMatchObject({ harness: "pi", model: "" });

    // A token delta between them carries no attestation and re-emits nothing.
    const mid = decodeParsed(
      piCli,
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } },
      state,
      "",
    );
    expect(mid.filter((e) => e.kind === "identity")).toHaveLength(0);

    // The first assistant record attests the model: same sessionId, model filled.
    const attest = decodeParsed(piCli, assistantRecord(), state, "");
    const reemits = attest.filter((e) => e.kind === "identity");
    expect(reemits).toHaveLength(1);
    expect(reemits[0]).toMatchObject({ kind: "identity", sessionId: sid });
    const observed = (reemits[0] as { capabilities: { escalation: { observedOn?: unknown } } })
      .capabilities.escalation.observedOn;
    expect(observed).toMatchObject({ harness: "pi", model: "glm-5.3" });
    expect(state.observedModel).toBe("glm-5.3");
    expect(state.observedProvider).toBe("zai");
  });

  test("attestation with no identity context emits nothing on its own", () => {
    const state = freshDecodeState();
    const events = decodeParsed(piCli, assistantRecord(), state, "");
    expect(events.filter((e) => e.kind === "identity")).toHaveLength(0);
    // The attestation is still threaded for a later identity.
    expect(state.observedModel).toBe("glm-5.3");
  });

  test("resume path (requestedId set) re-emits against the requested id", () => {
    const sid = "11111111-2222-4333-8444-555555555555";
    const state = freshDecodeState(sid);
    decodeParsed(piCli, sessionLine(sid), state, "");
    const attest = decodeParsed(piCli, assistantRecord(), state, "");
    const reemits = attest.filter((e) => e.kind === "identity");
    expect(reemits).toHaveLength(1);
    expect(reemits[0]).toMatchObject({
      kind: "identity",
      sessionId: sid,
      authority: "caller-assigned",
    });
  });
});

describe("live stdout fixture (pi-model-observed.ndjson, pi 0.85.1)", () => {
  const lines = (): Record<string, unknown>[] =>
    readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-model-observed.ndjson"),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  test("the stdout stream carries no model_change record (transcript-only shape)", () => {
    const types = lines().map((l) => l.type);
    expect(types).toContain("session");
    expect(types).not.toContain("model_change");
  });

  test("replaying the fixture decodes the harness's own model to the observed slot", () => {
    const state = freshDecodeState();
    const events = lines().flatMap((line) => decodeParsed(piCli, line, state, ""));
    const identities = events.filter((e) => e.kind === "identity");
    // First sight on the session record, re-emit on the first assistant attestation.
    expect(identities.length).toBe(2);
    expect(identities[0]).toMatchObject({ kind: "identity" });
    const last = identities.at(-1) as {
      capabilities: { escalation: { observedOn?: { model?: string } } };
    };
    expect(last.capabilities.escalation.observedOn?.model).toBe("glm-5.3");
    expect(state.observedModel).toBe("glm-5.3");
    expect(state.observedProvider).toBe("zai");
  });

  test("the observed value never feeds validation or capability source", async () => {
    const { validateModel } = await import("../../src/interpretation/vocabulary.js");
    // D-008: extensible accepts the clean unknown selector - by the static
    // registry rule, not by anything observed on the stream.
    expect(validateModel(piCli, "glm-5.3")).toEqual({ ok: true, id: "glm-5.3" });
    const { capabilitiesOf } = await import("../../src/interpretation/capabilities.js");
    const caps = capabilitiesOf(piCli, "", "headless-turn");
    expect(caps.escalation.observedOn?.model).toBe("");
  });

  test("session path: the probe identity carries a late attestation the same way", async () => {
    const { openSession } = await import("../../src/execution/open-session.js");
    const { FakeClock, FakeProcess, fakeSignal, fakeSpawner } = await import(
      "../execution/fakes.js"
    );
    const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const d = { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal };
    const session = openSession(piCli, { sessionId: sid }, d);
    session.send({ id: "s1", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    const seen: HarnessEvent[] = [];
    const drain = (async () => {
      for await (const e of turn) seen.push(e);
    })();
    // get_state probe answers with the session id before any assistant record.
    proc.emitLine(
      JSON.stringify({
        type: "response",
        id: "hcn-identity",
        command: "get_state",
        success: true,
        data: { sessionId: sid },
      }),
    );
    // Assistant content attests the model after the probe identity went out.
    proc.emitLine(
      JSON.stringify({
        type: "message_start",
        message: { role: "assistant", provider: "zai", model: "glm-5.3" },
      }),
    );
    proc.emitLine(JSON.stringify({ type: "agent_settled" }));
    await drain;
    await session.close();
    const identities = seen.filter((e) => e.kind === "identity");
    expect(identities.length).toBeGreaterThanOrEqual(1);
    const last = identities.at(-1) as {
      capabilities: { escalation: { observedOn?: { model?: string } } };
    };
    expect(last.capabilities.escalation.observedOn?.model).toBe("glm-5.3");
  });
});
