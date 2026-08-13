import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildResumeArgv,
  streamingGranularityOf,
} from "../../src/interpretation/argv.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { stdinPolicyOf } from "../../src/interpretation/dimensions.js";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { parseResumeCommand } from "../../src/interpretation/parse-resume.js";
import { isInteractive } from "../../src/interpretation/presence.js";
import { storePath } from "../../src/interpretation/store.js";
import { validateEffort, validateModel } from "../../src/interpretation/vocabulary.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { defaultDescriptors, parseOverrides } from "../../src/knowledge/overrides.js";
import { piCli } from "../../src/knowledge/pi.js";

const uuid = "0199a4c5-1111-2222-3333-444455556666";

describe("codex descriptor (v1 scars)", () => {
  test("thread identity is harness-minted, discovered from stdout-jsonl thread.started", () => {
    const decoded = decodeIdentity(codexCli, { type: "thread.started", thread_id: uuid }, null);
    expect(decoded).toMatchObject({ sessionId: uuid, identity: uuid, outcome: "announced" });
  });

  test("a discovered id differing from a requested one is NOT a rotation - minting is codex's job", () => {
    const decoded = decodeIdentity(
      codexCli,
      { type: "thread.started", thread_id: uuid },
      null,
      "some-other-id",
    );
    expect(decoded.outcome).toBe("announced");
  });

  test("resumeLast surface is --last, and exec resume <id> parses positionally after the subcommand", () => {
    expect(codexCli.resumeLast).toEqual({ flag: "--last" });
    expect(parseResumeCommand([codexCli], `codex exec resume ${uuid} --json`)).toMatchObject({
      harness: "codex",
      sessionId: uuid,
    });
    expect(parseResumeCommand([codexCli], `codex exec --json "resume ${uuid}"`)).toBeNull();
  });

  test("exec --json is message granularity - codex has no token mode to pin", () => {
    const argv = buildLaunchArgv(codexCli, { prompt: "hi" });
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(streamingGranularityOf(codexCli, argv)).toBe("message");
  });
});

describe("pi descriptor (v1 scars)", () => {
  test("pi turnOptions and the stdin close rule come from data", () => {
    expect(piCli.turnOptions.provider).toEqual({
      kind: "selector",
      render: { kind: "flag-value", flag: "--provider" },
    });
    const piDisc = piCli.turnOptions.discovery as Extract<
      (typeof piCli.turnOptions)["discovery"],
      { kind: "discovery" }
    >;
    expect(piDisc?.facets.tools).toEqual({
      polarity: "disables",
      render: { kind: "flag-list", flags: ["-nt"] },
    });
    expect(piDisc?.facets.instructionFiles).toEqual({
      polarity: "disables",
      render: { kind: "flag-list", flags: ["-nc"] },
    });
    expect(piCli.turnOptions.effort).toEqual({
      kind: "effort",
      render: { kind: "flag-value", flag: "--thinking" },
    });
    expect(stdinPolicyOf(piCli)).toBe("close-required");
  });

  test("the model registry is runtime-extensible: unknown models validate for argv, but capabilities degrade", () => {
    // D-008: pi's registry is runtime-extensible - refusing an unregistered
    // model would block a model the CLI happily serves.
    expect(validateModel(piCli, "meta/muse-spark-1.2-contributor")).toEqual({
      ok: true,
      id: "meta/muse-spark-1.2-contributor",
    });
    // But capability claims for an un-curated model degrade to unknown.
    const caps = capabilitiesOf(piCli, "meta/muse-spark-1.2-contributor", "headless-turn");
    expect(caps.source).toBe("unknown");
    expect(caps.confidence).toBe("none");
    // Garbage is still garbage, extensible or not.
    expect(validateModel(piCli, "--yolo").ok).toBe(false);
    expect(validateModel(piCli, "bad\nmodel").ok).toBe(false);
  });

  test("curated pi models keep curated capabilities", () => {
    expect(capabilitiesOf(piCli, "zai/glm-5.2", "headless-turn").source).toBe("curated");
  });
});

describe("muse descriptor (v1 scars)", () => {
  test("resume is positional: muse resume <id>, anchored at position 1", () => {
    expect(parseResumeCommand([museCode], `muse resume ${uuid}`)).toMatchObject({
      harness: "muse",
      sessionId: uuid,
    });
    expect(parseResumeCommand([museCode], `muse exec "resume ${uuid}"`)).toBeNull();
  });

  test("unattended mode is --yolo", () => {
    expect(museCode.autonomy).toEqual({ flag: "--yolo" });
  });
});

describe("registry", () => {
  test("all four harnesses have code defaults", () => {
    const all = defaultDescriptors();
    expect(Object.keys(all).sort()).toEqual(["claude", "codex", "muse", "pi"]);
  });
});

