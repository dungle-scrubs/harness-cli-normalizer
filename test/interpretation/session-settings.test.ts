/**
 * Issue #456: the pure layer of mid-session model/effort changes - the
 * validation the spawn flags already apply, the native command encodings
 * (claude set_model / apply_flag_settings control requests; pi
 * set_model / set_thinking_level / get_available_models / get_state rpc
 * commands), the request-id scheme their answers correlate by, Pi's
 * catalog resolution (mirroring pi 1.4.0's resolveCliModel), and the
 * answer decoding. Wire shapes from the 2.1.319 and pi 1.4 probes.
 */
import { describe, expect, test } from "vitest";
import { decodeSessionRecord } from "../../src/interpretation/session-input.js";
import {
  claudeSettingsAnswerOf,
  encodeSessionSettingsCatalog,
  encodeSessionSettingsEffort,
  encodeSessionSettingsModel,
  encodeSessionSettingsState,
  parseSettingsId,
  piSettingsAnswerOf,
  resolvePiSessionModel,
  settingsCatalogId,
  settingsEffortId,
  settingsModelId,
  settingsStateId,
  supportsSessionSettings,
  validateSessionSettings,
} from "../../src/interpretation/session-settings.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";

const claudeInput = claudeCode.sessionMode?.input ?? { kind: "codex-jsonrpc" };
const piInput = piCli.sessionMode?.input ?? { kind: "codex-jsonrpc" };

describe("issue #456: settings request ids", () => {
  test("each native command of one op carries its own correlatable id", () => {
    expect(settingsModelId("7")).toBe("hcn-settings:7");
    expect(settingsEffortId("7")).toBe("hcn-settings:7:e");
    expect(settingsCatalogId("7")).toBe("hcn-settings:7:c");
    expect(settingsStateId("7")).toBe("hcn-settings:7:s");
    expect(parseSettingsId("hcn-settings:7")).toEqual({ token: "7", part: "model" });
    expect(parseSettingsId("hcn-settings:7:e")).toEqual({ token: "7", part: "effort" });
    expect(parseSettingsId("hcn-settings:7:c")).toEqual({ token: "7", part: "catalog" });
    expect(parseSettingsId("hcn-settings:7:s")).toEqual({ token: "7", part: "state" });
    expect(parseSettingsId("hcn-settings:")).toBeNull();
    expect(parseSettingsId("hcn-settings::e")).toBeNull();
    expect(parseSettingsId("hcn-interrupt:7")).toBeNull();
    expect(parseSettingsId(7)).toBeNull();
    expect(parseSettingsId("hcn-send:7")).toBeNull();
  });
});

