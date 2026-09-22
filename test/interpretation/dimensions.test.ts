import { describe, expect, test } from "vitest";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { isInteractive } from "../../src/interpretation/presence.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("presence / isInteractive (claude)", () => {
  const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

  test("a live interactive process resuming the id is presence", () => {
    const rows = [{ argv: "vim notes.md" }, { argv: `claude --resume ${sid}` }];
    expect(isInteractive(claudeCode, sid, rows)).toBe(true);
  });

  test("no matching process, or only headless -p processes, is not presence", () => {
    expect(isInteractive(claudeCode, sid, [{ argv: "claude" }])).toBe(false);
    expect(isInteractive(claudeCode, sid, [{ argv: `claude -p --resume ${sid}` }])).toBe(false);
  });
});

describe("flag dimensions (claude)", () => {
  test("stdin policy and tools flag come from descriptor data", () => {
    expect(claudeCode.stdin).toBe("inherit");
    expect(claudeCode.tools.includeFlag).toBe("--allowedTools");
    // Provider and discovery flags live in turnOptions
    expect(claudeCode.turnOptions.effort).toEqual({
      kind: "effort",
      render: { kind: "flag-value", flag: "--effort" },
    });
    const disc = claudeCode.turnOptions.discovery as Extract<
      (typeof claudeCode.turnOptions)["discovery"],
      { kind: "discovery" }
    >;
    expect(disc?.facets.extensions).toEqual({
      polarity: "disables",
      render: { kind: "flag-list", flags: ["--setting-sources", "project"] },
    });
  });
});

describe("capabilitiesOf (claude)", () => {
  test("returns the full capability shape per (harness, model, mode)", () => {
    const caps = capabilitiesOf(claudeCode, "claude-opus-5", "headless-session");
    expect(caps).toEqual({
      vision: true,
      images: true,
      streaming: "token",
      session: true,
      source: "curated",
      confidence: "medium",
      escalation: {
        supported: true,
        source: "runtime-verified",
        confidence: "high",
        observedOn: claudeCode.escalation.observedOn,
      },
    });
  });

  test("a descriptor whose observation is behind verifiedAgainst reports lower confidence than one that is current", () => {
    const stale = capabilitiesOf(
      {
        ...codexCli,
        escalation: {
          ...codexCli.escalation,
          observedOn: { harness: "codex", model: "", version: "0.146.1", date: "2026-08-19" },
        },
      },
      "",
      "headless-turn",
    );
    const current = capabilitiesOf(claudeCode, "", "headless-turn");
    const piCaps = capabilitiesOf(piCli, "", "headless-turn");
    expect(stale.escalation.confidence).toBe("medium");
    expect(stale.escalation.source).toBe("runtime-verified");
    expect(current.escalation.confidence).toBe("high");
    expect(current.escalation.source).toBe("runtime-verified");
    expect(piCaps.escalation.confidence).toBe("high");
    // stale is strictly lower than current
    expect(["none", "medium", "high"].indexOf(stale.escalation.confidence)).toBeLessThan(
      ["none", "medium", "high"].indexOf(current.escalation.confidence),
    );
  });

  test("interactive mode narrows streaming to message granularity", () => {
    expect(capabilitiesOf(claudeCode, "claude-opus-5", "interactive").streaming).toBe("message");
  });

  test("an unknown model degrades to unknown source, no streaming claim", () => {
    const caps = capabilitiesOf(claudeCode, "mystery-model", "headless-session");
    expect(caps.source).toBe("unknown");
    expect(caps.confidence).toBe("none");
    expect(caps.streaming).toBe("none");
    expect(caps.vision).toBe(false);
  });
});

describe("stdin close-required policy (pi-shaped descriptors)", () => {
  test("a descriptor declaring close-required reports it - backgrounded spawns must close stdin", () => {
    const piShaped = { ...claudeCode, stdin: "close-required" as const };
    expect(piShaped.stdin).toBe("close-required");
  });
});

describe("observed model provenance (pi)", () => {
  test("the descriptor's escalation.observedOn stays the probe record - the observed runtime model rides the identity event, not the descriptor", async () => {
    // Lucid's settings projection takes the LAST identity event and reads
    // capabilities.escalation.observedOn.model; the static descriptor
    // record below is escalation-probe provenance only.
    expect(piCli.escalation.observedOn).toEqual({
      harness: "pi",
      model: "zai/glm-5.2",
      version: "0.87.0",
      date: "2026-09-22",
    });
    // The static probe record above is untouched by design: the decoder
    // fills the re-emitted identity's observedOn from the stream
    // attestation, and this block pins that separation.
    const { decodeParsed, freshDecodeState } = await import("../../src/execution/decode.js");
    const sid = "11111111-2222-4333-8444-555555555555";
    const state = freshDecodeState();
    const events = [
      { type: "session", version: 3, id: sid },
      {
        type: "message_start",
        message: { role: "assistant", provider: "zai", model: "glm-5.3" },
      },
    ].flatMap((line) => decodeParsed(piCli, line, state, ""));
    const identities = events.filter((e) => e.kind === "identity");
    expect(identities).toHaveLength(2);
    const last = identities.at(-1) as {
      sessionId: string;
      capabilities: { escalation: { observedOn?: { model?: string } } };
    };
    expect(last.sessionId).toBe(sid);
    expect(last.capabilities.escalation.observedOn?.model).toBe("glm-5.3");
  });

  test("the observed model is display only - validation still answers from the static registry", async () => {
    const { validateModel } = await import("../../src/interpretation/vocabulary.js");
    // Curated baseline member: accepted as curated.
    expect(validateModel(piCli, "zai/glm-5.2")).toEqual({ ok: true, id: "zai/glm-5.2" });
    // Clean unknown selector: accepted by the D-008 extensibility rule,
    // not by anything observed on a stream.
    expect(validateModel(piCli, "glm-5.3")).toEqual({ ok: true, id: "glm-5.3" });
    // Dirty selector: still refused even though a harness once attested it.
    expect(validateModel(piCli, "glm-5.3; rm -rf ~").ok).toBe(false);
  });
});

describe("presence hardening (review regressions)", () => {
  const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

  test("ps reports resolved paths - basename matching still sees presence", () => {
    expect(
      isInteractive(claudeCode, sid, [{ argv: `/Users/kevin/.local/bin/claude --resume ${sid}` }]),
    ).toBe(true);
  });

  test("an id-shaped word in prompt text is not presence - the id must follow an id-bearing flag", () => {
    expect(isInteractive(claudeCode, sid, [{ argv: `claude --model opus ${sid}` }])).toBe(false);
  });
});