describe("M2.3 boundary-review regression pins", () => {
  test("positional resume BUILDS runnable argv: codex exec resume <id> ...", () => {
    const argv = buildResumeArgv(codexCli, { sessionId: uuid, prompt: "go" });
    expect(argv.slice(0, 4)).toEqual(["codex", "exec", "resume", uuid]);
    expect(argv).toContain("--json");
  });

  test("muse resumes headlessly via exec --session-id; the positional spelling is parse-only", () => {
    const argv = buildResumeArgv(museCode, { sessionId: uuid, prompt: "go" });
    expect(argv.slice(0, 4)).toEqual(["muse", "exec", "--session-id", uuid]);
    // The pasted interactive spelling still parses.
    expect(parseResumeCommand([museCode], `muse resume ${uuid}`)).toMatchObject({
      sessionId: uuid,
    });
  });

  test("root options before the subcommand do not kill resume recognition", () => {
    expect(parseResumeCommand([museCode], `muse --provider meta resume ${uuid}`)).toMatchObject({
      sessionId: uuid,
    });
    expect(parseResumeCommand([codexCli], `codex --cd /x exec resume ${uuid}`)).toMatchObject({
      sessionId: uuid,
    });
  });

  test("a recorded --last resume parses as a distinguishable resume-last verdict", () => {
    expect(parseResumeCommand([codexCli], 'codex exec resume --last "go"')).toEqual({
      harness: "codex",
      resumeLast: true,
      autonomy: false,
    });
    expect(parseResumeCommand([museCode], "muse resume --last")).toMatchObject({
      resumeLast: true,
    });
  });

  test("muse identity decodes the real nested stream.id shape", () => {
    const decoded = decodeIdentity(
      museCode,
      { payload_type: "session.run.linked", stream: { id: uuid } },
      null,
    );
    expect(decoded).toMatchObject({ sessionId: uuid, outcome: "announced" });
  });

  test("pi identity reads the v3 session header field `id`", () => {
    expect(decodeIdentity(piCli, { type: "session", version: 3, id: uuid }, null)).toMatchObject({
      sessionId: uuid,
      outcome: "announced",
    });
  });

  test("granularity: bare codex exec (no --json) emits nothing structured", () => {
    expect(streamingGranularityOf(codexCli, ["codex", "exec", "hi"])).toBe("none");
  });

  test("validateModel survives __proto__ and constructor selectors", () => {
    // The original bug was a TypeError crash via the alias prototype chain;
    // a clean refusal (leading underscore fails the selector grammar) is
    // the correct outcome.
    expect(() => validateModel(piCli, "__proto__")).not.toThrow();
    expect(validateModel(piCli, "__proto__").ok).toBe(false);
    expect(validateModel(claudeCode, "constructor").ok).toBe(false);
    expect(validateModel(piCli, "a b; rm -rf /").ok).toBe(false);
    expect(validateModel(piCli, "x".repeat(200)).ok).toBe(false);
  });

  test("codex effort ladders are per-model", () => {
    expect(validateEffort(codexCli, "ultra", "gpt-5.5").ok).toBe(false);
    expect(validateEffort(codexCli, "minimal", "gpt-5.6-sol").ok).toBe(false);
    expect(validateEffort(codexCli, "high", "gpt-5.5").ok).toBe(true);
    expect(validateEffort(codexCli, "ultra", "gpt-5.6-sol").ok).toBe(true);
  });

  test("every registered descriptor is deeply frozen", () => {
    for (const d of Object.values(defaultDescriptors())) {
      expect(Object.isFrozen(d)).toBe(true);
      expect(Object.isFrozen(d.vocabulary)).toBe(true);
      expect(Object.isFrozen(d.capabilities.streamingByMode)).toBe(true);
    }
  });
});

describe("phase-2 codex-review regression pins", () => {
  test("codex resume argv never inherits exec-only launch flags", () => {
    const argv = buildResumeArgv(codexCli, { sessionId: uuid, prompt: "go" });
    expect(argv).not.toContain("--sandbox");
    expect(argv).not.toContain("workspace-write");
    expect(argv.slice(0, 5)).toEqual(["codex", "exec", "resume", uuid, "--json"]);
  });

  test("an option value spelled 'resume' is not a resume command", () => {
    expect(parseResumeCommand([museCode], `muse exec --workspace resume ${uuid}`)).toBeNull();
  });

  test("muse interactive presence recognizes the positional resume argv", () => {
    expect(isInteractive(museCode, uuid, [{ argv: `muse resume ${uuid}` }])).toBe(true);
  });

  test("a discriminated announcement with a null id is malformed, not unrelated output", () => {
    expect(
      decodeIdentity(claudeCode, { type: "system", subtype: "init", session_id: null }, null)
        .outcome,
    ).toBe("malformed");
    // Undiscriminated descriptors (muse matches any record) keep 'none'.
    expect(decodeIdentity(museCode, { payload_type: "run.output.delta" }, null).outcome).toBe(
      "none",
    );
  });

  test("pi store slug matches the on-disk double-dash-wrapped form", () => {
    expect(
      storePath(piCli, { home: "/Users/kevin", cwd: "/Users/kevin/dev/ideas", sessionId: uuid }),
    ).toBe("/Users/kevin/.pi/sessions/--Users-kevin-dev-ideas--");
  });

  test("override pins arrays refuse null or wrong-shaped elements", () => {
    expect(() => parseOverrides('{"codex":{"output":{"pins":[null]}}}', "/tmp/o.json")).toThrow();
    expect(() => parseOverrides('{"codex":{"discoveryDisableFlags":[42]}}', "/tmp/o.json")).toThrow(
      /has no field/,
    );
  });
});

describe("resume-of-missing behavior (verified live, #5)", () => {
  test("claude and codex error on an unknown session; pi and muse create-if-missing", () => {
    expect(claudeCode.resume.onMissing).toBe("error");
    expect(codexCli.resume.onMissing).toBe("error");
    expect(piCli.resume.onMissing).toBe("create");
    expect(museCode.resume.onMissing).toBe("create");
  });
});

describe("version anchor (harness-update pipeline)", () => {
  test("every descriptor records the CLI version its facts were verified against", () => {
    for (const d of [claudeCode, codexCli, piCli, museCode]) {
      expect(d.verifiedAgainst).toMatch(/^\d+\.\d+/); // a version string
    }
  });
});