describe("issue #456: validation mirrors the spawn flags", () => {
  test("claude resolves aliases and validates the ladder of the resulting model", () => {
    expect(
      validateSessionSettings(claudeCode, claudeInput, {
        model: "haiku",
        effort: "low",
      }),
    ).toEqual({ ok: true, value: { model: { id: "claude-haiku-5-5" }, effort: "low" } });
    expect(validateSessionSettings(claudeCode, claudeInput, { model: "nope" })).toEqual({
      ok: false,
      reason: "invalid-model",
    });
    expect(validateSessionSettings(claudeCode, claudeInput, { effort: "sideways" })).toEqual({
      ok: false,
      reason: "invalid-effort",
    });
    // The ladder of the resulting model: the op's own model decides.
    expect(
      validateSessionSettings(claudeCode, claudeInput, { effort: "high" }, { model: "haiku" }),
    ).toEqual({ ok: true, value: { effort: "high" } });
  });

  test("pi model selectors pass only the spawn flag's selector check; the catalog resolves later", () => {
    // A bare id is a valid pi selector at spawn time (extensible registry)
    // and stays one here; whether it exists is the catalog's question.
    expect(validateSessionSettings(piCli, piInput, { model: "glm-5.2" })).toEqual({
      ok: true,
      value: { model: { id: "glm-5.2" } },
    });
    expect(validateSessionSettings(piCli, piInput, { model: "zai/glm-5.2" })).toEqual({
      ok: true,
      value: { model: { id: "zai/glm-5.2" } },
    });
    expect(validateSessionSettings(piCli, piInput, { model: " --flag" })).toEqual({
      ok: false,
      reason: "invalid-model",
    });
  });

  test("a session kind without a native path rejects unsupported", () => {
    expect(supportsSessionSettings("codex-jsonrpc")).toBe(false);
    expect(supportsSessionSettings("claude-sdk-user-message")).toBe(true);
    expect(supportsSessionSettings("pi-rpc-prompt")).toBe(true);
    expect(
      validateSessionSettings(codexCli, codexCli.sessionMode?.input ?? { kind: "codex-jsonrpc" }, {
        model: "gpt-5.5",
      }),
    ).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("issue #456 (review F1): pi model resolution against the session catalog", () => {
  const CATALOG = [
    { provider: "zai", id: "glm-5.2" },
    { provider: "zai", id: "glm-5.3" },
    { provider: "openrouter", id: "anthropic/claude-fable-5" },
    { provider: "openrouter", id: "moonshotai/kimi-k2.6" },
    { provider: "moonshotai", id: "kimi-k2.6" },
    { provider: "moonshotai", id: "kimi-k3" },
    { provider: "moonshotai", id: "moonshotai/kimi-k2.6" },
    { provider: "together", id: "kimi-k2.6" },
  ];
  test("a session provider constrains the lookup and keeps the whole string as the id", () => {
    // The gateway id never splits: the provider stays openrouter (the
    // spawn flags' behavior; verified against pi 1.4.0's resolver).
    expect(
      resolvePiSessionModel(CATALOG, { text: "anthropic/claude-fable-5", provider: "openrouter" }),
    ).toEqual({
      status: "resolved",
      ref: { provider: "openrouter", modelId: "anthropic/claude-fable-5" },
    });
    // A bare id under the provider's pool.
    expect(resolvePiSessionModel(CATALOG, { text: "glm-5.2", provider: "zai" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
    });
    // The prefix may name the constrained provider itself.
    expect(resolvePiSessionModel(CATALOG, { text: "zai/glm-5.2", provider: "zai" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
    });
    // Case-insensitive provider and id comparison.
    expect(resolvePiSessionModel(CATALOG, { text: "GLM-5.2", provider: "ZAI" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
    });
    // An id from another provider never switches the session's provider.
    expect(resolvePiSessionModel(CATALOG, { text: "glm-5.2", provider: "openrouter" })).toEqual({
      status: "invalid",
    });
    expect(resolvePiSessionModel(CATALOG, { text: "glm-5.2", provider: "nope" })).toEqual({
      status: "invalid",
    });
  });

  test("without a provider: exact id wins, then provider/id splitting, then a unique id match", () => {
    // Exact id match wins over splitting: a gateway id that happens to
    // look like provider/model is that provider's own id.
    expect(resolvePiSessionModel(CATALOG, { text: "anthropic/claude-fable-5" })).toEqual({
      status: "resolved",
      ref: { provider: "openrouter", modelId: "anthropic/claude-fable-5" },
    });
    // Splitting: no model carries the whole string as an id.
    expect(resolvePiSessionModel(CATALOG, { text: "zai/glm-5.2" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
    });
    // An exact id spanning two providers is rescued when the split names
    // one of them (pi prefers the named provider when credentials
    // cannot choose).
    expect(resolvePiSessionModel(CATALOG, { text: "moonshotai/kimi-k2.6" })).toEqual({
      status: "resolved",
      ref: { provider: "moonshotai", modelId: "kimi-k2.6" },
    });
    // Unique id match across providers.
    expect(resolvePiSessionModel(CATALOG, { text: "kimi-k3" })).toEqual({
      status: "resolved",
      ref: { provider: "moonshotai", modelId: "kimi-k3" },
    });
    // Ambiguous across providers, with no split to name one: invalid.
    expect(resolvePiSessionModel(CATALOG, { text: "kimi-k2.6" })).toEqual({ status: "invalid" });
    // No match at all.
    expect(resolvePiSessionModel(CATALOG, { text: "nope" })).toEqual({ status: "invalid" });
    expect(resolvePiSessionModel([], { text: "glm-5.2" })).toEqual({ status: "invalid" });
    expect(resolvePiSessionModel(CATALOG, { text: "  " })).toEqual({ status: "invalid" });
  });
});

describe("issue #456 (review round 2, G4): the port of pi 1.4.0's own resolver", () => {
  test("the reviewers' two-entry catalog: the named provider wins the tie", () => {
    // OpenRouter's gateway id `moonshotai/kimi-k2.6` and Moonshot's own
    // `kimi-k2.6`: the selector is a literal id on OpenRouter AND splits
    // to name Moonshot. pi's selectReference prefers the usable named
    // provider, and every provider in the available catalog is usable,
    // so the selector resolves to Moonshot - the same model the spawn
    // flags select.
    const TWO_ENTRY = [
      { provider: "openrouter", id: "moonshotai/kimi-k2.6" },
      { provider: "moonshotai", id: "kimi-k2.6" },
    ];
    expect(resolvePiSessionModel(TWO_ENTRY, { text: "moonshotai/kimi-k2.6" })).toEqual({
      status: "resolved",
      ref: { provider: "moonshotai", modelId: "kimi-k2.6" },
    });
  });

  test("fuzzy selectors resolve: ids and display names, aliases over dated ids, greatest id first", () => {
    const FUZZY = [
      { provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "zai", id: "glm-5.2", name: "GLM 5.2 Pro" },
    ];
    // The spawn-flag complaint (round 2 F3): pi's documented CLI
    // resolver accepts a partial selector like `sonnet`.
    expect(resolvePiSessionModel(FUZZY, { text: "sonnet" })).toEqual({
      status: "resolved",
      ref: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    // A display name matches the way an id does.
    expect(resolvePiSessionModel(FUZZY, { text: "5.2 pro" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
    });
    // The same provider's newer id outranks the older in the fuzzy rank.
    const KIMI = [
      { provider: "moonshotai", id: "kimi-k2.6" },
      { provider: "moonshotai", id: "kimi-k3" },
    ];
    expect(resolvePiSessionModel(KIMI, { text: "kimi" })).toEqual({
      status: "resolved",
      ref: { provider: "moonshotai", modelId: "kimi-k3" },
    });
  });

  test("a provider's self-prefixed id resolves as itself (openrouter/free)", () => {
    const SELF = [{ provider: "openrouter", id: "openrouter/free" }];
    expect(resolvePiSessionModel(SELF, { text: "openrouter/free" })).toEqual({
      status: "resolved",
      ref: { provider: "openrouter", modelId: "openrouter/free" },
    });
  });

  test("an exact match ambiguous across providers short-circuits fuzzy matching, as in pi", () => {
    // `kimi-k2.6` sits on two providers: pi's resolver reports the
    // selector ambiguous instead of falling through to a fuzzy match
    // (which would rank `kimi-k2.9` first here).
    const AMBIGUOUS = [
      { provider: "moonshotai", id: "kimi-k2.6" },
      { provider: "together", id: "kimi-k2.6" },
      { provider: "zai", id: "kimi-k2.9" },
    ];
    expect(resolvePiSessionModel(AMBIGUOUS, { text: "kimi-k2.6" })).toEqual({
      status: "invalid",
    });
  });

  test("a `model:level` suffix parses the level; an invalid one stays part of the id", () => {
    const CATALOG = [
      { provider: "zai", id: "glm-5.2" },
      { provider: "zai", id: "glm-5.3" },
    ];
    // A valid pi thinking level splits off and rides the resolution the
    // way pi's --model parses it (the caller applies the level).
    expect(resolvePiSessionModel(CATALOG, { text: "glm-5.2:high" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
      thinkingLevel: "high",
    });
    // The suffix splits after provider/id splitting resolves the base.
    expect(resolvePiSessionModel(CATALOG, { text: "zai/glm-5.2:off" })).toEqual({
      status: "resolved",
      ref: { provider: "zai", modelId: "glm-5.2" },
      thinkingLevel: "off",
    });
    // An id that literally contains the level wins whole, before any
    // suffix parsing.
    const LITERAL = [{ provider: "xai", id: "foo:high" }];
    expect(resolvePiSessionModel(LITERAL, { text: "foo:high" })).toEqual({
      status: "resolved",
      ref: { provider: "xai", modelId: "foo:high" },
    });
    // An invalid level is not a suffix: the whole string stays the id
    // and fails (pi keeps it rather than resolving a different model).
    expect(resolvePiSessionModel(CATALOG, { text: "glm-5.2:banana" })).toEqual({
      status: "invalid",
    });
  });
});

describe("issue #456: native command encodings", () => {
  test("claude writes set_model then apply_flag_settings control requests", () => {
    expect(
      encodeSessionSettingsModel({ kind: "claude-sdk-user-message" }, "hcn-settings:1", {
        id: "claude-haiku-5-5",
      }),
    ).toBe(
      `${JSON.stringify({
        type: "control_request",
        request_id: "hcn-settings:1",
        request: { subtype: "set_model", model: "claude-haiku-5-5" },
      })}\n`,
    );
    expect(
      encodeSessionSettingsEffort({ kind: "claude-sdk-user-message" }, "hcn-settings:1:e", "low"),
    ).toBe(
      `${JSON.stringify({
        type: "control_request",
        request_id: "hcn-settings:1:e",
        request: { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
      })}\n`,
    );
  });

  test("pi writes set_model and set_thinking_level rpc commands", () => {
    expect(
      encodeSessionSettingsModel({ kind: "pi-rpc-prompt" }, "hcn-settings:1", {
        id: "zai/glm-5.2",
        pi: { provider: "zai", modelId: "glm-5.2" },
      }),
    ).toBe(
      `${JSON.stringify({
        id: "hcn-settings:1",
        type: "set_model",
        provider: "zai",
        modelId: "glm-5.2",
      })}\n`,
    );
    expect(encodeSessionSettingsEffort({ kind: "pi-rpc-prompt" }, "hcn-settings:1:e", "low")).toBe(
      `${JSON.stringify({ id: "hcn-settings:1:e", type: "set_thinking_level", level: "low" })}\n`,
    );
  });

  test("pi writes the catalog read before a model and the state readback after the writes", () => {
    expect(encodeSessionSettingsCatalog({ kind: "pi-rpc-prompt" }, "hcn-settings:1:c")).toBe(
      `${JSON.stringify({ id: "hcn-settings:1:c", type: "get_available_models" })}\n`,
    );
    expect(encodeSessionSettingsState({ kind: "pi-rpc-prompt" }, "hcn-settings:1:s")).toBe(
      `${JSON.stringify({ id: "hcn-settings:1:s", type: "get_state" })}\n`,
    );
    // Claude has no catalog or readback phase.
    expect(encodeSessionSettingsCatalog({ kind: "claude-sdk-user-message" }, "x")).toBe("");
    expect(encodeSessionSettingsState({ kind: "claude-sdk-user-message" }, "x")).toBe("");
  });
});

describe("issue #456: answer decoding", () => {
  const parse = (value: object): Record<string, unknown> =>
    JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

  test("claude: a set_model confirmation carries the model; an effort answer carries none", () => {
    expect(
      claudeSettingsAnswerOf(
        parse({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "hcn-settings:1",
            response: { model: "claude-haiku-5-5" },
          },
        }),
      ),
    ).toEqual({ ok: true, model: "claude-haiku-5-5" });
    expect(
      claudeSettingsAnswerOf(
        parse({
          type: "control_response",
          response: { subtype: "success", request_id: "hcn-settings:1:e" },
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      claudeSettingsAnswerOf(
        parse({
          type: "control_response",
          response: { subtype: "error", request_id: "hcn-settings:1", error: "no" },
        }),
      ),
    ).toEqual({ ok: false });
  });

  test("pi: set_model confirms data.id; the command must match the id's part (review F8)", () => {
    expect(
      piSettingsAnswerOf(
        parse({
          id: "hcn-settings:1",
          type: "response",
          command: "set_model",
          success: true,
          data: { id: "fixture-model-2", provider: "fixture" },
        }),
        "model",
      ),
    ).toEqual({ ok: true, model: "fixture-model-2" });
    expect(
      piSettingsAnswerOf(
        parse({
          id: "hcn-settings:1:e",
          type: "response",
          command: "set_thinking_level",
          success: true,
        }),
        "effort",
      ),
    ).toEqual({ ok: true });
    // A thinking response to a model id is not the model's answer.
    expect(
      piSettingsAnswerOf(
        parse({
          id: "hcn-settings:1",
          type: "response",
          command: "set_thinking_level",
          success: true,
        }),
        "model",
      ),
    ).toBeNull();
    // A model response to an effort id is not the effort's answer either.
    expect(
      piSettingsAnswerOf(
        parse({
          id: "hcn-settings:1:e",
          type: "response",
          command: "set_model",
          success: true,
          data: { id: "glm-5.2" },
        }),
        "effort",
      ),
    ).toBeNull();
    expect(
      piSettingsAnswerOf(
        parse({
          id: "hcn-settings:1",
          type: "response",
          command: "get_state",
          success: true,
        }),
        "model",
      ),
    ).toBeNull();
    expect(
      piSettingsAnswerOf(
        parse({
          id: "hcn-settings:1",
          type: "response",
          command: "set_model",
          success: false,
          error: "unknown model",
        }),
        "model",
      ),
    ).toEqual({ ok: false });
  });

  test("decodeSessionRecord names the settings answers on both harnesses", () => {
    expect(
      decodeSessionRecord(
        claudeCode,
        parse({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "hcn-settings:3",
            response: { model: "claude-haiku-5-5" },
          },
        }),
      ),
    ).toEqual({
      kind: "settings-answered",
      token: "3",
      part: "model",
      ok: true,
      model: "claude-haiku-5-5",
    });
    expect(
      decodeSessionRecord(
        piCli,
        parse({
          id: "hcn-settings:4:e",
          type: "response",
          command: "set_thinking_level",
          success: true,
        }),
      ),
    ).toEqual({ kind: "settings-answered", token: "4", part: "effort", ok: true });
    expect(
      decodeSessionRecord(
        piCli,
        parse({
          id: "hcn-settings:5:c",
          type: "response",
          command: "get_available_models",
          success: true,
          data: {
            models: [{ id: "glm-5.2", provider: "zai" }, { id: "", provider: "zai" }, "junk"],
          },
        }),
      ),
    ).toEqual({
      kind: "settings-answered",
      token: "5",
      part: "catalog",
      ok: true,
      models: [{ provider: "zai", id: "glm-5.2" }],
    });
    expect(
      decodeSessionRecord(
        piCli,
        parse({
          id: "hcn-settings:6:s",
          type: "response",
          command: "get_state",
          success: true,
          data: { model: { provider: "zai", id: "glm-5.2" }, thinkingLevel: "high" },
        }),
      ),
    ).toEqual({
      kind: "settings-answered",
      token: "6",
      part: "state",
      ok: true,
      state: { model: { provider: "zai", modelId: "glm-5.2" }, thinkingLevel: "high" },
    });
    // Answers to commands hcn never wrote settle nothing.
    expect(
      decodeSessionRecord(
        piCli,
        parse({ id: "other", type: "response", command: "set_model", success: true }),
      ),
    ).toEqual({ kind: "ignored" });
    // A response whose command does not match its settings id's part is
    // not that part's answer.
    expect(
      decodeSessionRecord(
        piCli,
        parse({
          id: "hcn-settings:7",
          type: "response",
          command: "set_thinking_level",
          success: true,
        }),
      ),
    ).toEqual({ kind: "ignored" });
  });
});
