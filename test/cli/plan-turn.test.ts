/**
 * RFC-02 change 10: planTurn owns the parse-refuse-resolve-build protocol.
 * The argv it returns is the argv the runner spawns, for every harness,
 * skill tokens and passthrough included, so the inspect preview and the
 * run spawn line agree by construction.
 */
import { describe, expect, test } from "vitest";
import { parseRunExtra, resumeIdOf } from "../../src/cli/args.js";
import { type PlanDeps, planTurn } from "../../src/cli/plan-turn.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const deps: PlanDeps = {
  loadUserConfig: () => ({ config: { effort: "high" } }),
  loadProjectConfig: () => null,
  listKnownSkills: () => ["hcn", "other"],
  resolveSkillNames: (names) => names.map((n) => `/registry/${n}`),
  readPrompt: async (args) => ({
    prompt: args.promptFlag ?? args.positionalPrompt ?? "",
    source: args.promptFlag !== undefined ? "prompt-flag" : "positional",
  }),
};

const spawnedArgv = async (
  h: typeof claudeCode,
  options: Parameters<typeof streamTurn>[1],
): Promise<readonly string[]> => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const turn = streamTurn(h, options, {
    spawn: spawner.spawn,
    clock: new FakeClock(),
    signal: fakeSignal().signal,
  });
  proc.exit(0);
  for await (const _event of turn) {
    // drain
  }
  return spawner.calls[0]?.argv ?? [];
};

