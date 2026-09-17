/**
 * RFC-06 Phase 3: --resume-last execution and CLI seams.
 * CLI-level pins through planTurn/dispatch (plan refusals, session
 * refusal); the runner warning gate and identity signal live at the
 * streamTurn seam (test/execution/stream-turn-resume-last.test.ts).
 * Never runs a real harness CLI.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCommonFlags, parseRunExtra } from "../../src/cli/args.js";
import { dispatch } from "../../src/cli/index.js";
import { type PlanDeps, planTurn } from "../../src/cli/plan-turn.js";
import { createRenderState, renderEvent } from "../../src/cli/render.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";

const deps: PlanDeps = {
  loadUserConfig: () => null,
  loadProjectConfig: () => null,
  listKnownSkills: () => [],
  resolveSkillNames: (names) => [...names],
  readPrompt: async (args) => ({
    prompt: args.promptFlag ?? args.positionalPrompt ?? "",
    source: args.promptFlag !== undefined ? "prompt-flag" : "positional",
  }),
};

// Same capture shape as cli.test.ts and resume-guard-cli.test.ts: the
// exit code never leaks (Bun keeps a prior code when set to undefined,
// so restore to 0 explicitly and hand the saved code back after).
const captureDispatch = async (
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  // The --json path awaits the write callback (drain); fire it, or the
  // captured stream stalls the turn it is trying to observe.
  const capture =
    (sink: (text: string) => void) =>
    (...args: unknown[]): boolean => {
      sink(String(args[0]));
      const done = args.find((a) => typeof a === "function") as
        | ((error?: Error) => void)
        | undefined;
      if (done !== undefined) done();
      return true;
    };
  (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = capture(
    (text) => {
      stdout += text;
    },
  );
  (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = capture(
    (text) => {
      stderr += text;
    },
  );
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const originalExit = process.exit;
  let exited: number | undefined;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exited = code;
    process.exitCode = code;
    throw new Error(`process.exit:${code}`);
  }) as unknown as typeof process.exit;
  let caught: unknown;
  try {
    await dispatch(argv);
  } catch (err) {
    caught = err;
    if (!(err instanceof Error && err.message.startsWith("process.exit:"))) throw err;
  }
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  process.exit = originalExit;
  const rawCode = exited ?? process.exitCode;
  const code = rawCode === 0 ? undefined : rawCode;
  process.exitCode = prevExit;
  if (caught && !(caught instanceof Error && caught.message.startsWith("process.exit:")))
    throw caught;
  return { stdout, stderr, exitCode: code };
};

describe("RFC-06 Phase 3: --resume-last flag plumbing", () => {
  test("parseCommonFlags accepts --resume-last as a boolean flag", () => {
    const parsed = parseCommonFlags(["--resume-last", "--prompt", "hi"]);
    expect(parsed.values["resume-last"]).toBe(true);
    expect(parseRunExtra(parsed.values as Record<string, unknown>).resumeLast).toBe(true);
  });
});

describe("RFC-06 Phase 3: planTurn refusals", () => {
  test("muse --resume-last refuses unsupported-option/resumeLast before skill scan or argv build", async () => {
    const noScan: PlanDeps = {
      ...deps,
      resolveSkillNames: () => {
        throw new Error("Must refuse before scanning skills");
      },
      listKnownSkills: () => {
        throw new Error("Must refuse before scanning skills");
      },
    };
    const outcome = await planTurn(
      museCode,
      ["--prompt", "hi", "--resume-last"],
      { command: "run" },
      noScan,
    );
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.issue).toBe("unsupported-option");
    expect(outcome.refusal.option).toBe("resumeLast");
  });

  test("cursor --resume-last stays parse-only until the conditional phase: same refusal shape", async () => {
    const outcome = await planTurn(
      cursorCli,
      ["--prompt", "hi", "--resume-last"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.issue).toBe("unsupported-option");
    expect(outcome.refusal.option).toBe("resumeLast");
  });

  test("codex --resume-last with --native-approvals refuses: no id to bind the plan", async () => {
    const outcome = await planTurn(
      codexCli,
      [
        "--json",
        "--prompt",
        "hi",
        "--resume-last",
        "--native-approvals",
        "--native-settings-fingerprint",
        "b".repeat(64),
      ],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.issue).toBe("invalid-option-value");
    expect(outcome.refusal.message).toContain("no id to bind");
  });

  test("codex --resume-last with --native-settings-fingerprint refuses: no id to match", async () => {
    const outcome = await planTurn(
      codexCli,
      ["--prompt", "hi", "--resume-last", "--native-settings-fingerprint", "b".repeat(64)],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.issue).toBe("invalid-option-value");
    expect(outcome.refusal.option).toBe("nativeSettingsFingerprint");
  });

  test("claude --resume-last plans the fork argv through the resume phase", async () => {
    const outcome = await planTurn(
      claudeCode,
      ["--prompt", "hi", "--resume-last"],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    expect(outcome.plan.options.resumeLast).toBe(true);
    expect(outcome.plan.provenance).toEqual([]);
    expect(outcome.plan.argv).toContain("--continue");
    expect(outcome.plan.argv).toContain("--fork-session");
  });

  test("muse --resume-last with native approvals still refuses resumeLast first, not the approval plan", async () => {
    const outcome = await planTurn(
      museCode,
      [
        "--json",
        "--prompt",
        "hi",
        "--resume-last",
        "--native-approvals",
        "--native-settings-fingerprint",
        "a".repeat(64),
      ],
      { command: "run" },
      deps,
    );
    expect(outcome.kind).toBe("refusal");
    if (outcome.kind !== "refusal") return;
    expect(outcome.refusal.issue).toBe("unsupported-option");
    expect(outcome.refusal.option).toBe("resumeLast");
  });
});

describe("RFC-06 Phase 3: CLI spawn through a stub binary", () => {
  const STUB_ID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

  /** A stub `claude` that records its argv, announces one session id, and
   * exits at once. Spawned only when every pre-spawn gate passes. */
  const installStubClaude = (dir: string): { readonly calls: string } => {
    mkdirSync(dir, { recursive: true });
    const calls = `${dir}/claude-calls`;
    writeFileSync(
      `${dir}/claude`,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${STUB_ID}"}'\nexit 0\n`,
      { mode: 0o700 },
    );
    return { calls };
  };

  const ENV_KEYS = ["HOME", "HCN_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "PATH"] as const;
  const saveEnv = (): Record<string, string | undefined> =>
    Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreEnv = (saved: Record<string, string | undefined>): void => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };

  test("run claude --resume-last warns, forks, and marks identity through the real spawn", async () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-rl-home-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-rl-cwd-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-rl-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-rl-ccfg-"));
    const { calls } = installStubClaude(binDir);
    const saved = saveEnv();
    process.env.HOME = home;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "claude",
        "hi",
        "--resume-last",
        "--cwd",
        cwd,
        "--json",
      ]);
      const lines = out.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; message?: string; resumeLast?: true });
      const warnings = lines.filter(
        (e) => e.kind === "error" && e.message?.startsWith("hcn: --resume-last"),
      );
      expect(warnings.length).toBeGreaterThanOrEqual(2);
      expect(warnings[0]?.message).toContain("forks the most-recent claude session");
      const identity = lines.find((e) => e.kind === "identity") as
        | { sessionId: string; authority: string; resumeLast?: true }
        | undefined;
      expect(identity?.sessionId).toBe(STUB_ID);
      expect(identity?.resumeLast).toBe(true);
      const spawned = readFileSync(calls, "utf8").split("\n").filter(Boolean);
      expect(spawned).toContain("--continue");
      expect(spawned.filter((t) => t === "--fork-session")).toHaveLength(1);
    } finally {
      restoreEnv(saved);
      for (const d of [home, cwd, binDir, hcnCfg]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("run muse --resume-last exits 2 before spawn", async () => {
    const out = await captureDispatch(["run", "muse", "hi", "--resume-last"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('"resumeLast"');
  });

  test("inspect claude --argv --resume-last previews the fork argv", async () => {
    const out = await captureDispatch(["inspect", "claude", "--argv", "--resume-last", "hi"]);
    expect(out.exitCode).toBeUndefined();
    const argv = JSON.parse(out.stdout) as string[];
    expect(argv).toContain("--continue");
    expect(argv.filter((t) => t === "--fork-session")).toHaveLength(1);
  });

  test("inspect muse --context --resume-last refuses resumeLast", async () => {
    const out = await captureDispatch(["inspect", "muse", "--context", "--resume-last", "hi"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('"resumeLast"');
  });
});

describe("RFC-06 Phase 3: resume-last render lines", () => {
  const renderIdentity = (event: HarnessEvent, h: HarnessDescriptor): string => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let out = "";
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      out += String(chunk);
      return true;
    };
    try {
      renderEvent(event, createRenderState(), h);
    } finally {
      process.stdout.write = originalWrite as typeof process.stdout.write;
    }
    return out;
  };

  const markedIdentity = (sessionId: string): HarnessEvent => ({
    kind: "identity",
    sessionId,
    authority: "harness-minted",
    capabilities: capabilitiesOf(claudeCode, "", "headless-turn"),
    resumeLast: true,
  });
  const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

  test("a descriptor carrying a fork flag prints the fork line with the exact-cwd scope", () => {
    const out = renderIdentity(markedIdentity(sid), claudeCode);
    expect(out).toContain(`forked most-recent session as ${sid} (exact-cwd scope)`);
  });

  test("a descriptor with no fork flag prints the resumed line with the exact-cwd scope", () => {
    const out = renderIdentity(markedIdentity(sid), codexCli);
    expect(out).toContain(`resumed most-recent ${sid} (exact-cwd scope)`);
  });

  test("an unmarked identity prints the existing session line only", () => {
    const { resumeLast: _dropped, ...plain } = markedIdentity(sid) as unknown as Record<
      string,
      unknown
    >;
    const out = renderIdentity(plain as HarnessEvent, claudeCode);
    expect(out).toContain(`session ${sid} (harness-minted)`);
    expect(out).not.toContain("most-recent");
  });
});

describe("RFC-06 Phase 3: hcn session refuses --resume-last", () => {
  test("session claude --resume-last exits 2 naming resumeLast, without spawning", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const out = await captureDispatch(["session", "claude", "--resume-last"]);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain("most recent");
      const json = await captureDispatch(["session", "claude", "--resume-last", "--json"]);
      expect(json.exitCode).toBe(2);
      const failure = JSON.parse(json.stdout.split("\n")[0] as string) as {
        issue: string;
        option: string;
      };
      expect(failure.issue).toBe("invalid-option-value");
      expect(failure.option).toBe("resumeLast");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});
