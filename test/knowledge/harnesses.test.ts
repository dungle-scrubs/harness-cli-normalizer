import { describe, expect, test } from "vitest";
import { buildLaunchArgv, streamingGranularityOf } from "../../src/interpretation/argv.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import {
  discoveryDisableFlagsOf,
  providerFlagOf,
  stdinPolicyOf,
} from "../../src/interpretation/dimensions.js";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { parseResumeCommand } from "../../src/interpretation/parse-resume.js";
import { validateModel } from "../../src/interpretation/vocabulary.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";
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
  test("provider, discovery-disable flags, and the stdin close rule come from data", () => {
    expect(providerFlagOf(piCli)).toBe("--provider");
    expect(discoveryDisableFlagsOf(piCli)).toEqual(["-nt", "-nc", "-ne", "-ns"]);
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
