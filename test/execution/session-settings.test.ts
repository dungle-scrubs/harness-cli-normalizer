/**
 * Issue #456: mid-session model and effort changes and verbatim sends,
 * driven through openSession over fake native processes. Claude wire
 * shapes from the 2.1.319 probe (set_model / apply_flag_settings control
 * requests, answers keyed by request_id); pi wire shapes from the 1.4 RPC
 * probe, extended by the review round 1 fixes: a settings op that names a
 * model first reads the session's own catalog (get_available_models,
 * resolving the selector the way the spawn flags do - F1), and every pi
 * op ends with a get_state readback so the receipt reports the EFFECTIVE
 * model (provider/id) and thinking level, not the requested ones (F2).
 * Verbatim sends are checked in every questions mode, with the session
 * preamble asserted literally (F11: no production-imported expectations).
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { createSettingsSequencer } from "../../src/execution/session-settings-sequencer.js";
import type { QuestionMode } from "../../src/interpretation/question.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (
  descriptor: typeof claudeCode | typeof piCli | typeof codexCli,
  opts: {
    readonly questions?: QuestionMode;
    readonly model?: string;
    readonly provider?: string;
    readonly exitOnStdinEnd?: boolean;
  } = {},
) => {
  const proc = new FakeProcess({
    ...(opts.exitOnStdinEnd === false ? { exitOnStdinEnd: false } : {}),
  });
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const log: Record<string, unknown>[] = [];
  const session = openSession(
    descriptor,
    {
      sessionId: sid,
      questions: opts.questions ?? "none",
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    },
    { spawn: spawner.spawn, clock: new FakeClock(), signal: sig.signal, log: (e) => log.push(e) },
  );
  const turns = session.turns[Symbol.asyncIterator]();
  return { proc, spawner, sig, log, session, turns };
};

const lastStdin = (proc: FakeProcess): Record<string, unknown> =>
  JSON.parse(proc.stdinLines.at(-1) ?? "null") as Record<string, unknown>;
const stdinLine = (proc: FakeProcess, id: string): Record<string, unknown> | undefined =>
  proc.stdinLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.id === id);
const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of turn) out.push(event);
  return out;
};

// --- claude wire shapes ----------------------------------------------------
const claudeSetModelAnswer = (requestId: string, model: string): string =>
  JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { model } },
  });
const claudeAck = (requestId: string): string =>
  JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId },
  });

// --- pi wire shapes --------------------------------------------------------
const PI_CATALOG = [
  { id: "glm-5.2", provider: "zai" },
  { id: "glm-5.3", provider: "zai" },
  { id: "anthropic/claude-fable-5", provider: "openrouter" },
];
const piCatalogAnswer = (requestId: string): string =>
  JSON.stringify({
    id: requestId,
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models: PI_CATALOG },
  });
const piSetModelAnswer = (requestId: string, id: string): string =>
  JSON.stringify({
    id: requestId,
    type: "response",
    command: "set_model",
    success: true,
    data: { id },
  });
const piThinkingAnswer = (requestId: string): string =>
  JSON.stringify({ id: requestId, type: "response", command: "set_thinking_level", success: true });
const piStateAnswer = (
  requestId: string,
  data: { model?: { provider: string; id: string }; thinkingLevel?: string } = {},
): string =>
  JSON.stringify({
    id: requestId,
    type: "response",
    command: "get_state",
    success: true,
    data,
  });

describe("issue #456: the settings op on a claude session", () => {
  test("model and effort write set_model then apply_flag_settings; the receipt confirms", async () => {
    const r = rig(claudeCode);
    const receipt = r.session.settings({ id: "set-1", model: "haiku", effort: "low" });
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      type: "control_request",
      request_id: "hcn-settings:1",
      request: { subtype: "set_model", model: "claude-haiku-5-5" },
    });
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      type: "control_request",
      request_id: "hcn-settings:1:e",
      request: { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
    });
    r.proc.emitLine(claudeAck("hcn-settings:1:e"));
    expect(await receipt).toEqual({
      state: "applied",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("effort alone writes one command; model alone settles on its confirmation", async () => {
    const r = rig(claudeCode);
    const effortOnly = r.session.settings({ id: "e1", effort: "high" });
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      type: "control_request",
      request_id: "hcn-settings:1:e",
      request: { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
    });
    r.proc.emitLine(claudeAck("hcn-settings:1:e"));
    expect(await effortOnly).toEqual({ state: "applied", effort: "high" });
    const modelOnly = r.session.settings({ id: "m1", model: "sonnet" });
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      type: "control_request",
      request_id: "hcn-settings:2",
      request: { subtype: "set_model", model: "claude-sonnet-5-5" },
    });
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:2", "claude-sonnet-5-5"));
    expect(await modelOnly).toEqual({ state: "applied", model: "claude-sonnet-5-5" });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a native rejection reports the part that applied", async () => {
    const r = rig(claudeCode);
    const receipt = r.session.settings({ id: "set-1", model: "haiku", effort: "low" });
    await tick();
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "error", request_id: "hcn-settings:1:e", error: "no such level" },
      }),
    );
    expect(await receipt).toEqual({
      state: "rejected",
      reason: "native-rejected",
      model: "claude-haiku-5-5",
    });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #456 (review F1/F2): the settings op on a pi session", () => {
  test("a model op reads the catalog, resolves the pair, writes, and reads the effective state", async () => {
    const r = rig(piCli);
    const receipt = r.session.settings({ id: "set-1", model: "zai/glm-5.2", effort: "minimal" });
    await tick();
    // The catalog read comes first: the selector resolves against the
    // session's own providers, exactly as the spawn flags resolve it.
    expect(lastStdin(r.proc)).toEqual({
      id: "hcn-settings:1:c",
      type: "get_available_models",
    });
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      id: "hcn-settings:1",
      type: "set_model",
      provider: "zai",
      modelId: "glm-5.2",
    });
    r.proc.emitLine(piSetModelAnswer("hcn-settings:1", "glm-5.2"));
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      id: "hcn-settings:1:e",
      type: "set_thinking_level",
      level: "minimal",
    });
    r.proc.emitLine(piThinkingAnswer("hcn-settings:1:e"));
    await tick();
    expect(lastStdin(r.proc)).toEqual({ id: "hcn-settings:1:s", type: "get_state" });
    r.proc.emitLine(
      piStateAnswer("hcn-settings:1:s", {
        model: { provider: "zai", id: "glm-5.2" },
        thinkingLevel: "minimal",
      }),
    );
    // The receipt reports the effective provider/id pair and level.
    expect(await receipt).toEqual({
      state: "applied",
      model: "zai/glm-5.2",
      effort: "minimal",
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("the session's --provider constrains resolution; a slashed gateway id stays whole (F1)", async () => {
    const r = rig(piCli, { provider: "openrouter" });
    const receipt = r.session.settings({ id: "set-1", model: "anthropic/claude-fable-5" });
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({ type: "get_available_models" });
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    expect(lastStdin(r.proc)).toEqual({
      id: "hcn-settings:1",
      type: "set_model",
      provider: "openrouter",
      modelId: "anthropic/claude-fable-5",
    });
    r.proc.emitLine(piSetModelAnswer("hcn-settings:1", "anthropic/claude-fable-5"));
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({ type: "get_state" });
    r.proc.emitLine(
      piStateAnswer("hcn-settings:1:s", {
        model: { provider: "openrouter", id: "anthropic/claude-fable-5" },
        thinkingLevel: "low",
      }),
    );
    expect(await receipt).toEqual({
      state: "applied",
      model: "openrouter/anthropic/claude-fable-5",
      effort: "low",
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a selector nothing resolves rejects invalid-model with no model write (F1)", async () => {
    const r = rig(piCli);
    const receipt = r.session.settings({ id: "set-1", model: "nope" });
    await tick();
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    expect(await receipt).toEqual({ state: "rejected", reason: "invalid-model" });
    expect(r.proc.stdinLines.some((line) => line.includes('"set_model"'))).toBe(false);
    r.proc.exit(0);
    await r.session.close();
  });

  test("the state readback reports the EFFECTIVE level pi clamped to, not the request (F2)", async () => {
    const r = rig(piCli);
    const receipt = r.session.settings({ id: "set-1", effort: "max" });
    await tick();
    // Effort-only op: no catalog read.
    expect(r.proc.stdinLines.some((line) => line.includes("get_available_models"))).toBe(false);
    expect(lastStdin(r.proc)).toEqual({
      id: "hcn-settings:1:e",
      type: "set_thinking_level",
      level: "max",
    });
    r.proc.emitLine(piThinkingAnswer("hcn-settings:1:e"));
    await tick();
    r.proc.emitLine(
      piStateAnswer("hcn-settings:1:s", {
        model: { provider: "zai", id: "glm-5.2" },
        thinkingLevel: "high",
      }),
    );
    // pi clamped max -> high; the receipt says what runs. The effective
    // model rides along even though the op never named one.
    expect(await receipt).toEqual({ state: "applied", model: "zai/glm-5.2", effort: "high" });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a failed catalog read rejects native-rejected; a failed state readback reports unconfirmed (F2, review round 3 H2)", async () => {
    const r = rig(piCli);
    const catalogFailed = r.session.settings({ id: "set-1", model: "glm-5.2" });
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1:c",
        type: "response",
        command: "get_available_models",
        success: false,
        error: "no models",
      }),
    );
    expect(await catalogFailed).toEqual({ state: "rejected", reason: "native-rejected" });

    const stateFailed = r.session.settings({ id: "set-2", model: "glm-5.3" });
    await tick();
    r.proc.emitLine(piCatalogAnswer("hcn-settings:2:c"));
    await tick();
    r.proc.emitLine(piSetModelAnswer("hcn-settings:2", "glm-5.3"));
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({ type: "get_state" });
    // The writes applied; only the readback failed. The receipt confirms
    // nothing it could not read back: `applied` with the written part in
    // `unconfirmed`, never as an effective value. The diagnostic is the
    // control path's job (the `--json` lane test), not a parked event.
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:2:s",
        type: "response",
        command: "get_state",
        success: false,
        error: "busy",
      }),
    );
    expect(await stateFailed).toEqual({ state: "applied", unconfirmed: ["model"] });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a state readback that answers neither field is the same failure class (review round 3, H2)", async () => {
    const r = rig(piCli);
    const op = r.session.settings({ id: "set-1", model: "glm-5.2", effort: "high" });
    await tick();
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    r.proc.emitLine(piSetModelAnswer("hcn-settings:1", "glm-5.2"));
    await tick();
    r.proc.emitLine(piThinkingAnswer("hcn-settings:1:e"));
    await tick();
    // get_state answered ok but carried no model or thinking level: both
    // halves wrote, neither is confirmed.
    r.proc.emitLine(piStateAnswer("hcn-settings:1:s", {}));
    expect(await op).toEqual({ state: "applied", unconfirmed: ["model", "effort"] });
    r.proc.exit(0);
    await r.session.close();
  });

  test("failed and partial readbacks mark exactly the fields they could not read back (review round 4, J4)", async () => {
    const r = rig(piCli);
    // Drives one op to its get_state readback and hands back the still
    // PENDING receipt (wrapped, so awaiting the driver does not await
    // the op); the caller answers the readback (or lets it fail).
    const toReadback = async (n: number, request: { model?: string; effort?: string }) => {
      const op = r.session.settings({ id: `set-${n}`, ...request });
      await tick();
      if (request.model !== undefined) {
        r.proc.emitLine(piCatalogAnswer(`hcn-settings:${n}:c`));
        await tick();
        r.proc.emitLine(piSetModelAnswer(`hcn-settings:${n}`, request.model));
        await tick();
      }
      if (request.effort !== undefined) {
        r.proc.emitLine(piThinkingAnswer(`hcn-settings:${n}:e`));
        await tick();
      }
      expect(lastStdin(r.proc)).toMatchObject({ type: "get_state" });
      return { op };
    };
    const stateFailure = (n: number): string =>
      JSON.stringify({
        id: `hcn-settings:${n}:s`,
        type: "response",
        command: "get_state",
        success: false,
        error: "busy",
      });
    // A failed readback confirms nothing: every requested field is
    // `unconfirmed` - model-only, effort-only and both.
    let { op } = await toReadback(1, { effort: "high" });
    r.proc.emitLine(stateFailure(1));
    expect(await op).toEqual({ state: "applied", unconfirmed: ["effort"] });
    ({ op } = await toReadback(2, { model: "glm-5.3" }));
    r.proc.emitLine(stateFailure(2));
    expect(await op).toEqual({ state: "applied", unconfirmed: ["model"] });
    ({ op } = await toReadback(3, { model: "glm-5.2", effort: "high" }));
    r.proc.emitLine(stateFailure(3));
    expect(await op).toEqual({ state: "applied", unconfirmed: ["model", "effort"] });
    // A partial readback reports only the half it confirmed; the half it
    // omitted is `unconfirmed`, NEVER silently its requested value.
    ({ op } = await toReadback(4, { model: "glm-5.2", effort: "high" }));
    r.proc.emitLine(
      piStateAnswer("hcn-settings:4:s", { model: { provider: "zai", id: "glm-5.2" } }),
    );
    expect(await op).toEqual({ state: "applied", model: "zai/glm-5.2", unconfirmed: ["effort"] });
    ({ op } = await toReadback(5, { model: "glm-5.2", effort: "high" }));
    r.proc.emitLine(piStateAnswer("hcn-settings:5:s", { thinkingLevel: "high" }));
    expect(await op).toEqual({ state: "applied", effort: "high", unconfirmed: ["model"] });
    // An effort-only op whose readback carried the model but not the
    // level: the model rides along, the level is unconfirmed.
    ({ op } = await toReadback(6, { effort: "high" }));
    r.proc.emitLine(
      piStateAnswer("hcn-settings:6:s", { model: { provider: "zai", id: "glm-5.2" } }),
    );
    expect(await op).toEqual({ state: "applied", model: "zai/glm-5.2", unconfirmed: ["effort"] });
    // A readback that confirmed everything carries no `unconfirmed` at
    // all (the effective effort rides along the way the effective model
    // does for an effort-only op).
    ({ op } = await toReadback(7, { model: "glm-5.2" }));
    r.proc.emitLine(
      piStateAnswer("hcn-settings:7:s", {
        model: { provider: "zai", id: "glm-5.2" },
        thinkingLevel: "high",
      }),
    );
    expect(await op).toEqual({ state: "applied", model: "zai/glm-5.2", effort: "high" });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #456: settings rejection reasons", () => {
  test.each([
    [{ model: "nope" }, "invalid-model"],
    [{ effort: "sideways" }, "invalid-effort"],
  ])("invalid values reject without a native write", async (request, reason) => {
    const r = rig(claudeCode);
    const before = [...r.proc.stdinLines];
    expect(await r.session.settings({ id: "s1", ...request })).toEqual({
      state: "rejected",
      reason,
    });
    expect(r.proc.stdinLines).toEqual(before);
    r.proc.exit(0);
    await r.session.close();
  });

  test("other session harnesses reject unsupported without a write", async () => {
    const r = rig(codexCli);
    const before = [...r.proc.stdinLines];
    expect(await r.session.settings({ id: "s1", model: "gpt-5.5" })).toEqual({
      state: "rejected",
      reason: "unsupported",
    });
    expect(r.proc.stdinLines).toEqual(before);
    r.proc.exit(0);
    await r.session.close();
  });

  test("a closing session rejects closed; process death settles a pending op closed", async () => {
    const r = rig(claudeCode);
    const closing = r.session.close();
    await tick();
    expect(await r.session.settings({ id: "s1", model: "haiku" })).toEqual({
      state: "rejected",
      reason: "closed",
    });
    await closing;
    const r2 = rig(claudeCode);
    const pending = r2.session.settings({ id: "s2", model: "haiku" });
    await tick();
    r2.proc.exit(1);
    expect(await pending).toEqual({ state: "rejected", reason: "closed" });
  });

  test("a broken stdin rejects write-failed with the part that applied", async () => {
    const r = rig(claudeCode, { exitOnStdinEnd: false });
    r.proc.stdinPiped = true;
    const first = r.session.settings({ id: "s1", model: "haiku" });
    await tick();
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    expect(await first).toEqual({ state: "applied", model: "claude-haiku-5-5" });
    // End stdin without exiting: the next write throws.
    r.proc.stdin?.end();
    const second = r.session.settings({ id: "s2", model: "sonnet" });
    expect(await second).toEqual({ state: "rejected", reason: "write-failed" });
    r.proc.exit(1);
    await r.session.close();
  });

  test("an ASYNC stdin failure settles the in-flight and queued ops write-failed (review F3)", async () => {
    const r = rig(piCli, { exitOnStdinEnd: false });
    const first = r.session.settings({ id: "s1", model: "glm-5.2" });
    const queued = r.session.settings({ id: "s2", model: "glm-5.3" });
    await tick();
    // The first op sits in its catalog phase on the wire; the second is
    // queued behind it. The pipe now fails asynchronously - no write
    // throws, the adapter's inputError promise is the only signal.
    r.proc.failStdin();
    expect(await first).toEqual({ state: "rejected", reason: "write-failed" });
    expect(await queued).toEqual({ state: "rejected", reason: "write-failed" });
    expect(
      r.log.some(
        (entry) =>
          entry.event === "settings" && entry.reason === "write-failed" && entry.id === "s2",
      ),
    ).toBe(true);
    // The session ends the way a broken send pipe does: escalated, the
    // exit path closes it out.
    await r.session.close();
  });
});

describe("issue #456: settings ops serialize and settle only on their own answers", () => {
  test("a second op waits for the first to settle before its write", async () => {
    const r = rig(piCli);
    const setModelWrites = (): number =>
      r.proc.stdinLines.filter((line) => line.includes('"set_model"')).length;
    const catalogWrites = (): number =>
      r.proc.stdinLines.filter((line) => line.includes('"get_available_models"')).length;
    const first = r.session.settings({ id: "s1", model: "zai/glm-5.2" });
    const second = r.session.settings({ id: "s2", model: "zai/glm-5.3" });
    await tick();
    // Only the first op's catalog read is on the wire (the identity
    // probe aside).
    expect(catalogWrites()).toBe(1);
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    expect(setModelWrites()).toBe(1);
    expect(lastStdin(r.proc)).toMatchObject({ type: "set_model", modelId: "glm-5.2" });
    r.proc.emitLine(piSetModelAnswer("hcn-settings:1", "glm-5.2"));
    await tick();
    // The readback still belongs to the first op.
    expect(lastStdin(r.proc)).toMatchObject({ type: "get_state" });
    r.proc.emitLine(
      piStateAnswer("hcn-settings:1:s", { model: { provider: "zai", id: "glm-5.2" } }),
    );
    expect(await first).toEqual({ state: "applied", model: "zai/glm-5.2" });
    await tick();
    // The wire freed, the queued op writes now - the two cannot race.
    expect(catalogWrites()).toBe(2);
    r.proc.emitLine(piCatalogAnswer("hcn-settings:2:c"));
    await tick();
    expect(setModelWrites()).toBe(2);
    expect(lastStdin(r.proc)).toMatchObject({ type: "set_model", modelId: "glm-5.3" });
    r.proc.emitLine(piSetModelAnswer("hcn-settings:2", "glm-5.3"));
    await tick();
    r.proc.emitLine(
      piStateAnswer("hcn-settings:2:s", { model: { provider: "zai", id: "glm-5.3" } }),
    );
    expect(await second).toEqual({ state: "applied", model: "zai/glm-5.3" });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a queued op settles closed when the session dies before the wire freed", async () => {
    const r = rig(piCli);
    const first = r.session.settings({ id: "s1", model: "zai/glm-5.2" });
    const queued = r.session.settings({ id: "s2", model: "zai/glm-5.3" });
    await tick();
    r.proc.exit(1);
    // Both ops get their one receipt: the in-flight one closed, the
    // queued one closed too - never a hanging promise.
    expect(await first).toEqual({ state: "rejected", reason: "closed" });
    expect(await queued).toEqual({ state: "rejected", reason: "closed" });
    expect(r.proc.stdinLines.some((line) => line.includes('"glm-5.3"'))).toBe(false);
    // Review round 3, H6: the queued op's close is logged with its exact
    // diagnostic fields - the state and reason a drain would settle it
    // with, its own token, nothing else.
    await r.session.close();
    expect(r.log.filter((e) => e.event === "settings" && e.id === "s2")).toEqual([
      {
        event: "settings",
        sessionId: sid,
        id: "s2",
        token: "2",
        state: "rejected",
        reason: "closed",
      },
    ]);
  });

  test("an effort-only op queued behind a model change reads the runner's tracked model, through openSession (review round 3, H6)", async () => {
    // Same shape as the sequencer-level G8 test below, but through the
    // real openSession: the runner's onModelResolved tracker - not the
    // sequencer's own state - must feed the queued op's validation.
    const laddered: typeof claudeCode = {
      ...claudeCode,
      vocabulary: {
        ...claudeCode.vocabulary,
        effortsByModel: { "claude-haiku-5-5": ["low"], "claude-sonnet-5-5": ["high"] },
      },
    };
    const r = rig(laddered, { model: "claude-haiku-5-5" });
    const first = r.session.settings({ id: "s1", model: "sonnet" });
    await tick();
    // set_model is on the wire; the second op queues behind it before
    // the ack. Low is valid on the spawn model haiku, invalid on the
    // model s1 applies - and s2 must read THAT one.
    const second = r.session.settings({ id: "s2", effort: "low" });
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-sonnet-5-5"));
    expect(await first).toEqual({ state: "applied", model: "claude-sonnet-5-5" });
    expect(await second).toEqual({ state: "rejected", reason: "invalid-effort" });
    expect(r.proc.stdinLines.some((line) => line.includes("effortLevel"))).toBe(false);
    r.proc.exit(0);
    await r.session.close();
  });

  test("a stale or premature answer to the other half settles nothing", async () => {
    const r = rig(claudeCode);
    const receipt = r.session.settings({ id: "s1", model: "haiku", effort: "low" });
    await tick();
    // A premature effort answer while the model write is outstanding.
    r.proc.emitLine(claudeAck("hcn-settings:1:e"));
    await tick();
    expect(r.proc.stdinLines).toHaveLength(1);
    // The real model answer arrives, then the effort write follows.
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({
      request_id: "hcn-settings:1:e",
    });
    // A stale duplicate of the model answer settles nothing either: no
    // third write happens and the receipt stays pending until the real
    // effort acknowledgment.
    let settled = false;
    void receipt.then(() => {
      settled = true;
    });
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    expect(r.proc.stdinLines).toHaveLength(2);
    expect(settled).toBe(false);
    r.proc.emitLine(claudeAck("hcn-settings:1:e"));
    expect(await receipt).toEqual({
      state: "applied",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a pi answer whose command does not match its id's part settles nothing (review F8)", async () => {
    const r = rig(piCli);
    const receipt = r.session.settings({ id: "s1", model: "glm-5.2" });
    await tick();
    // A set_thinking_level response under the catalog id is not the
    // catalog's answer.
    r.proc.emitLine(piThinkingAnswer("hcn-settings:1:c"));
    await tick();
    expect(stdinLine(r.proc, "hcn-settings:1")).toBeUndefined();
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    expect(stdinLine(r.proc, "hcn-settings:1")).toMatchObject({ type: "set_model" });
    r.proc.emitLine(piSetModelAnswer("hcn-settings:1", "glm-5.2"));
    await tick();
    r.proc.emitLine(
      piStateAnswer("hcn-settings:1:s", { model: { provider: "zai", id: "glm-5.2" } }),
    );
    expect(await receipt).toEqual({ state: "applied", model: "zai/glm-5.2" });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a stale duplicate from an earlier op settles nothing while the next is in flight (review round 2, G1)", async () => {
    const r = rig(claudeCode);
    const first = r.session.settings({ id: "s1", model: "haiku" });
    await tick();
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    expect(await first).toEqual({ state: "applied", model: "claude-haiku-5-5" });
    // Op 2 is in flight at its model phase when op 1's model answer
    // arrives AGAIN: the phase matches but the token does not, so the
    // duplicate must settle nothing - op 2 waits for its own answer.
    const second = r.session.settings({ id: "s2", model: "sonnet" });
    await tick();
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    expect(settled).toBe(false);
    expect(r.proc.stdinLines).toHaveLength(2);
    expect(
      r.log.some(
        (entry) =>
          entry.event === "settings_stale" && entry.token === "1" && entry.part === "model",
      ),
    ).toBe(true);
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:2", "claude-sonnet-5-5"));
    expect(await second).toEqual({ state: "applied", model: "claude-sonnet-5-5" });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a terminal failure after the model acknowledgement still reports the applied model (review round 2, G2)", async () => {
    // Process death between the two acknowledgements: closed, with the
    // part that applied.
    const r = rig(claudeCode);
    const closed = r.session.settings({ id: "s1", model: "haiku", effort: "low" });
    await tick();
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({ request_id: "hcn-settings:1:e" });
    r.proc.exit(1);
    expect(await closed).toEqual({
      state: "rejected",
      reason: "closed",
      model: "claude-haiku-5-5",
    });
    // The same for the asynchronous pipe failure: write-failed, with the
    // part that applied.
    const r2 = rig(piCli, { exitOnStdinEnd: false });
    const failed = r2.session.settings({ id: "s1", model: "zai/glm-5.2", effort: "low" });
    await tick();
    r2.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    r2.proc.emitLine(piSetModelAnswer("hcn-settings:1", "glm-5.2"));
    await tick();
    // The model write was acknowledged; the effort write is on the wire
    // when the pipe breaks with no write throwing.
    r2.proc.failStdin();
    expect(await failed).toEqual({
      state: "rejected",
      reason: "write-failed",
      model: "zai/glm-5.2",
    });
    await r2.session.close();
  });

  test("a model:level selector applies the parsed level; an explicit effort wins (review round 2, G4)", async () => {
    const r = rig(piCli);
    const receipt = r.session.settings({ id: "s1", model: "glm-5.2:high" });
    await tick();
    r.proc.emitLine(piCatalogAnswer("hcn-settings:1:c"));
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({ type: "set_model", modelId: "glm-5.2" });
    r.proc.emitLine(piSetModelAnswer("hcn-settings:1", "glm-5.2"));
    await tick();
    // The parsed level becomes the op's effort write, the way pi's
    // --model applies it at spawn.
    expect(lastStdin(r.proc)).toEqual({
      id: "hcn-settings:1:e",
      type: "set_thinking_level",
      level: "high",
    });
    r.proc.emitLine(piThinkingAnswer("hcn-settings:1:e"));
    await tick();
    r.proc.emitLine(
      piStateAnswer("hcn-settings:1:s", {
        model: { provider: "zai", id: "glm-5.2" },
        thinkingLevel: "high",
      }),
    );
    expect(await receipt).toEqual({ state: "applied", model: "zai/glm-5.2", effort: "high" });

    const explicit = r.session.settings({ id: "s2", model: "glm-5.3:high", effort: "low" });
    await tick();
    r.proc.emitLine(piCatalogAnswer("hcn-settings:2:c"));
    await tick();
    r.proc.emitLine(piSetModelAnswer("hcn-settings:2", "glm-5.3"));
    await tick();
    expect(lastStdin(r.proc)).toMatchObject({ type: "set_thinking_level", level: "low" });
    r.proc.emitLine(piThinkingAnswer("hcn-settings:2:e"));
    await tick();
    r.proc.emitLine(
      piStateAnswer("hcn-settings:2:s", {
        model: { provider: "zai", id: "glm-5.3" },
        thinkingLevel: "low",
      }),
    );
    expect(await explicit).toEqual({ state: "applied", model: "zai/glm-5.3", effort: "low" });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #456: verbatim sends", () => {
  test.each(["ask", "assume", "none"] as const)(
    "questions %s: a verbatim send writes the text exactly as given",
    async (mode) => {
      const r = rig(claudeCode, { questions: mode });
      r.session.send({ id: "a", text: "/model haiku", verbatim: true });
      const written = lastStdin(r.proc);
      expect((written.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe(
        "/model haiku",
      );
      // A non-verbatim send in an injecting mode still gets the preamble,
      // asserted literally so a mutant that rewrites it dies here; in
      // none mode the modes agree by design.
      r.session.send({ id: "b", text: "plain question?" });
      const composed = String(
        (lastStdin(r.proc).message as { content?: { text?: string }[] })?.content?.[0]?.text,
      );
      expect(composed.endsWith("plain question?")).toBe(true);
      if (mode !== "none") {
        expect(composed).not.toBe("plain question?");
        // The preamble is asserted literally per mode, so a mutant that
        // rewrites either wording dies here (review round 1, F11).
        if (mode === "ask") expect(composed).toContain("You are running in a persistent session");
        else expect(composed).toContain("Never ask a question");
      }
      r.proc.exit(0);
      await r.session.close();
    },
  );

  test("verbatim sends on pi reach the prompt as typed - only extension commands run there (review F5)", async () => {
    const r = rig(piCli, { questions: "ask" });
    r.session.send({ id: "a", text: "/skill:x args", verbatim: true });
    expect(lastStdin(r.proc)).toMatchObject({ type: "prompt", message: "/skill:x args" });
    r.proc.exit(0);
    await r.session.close();
  });

  test("a verbatim send still opens its turn normally", async () => {
    const r = rig(claudeCode, { questions: "ask" });
    r.session.send({ id: "a", text: "/dev-mode", verbatim: true });
    const uuid = lastStdin(r.proc).uuid;
    r.proc.emitLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sid,
        user_message_uuids: [uuid],
      }),
    );
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    r.proc.exit(0);
    await drainTurn(turn);
    await r.session.close();
  });
});

describe("issue #456 (review round 2, G8): an op validates at dispatch", () => {
  test("an effort-only op queued behind a model change reads the model that change applied", async () => {
    // Only the sequencer decides WHEN validation reads the session's
    // model, so this drives the sequencer directly with a claude
    // descriptor whose ladders differ per model (the real claude
    // vocabulary has one ladder; the timing is what is under test).
    const laddered = {
      ...claudeCode,
      vocabulary: {
        ...claudeCode.vocabulary,
        effortsByModel: { "claude-haiku-5-5": ["low"], "claude-sonnet-5-5": ["high"] },
      },
    };
    const writes: string[] = [];
    let current: string | undefined = "claude-haiku-5-5";
    let seq = 0;
    const q = createSettingsSequencer(
      laddered,
      claudeCode.sessionMode?.input ?? { kind: "pi-rpc-prompt" },
      {
        sessionId: sid,
        log: () => {},
        isClosed: () => false,
        write: (line) => {
          writes.push(line);
        },
        onWriteFailed: () => {},
        currentModel: () => current,
        onModelResolved: (model) => {
          current = model;
        },
        nextToken: () => String(++seq),
      },
    );
    // Op 1 switches to sonnet (whose ladder is high-only). Op 2, an
    // effort-only low, is submitted while op 1 is in flight: low is
    // valid against the spawn model haiku, and INVALID against the model
    // op 1 applies - so it must reject at its own dispatch, not write.
    const first = q.submit({ id: "s1", model: "sonnet" });
    const second = q.submit({ id: "s2", effort: "low" });
    q.onAnswered({
      kind: "settings-answered",
      token: "1",
      part: "model",
      ok: true,
      model: "claude-sonnet-5-5",
    });
    expect(await first).toEqual({ state: "applied", model: "claude-sonnet-5-5" });
    expect(await second).toEqual({ state: "rejected", reason: "invalid-effort" });
    expect(writes.some((line) => line.includes("effortLevel"))).toBe(false);
    // The wire freed by a rejected dispatch still serves the op behind it.
    const third = q.submit({ id: "s3", effort: "high" });
    q.onAnswered({ kind: "settings-answered", token: "3", part: "effort", ok: true });
    expect(await third).toEqual({ state: "applied", effort: "high" });
  });
});