describe("planTurn", () => {
  // Every harness plans a tail at its descriptor placement with no
  // separator (ADR 0003): trailing native flags parsed on all five
  // harnesses once hcn's bare `--` is gone (probed 2026-09-17).
  test.each([claudeCode, codexCli, piCli, museCode])(
    "$name: the plan's argv is the argv the runner spawns",
    async (h) => {
      const args = ["--prompt", "hi", "--questions", "none", "--", "--native-flag"];
      if (h.skills !== null) args.unshift("--skills", "hcn");
      const outcome = await planTurn(h, args, { command: "run" }, deps);
      expect(outcome.kind).toBe("plan");
      if (outcome.kind !== "plan") return;
      const spawned = await spawnedArgv(h, outcome.plan.options);
      expect(spawned).toEqual(outcome.plan.argv);
      expect(outcome.plan.argv.at(-1)).toBe("--native-flag");
      expect(
        outcome.plan.provenance.some((p) => p.key === "effort" && p.tier === "user-config"),
      ).toBe(true);
    },
  );

  // A single-dash native flag after `--` is passthrough, not a positional
  // prompt: `hcn run codex "hi" -- -c key=value` must plan, not refuse as
  // prompt-flag injection.
  test("a single-dash native flag after -- plans beside a positional prompt", async () => {
    const outcome = await planTurn(
      codexCli,
      ["hi", "--", "-c", "model_auto_compact_token_limit=20000"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    expect(outcome.plan.argv.slice(-2)).toEqual(["-c", "model_auto_compact_token_limit=20000"]);
  });

  test("a single-dash positional prompt before -- is still refused", async () => {
    const outcome = await planTurn(codexCli, ["-bad", "--", "-c", "x=1"], { command: "run" }, deps);
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.issue).toBe("prompt-flag-injection");
  });

  test("a resume plan carries no launch provenance but still resolves behaviour", async () => {
    const outcome = await planTurn(
      claudeCode,
      ["--prompt", "hi", "--resume", "0199a4c5-1111-2222-3333-444455556666"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    expect(outcome.plan.provenance).toEqual([]);
    expect(outcome.plan.behavior.questions).toEqual({ value: "ask", tier: "default" });
    expect(outcome.plan.argv).toContain("--resume");
  });

  test("a refusal comes back structured, with the json decision made", async () => {
    const outcome = await planTurn(
      claudeCode,
      ["--json", "--prompt", "hi", "--model", "no-such-model"],
      { command: "run" },
      deps,
    );
    expect(outcome).toMatchObject({
      kind: "refusal",
      wantJson: true,
      refusal: { issue: "unknown-model" },
    });
  });

  test("the resume alias check exists once and refuses both spellings together", () => {
    expect(resumeIdOf({ resume: "a" })).toBe("a");
    expect(resumeIdOf({ "session-id": "b" })).toBe("b");
    expect(() => resumeIdOf({ resume: "a", "session-id": "b" })).toThrow(/not both/);
  });

  test("resume-last joins the mutual exclusion: most-recent and a named id refuse together (RFC-06 Phase 2)", () => {
    expect(resumeIdOf({ "resume-last": true })).toBeUndefined();
    expect(() => resumeIdOf({ resume: "a", "resume-last": true })).toThrow(/not both/);
    expect(() => resumeIdOf({ "session-id": "b", "resume-last": true })).toThrow(/not both/);
    expect(parseRunExtra({ "resume-last": true }).resumeLast).toBe(true);
    expect(parseRunExtra({}).resumeLast).toBeUndefined();
  });
});

/**
 * Issue #435: the toolMap is vocabulary, not a launch default. A resumed
 * turn renders an explicit --tools grant with the same native names it
 * renders on launch, so the merged map rides the resume path too - while
 * the launch defaults (config model, effort, tools grant, profile flags)
 * stay off the resume, as the launch-only rule says.
 */
describe("resume renders the merged toolMap (issue #435)", () => {
  test("a Pi toolMap does not block a Codex resume with native approvals", async () => {
    const sessionId = "0199a4c5-1111-2222-3333-444455556666";
    const fingerprint = "a".repeat(64);
    const outcome = await planTurn(
      codexCli,
      [
        "--json",
        "--prompt",
        "hi",
        "--resume",
        sessionId,
        "--cwd",
        "/tmp",
        "--native-approvals",
        "--native-settings-fingerprint",
        fingerprint,
      ],
      { command: "run" },
      {
        ...deps,
        loadUserConfig: () => ({ config: { toolMap: { pi: { "web-search": "web_search" } } } }),
        inspectNativeSettings: () => ({
          v: 1,
          status: "available",
          continuation: "native-approvals",
          harness: "codex",
          source: "codex-rollout-v1",
          cwd: "/tmp",
          sessionId,
          fingerprint,
          model: "saved-model",
          provider: "saved-provider",
          effort: "high",
          permissions: {
            status: "recorded",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            filesystem: "read-only",
            network: "restricted",
          },
        }),
      },
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    expect(outcome.plan.argv).toEqual(["codex", "app-server", "--listen", "stdio://"]);
  });

  const toolMapDeps: PlanDeps = {
    ...deps,
    loadUserConfig: () => ({
      config: {
        toolMap: { pi: { "web-search": "web_search", "web-fetch": "web_fetch" } },
        model: "zai/glm-5.2",
        effort: "high",
        tools: ["read"],
      },
    }),
    loadProjectConfig: () => ({
      config: { toolMap: { pi: { "web-search": "project_web_search" } } },
    }),
  };

  test.each([
    { label: "a named resume", resume: ["--resume", "0199a4c5-1111-2222-3333-444455556666"] },
    { label: "resume-last", resume: ["--resume-last"] },
  ])("$label renders the merged toolMap for an explicit grant", async ({ resume }) => {
    const outcome = await planTurn(
      piCli,
      ["--prompt", "hi", "--tools", "web-fetch,web-search", ...resume],
      { command: "run" },
      toolMapDeps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const argv = outcome.plan.argv;
    const toolsAt = argv.indexOf("--tools");
    expect(toolsAt).toBeGreaterThan(-1);
    // The project tier overrides the user's web-search mapping; web-fetch
    // keeps the user's, so one grant renders both tiers' entries.
    expect(argv[toolsAt + 1]).toBe("web_fetch,project_web_search");
    // The map is vocabulary: it carries no provenance of its own.
    expect(outcome.plan.provenance).toEqual([]);
    // No launch default rides the resume: the config model, effort and
    // tools grant stay out, and the profile flags never render.
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("zai/glm-5.2");
    expect(argv).not.toContain("--thinking");
    expect(argv).not.toContain("high");
    expect(argv[toolsAt + 1]).not.toContain("read");
  });
});

test("tool-free isolation removes native and discovered tools and refuses resumed or widened runs", async () => {
  const outcome = await planTurn(
    claudeCode,
    ["--isolation", "tool-free", "--model", "opus", "--effort", "high", "Name this prompt"],
    { command: "run" },
    deps,
  );
  expect(outcome.kind).toBe("plan");
  if (outcome.kind !== "plan") throw new Error("Expected isolated plan");
  expect(outcome.plan.argv).toContain("--bare");
  expect(
    outcome.plan.argv.slice(
      outcome.plan.argv.indexOf("--tools"),
      outcome.plan.argv.indexOf("--tools") + 2,
    ),
  ).toEqual(["--tools", ""]);
  expect(outcome.plan.argv).toContain("--strict-mcp-config");
  expect(outcome.plan.argv).toContain("mcp__*");
  for (const tail of [
    ["--resume", "eb04301d-8756-4a8b-ae3e-aac0e71f7265"],
    ["--tools", "shell"],
    ["--", "--tools", "Bash"],
  ]) {
    expect(
      (
        await planTurn(
          claudeCode,
          ["--isolation", "tool-free", "Name this prompt", ...tail],
          { command: "run" },
          deps,
        )
      ).kind,
    ).toBe("refusal");
  }
  expect(
    (
      await planTurn(
        codexCli,
        ["--isolation", "tool-free", "Name this prompt"],
        { command: "run" },
        deps,
      )
    ).kind,
  ).toBe("refusal");
});

test("tool-free overrides configured grants but refuses explicit discovery or grants before loading skills", async () => {
  const configured: PlanDeps = {
    ...deps,
    loadUserConfig: () => ({
      config: {
        tools: ["shell"],
        autonomy: true,
        discovery: { extensions: false },
        effort: "high",
      },
    }),
    loadProjectConfig: () => ({ config: { tools: ["read"] } }),
  };
  const outcome = await planTurn(
    claudeCode,
    ["--isolation", "tool-free", "Name this"],
    { command: "run" },
    configured,
  );
  expect(outcome.kind).toBe("plan");
  if (outcome.kind !== "plan") throw new Error("Expected isolated plan");
  expect(outcome.plan.argv).not.toContain("--allowedTools");
  expect(outcome.plan.argv).not.toContain("--dangerously-skip-permissions");
  expect(outcome.plan.argv).not.toContain("--setting-sources");
  const noScan: PlanDeps = {
    ...deps,
    resolveSkillNames: () => {
      throw new Error("Must refuse before scanning skills");
    },
    listKnownSkills: () => {
      throw new Error("Must refuse before scanning skills");
    },
  };
  for (const flags of [
    ["--skills", "hcn"],
    ["--no-extensions"],
    ["--access", "read"],
    ["--autonomy"],
    ["--exclude-tools", "shell"],
  ]) {
    const refused = await planTurn(
      claudeCode,
      ["--isolation", "tool-free", "Name this", ...flags],
      { command: "run" },
      noScan,
    );
    expect(refused.kind).toBe("refusal");
    if (refused.kind === "refusal")
      expect(refused.refusal.issue).toBe("mutually-exclusive-options");
  }
});
