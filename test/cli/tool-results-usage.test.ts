import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { storePath } from "../../src/interpretation/store.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const sessionId = "907feafe-e82b-4df4-91ba-4f1aeb987508";
const result = {
  content: [{ type: "text", text: "workflow aborted" }],
  details: { status: "aborted", runId: "workflow-123", agents: [{ status: "error" }] },
};
const claudeDeniedRecords = readFileSync(
  resolve("test/fixtures/claude-2.1.296/permission-denied.result.ndjson"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const records = [
  { type: "session", id: sessionId },
  { type: "tool_execution_start", toolName: "workflow", toolCallId: "call-1", args: {} },
  {
    type: "tool_execution_update",
    toolName: "workflow",
    toolCallId: "call-1",
    partialResult: { content: [] },
  },
  { type: "tool_execution_end", toolName: "workflow", toolCallId: "call-1", result, isError: true },
  {
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "workflow",
      toolCallId: "call-1",
      ...result,
      isError: true,
    },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "The workflow aborted." }],
      stopReason: "stop",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 0,
        reasoning: 5,
        totalTokens: 170,
        cost: { total: 0.01 },
      },
    },
  },
  { type: "agent_end", messages: [] },
];

function fixture(harness: string, nativeRecords: unknown[]) {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-results-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  if (harness === "cursor")
    mkdirSync(join(storePath(cursorCli, { home, cwd: root, sessionId }), sessionId), {
      recursive: true,
    });
  const argvPath = join(root, "argv.json");
  writeFileSync(
    join(bin, harness === "cursor" ? "agent" : harness),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(`${nativeRecords.map((r) => JSON.stringify(r)).join("\n")}\n`)});\n`,
    { mode: 0o755 },
  );
  return {
    root,
    argvPath,
    env: {
      HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HCN_CONFIG_DIR: join(root, "config"),
      HCN_STATE_DIR: join(root, "state"),
    },
  };
}

for (const runtime of [process.execPath, bun]) {
  test(`${runtime}: run exposes a failed tool's full result and final usage before a clean done`, () => {
    const f = fixture("pi", records);
    try {
      const run = spawnSync(
        runtime,
        [cli, "run", "pi", "--json", "--questions", "none", "--cwd", f.root, "--prompt", "fixture"],
        { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 },
      );
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      const events = run.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((e) => e.kind === "tool")).toEqual([
        { kind: "tool", name: "workflow", callId: "call-1", input: {} },
      ]);
      expect(events.filter((e) => e.kind === "tool-result")).toEqual([
        { kind: "tool-result", name: "workflow", callId: "call-1", result, isError: true },
      ]);
      expect(events.filter((e) => e.kind === "usage")).toEqual([
        {
          kind: "usage",
          scope: "message",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
          reasoningTokens: 5,
          totalTokens: 170,
          costUsd: 0.01,
          inputIncludesCache: false,
        },
      ]);
      expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30000);

  test(`${runtime}: Claude permission denials are observations and mark the terminal done`, () => {
    const f = fixture("claude", claudeDeniedRecords);
    try {
      const run = spawnSync(
        runtime,
        [
          cli,
          "run",
          "claude",
          "--json",
          "--questions",
          "none",
          "--cwd",
          f.root,
          "--prompt",
          "fixture",
        ],
        { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 },
      );
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      const events = run.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const denials = events.filter((event) => event.kind === "error" && event.denial);
      expect(denials).toEqual([
        {
          kind: "error",
          message: expect.any(String),
          denial: {
            tool: "Bash",
            reason: "",
            callId: "toolu_018RHAFRUDCVdcbCtkfzhhiq",
            inputSummary: expect.any(String),
          },
        },
      ]);
      expect(JSON.parse(denials[0].denial.inputSummary)).toEqual({
        command: "node -e \"require('node:fs').writeFileSync('marker.txt', 'hcn-write-probe\\n')\"",
        description: "Write probe marker file via node",
      });
      expect(events.some((event) => event.kind === "failure")).toBe(false);
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        cause: "clean",
        exitCode: 0,
        denialCount: 1,
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30000);

  for (const [copies, annotation] of [
    [1, "[denials: 1]"],
    [2, "[denials: 2]"],
  ] as const) {
    test(`${runtime}: human done counts ${copies} denial reports, not unique call IDs`, () => {
      const f = fixture("claude", Array.from({ length: copies }, () => claudeDeniedRecords).flat());
      try {
        const run = spawnSync(
          runtime,
          [cli, "run", "claude", "--questions", "none", "--cwd", f.root, "--prompt", "fixture"],
          { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 },
        );
        expect(run.error).toBeUndefined();
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout.split("Tool permission denied: Bash").length - 1).toBe(copies);
        expect(run.stdout).toContain("○ clean");
        expect(run.stdout).toContain("(exit 0)");
        expect(run.stdout).toContain(annotation);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }, 30000);
  }

  test(`${runtime}: human output marks a failed tool without inventing a failed turn`, () => {
    const f = fixture("pi", records);
    try {
      const run = spawnSync(
        runtime,
        [cli, "run", "pi", "--questions", "none", "--cwd", f.root, "--prompt", "fixture"],
        { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 },
      );
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("✗ tool workflow failed");
      expect(run.stdout).toContain("○ clean");
      expect(run.stdout).toContain("(exit 0)");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30000);

  test(`${runtime}: Codex exec reports resumed thread totals without computing turn deltas`, () => {
    const f = fixture("codex", [
      { type: "thread.started", thread_id: sessionId },
      {
        type: "turn.completed",
        usage: { input_tokens: 40, cached_input_tokens: 20, output_tokens: 10 },
      },
    ]);
    try {
      const run = spawnSync(
        runtime,
        [
          cli,
          "run",
          "codex",
          "--json",
          "--questions",
          "none",
          "--cwd",
          f.root,
          "--resume",
          sessionId,
          "--prompt",
          "fixture",
        ],
        { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 },
      );
      expect(run.status, run.stderr).toBe(0);
      const events = run.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((e) => e.kind === "usage")).toEqual([
        {
          kind: "usage",
          scope: "session",
          inputTokens: 40,
          cacheReadTokens: 20,
          outputTokens: 10,
          inputIncludesCache: true,
        },
      ]);
      const argv = JSON.parse(readFileSync(f.argvPath, "utf8")) as string[];
      expect(argv.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(argv.filter((arg) => arg === sessionId)).toEqual([sessionId]);
      expect(argv).not.toContain("--last");
      expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30000);

  test(`${runtime}: access help separates no default from explicit Cursor write and Antigravity refusal`, () => {
    const run = spawnSync(runtime, [cli, "run", "--help"], { encoding: "utf8", timeout: 20000 });
    expect(run.status).toBe(0);
    const help = run.stdout.replace(/\s+/g, " ");
    expect(help).toContain("access have no default; no access preset is applied");
    expect(help).toContain("Explicit access write emits --force on cursor");
    expect(help).toContain("antigravity refuses --access");
    expect(help).toContain("Cursor read with autonomy also adds --force; precedence is unverified");
    expect(help).toContain("Use --no-autonomy for the qualified read preset");
    expect(help).not.toContain("nothing on claude/pi/muse/cursor/antigravity");
  }, 30000);

  test(`${runtime}: JSON help describes denial counts without promising work success`, () => {
    for (const command of ["run", "session"]) {
      const result = spawnSync(runtime, [cli, command, "--help"], {
        encoding: "utf8",
        timeout: 20000,
      });
      expect(result.status).toBe(0);
      const help = result.stdout.replace(/\s+/g, " ");
      expect(help).toContain("done.denialCount: positive count of denial observations");
      expect(help).toContain("not unique calls; omitted when zero");
      expect(help).toContain("does not change the native exit status or cause");
      expect(help).toContain("not a work-success verdict");
    }
  }, 30000);

  test(`${runtime}: Claude access help explains the strict native sandbox and its limits`, () => {
    const run = spawnSync(runtime, [cli, "run", "--help"], { encoding: "utf8", timeout: 20000 });
    expect(run.status).toBe(0);
    const help = run.stdout.replace(/\s+/g, " ");
    expect(help).toContain("claude --permission-mode acceptEdits plus strict native sandbox");
    expect(help).toContain("requests fail-closed startup");
    expect(help).toContain(
      "trusted user or managed domain policy may be needed for installs or tests",
    );
    expect(help).toContain("Claude keeps the explicit write sandbox with --autonomy");
    expect(help).not.toContain("no extra flags on claude/pi/muse/popeye");
  }, 30000);

  test(`${runtime}: Claude write and selected skills compose on fresh, named and last turns`, () => {
    const prompt = 'Preserve literal --settings {"sandbox":{"enabled":false}} as prompt text.';
    for (const resume of [[], ["--resume", sessionId], ["--resume-last"]]) {
      const f = fixture("claude", [
        { type: "system", subtype: "init", session_id: sessionId },
        { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } },
        { type: "result", subtype: "success", is_error: false },
      ]);
      try {
        const skillsRoot = join(f.root, ".claude", "skills");
        for (const name of ["keep", "drop"]) {
          const skill = join(skillsRoot, name);
          mkdirSync(skill, { recursive: true });
          writeFileSync(
            join(skill, "SKILL.md"),
            `---\nname: ${name}\ndescription: Fixture skill.\n---\nNo actions.\n`,
          );
        }
        const run = spawnSync(
          runtime,
          [
            cli,
            "run",
            "claude",
            "--json",
            "--questions",
            "none",
            "--cwd",
            f.root,
            "--access",
            "write",
            "--no-autonomy",
            "--skills",
            "keep",
            ...resume,
            "--prompt",
            prompt,
          ],
          {
            cwd: f.root,
            env: { ...f.env, HCN_SKILLS_ROOT: skillsRoot },
            encoding: "utf8",
            timeout: 20000,
          },
        );
        expect(run.error).toBeUndefined();
        expect(run.status, run.stderr).toBe(0);
        const argv = JSON.parse(readFileSync(f.argvPath, "utf8")) as string[];
        if (resume[0] === "--resume") {
          expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual([
            "--resume",
            sessionId,
          ]);
          expect(argv).not.toContain("--continue");
        } else if (resume[0] === "--resume-last") {
          expect(argv).toContain("--continue");
          expect(argv).toContain("--fork-session");
          expect(argv).not.toContain("--resume");
        } else {
          expect(argv).not.toContain("--resume");
          expect(argv).not.toContain("--continue");
        }
        expect(argv).toContain(prompt);
        expect(
          argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2),
        ).toEqual(["--permission-mode", "acceptEdits"]);
        expect(argv.filter((arg) => arg === "--settings")).toHaveLength(1);
        expect(JSON.parse(argv[argv.indexOf("--settings") + 1] as string)).toEqual({
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            failIfUnavailable: true,
            filesystem: { disabled: false },
          },
          skillOverrides: { drop: "off" },
        });
        expect(argv).not.toContain("--allowedTools");
        expect(argv).not.toContain("--dangerously-skip-permissions");
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }
  }, 80000);

  for (const access of ["read", "write"]) {
    test(`${runtime}: Cursor access ${access} renders on fresh, resumed and resume-last turns`, () => {
      for (const resume of [[], ["--resume", sessionId], ["--resume-last"]]) {
        const f = fixture("cursor", [
          { type: "system", subtype: "init", session_id: sessionId },
          { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } },
          { type: "result", subtype: "success", is_error: false },
        ]);
        try {
          const run = spawnSync(
            runtime,
            [
              cli,
              "run",
              "cursor",
              "--json",
              "--questions",
              "none",
              "--cwd",
              f.root,
              "--access",
              access,
              ...resume,
              "--prompt",
              "fixture",
            ],
            { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 },
          );
          expect(run.error).toBeUndefined();
          expect(run.status, run.stderr).toBe(0);
          const argv = JSON.parse(readFileSync(f.argvPath, "utf8")) as string[];
          if (resume[0] === "--resume") {
            expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual([
              "--resume",
              sessionId,
            ]);
            expect(argv).not.toContain("--continue");
          } else if (resume[0] === "--resume-last") {
            expect(argv).toContain("--continue");
            expect(argv).not.toContain("--resume");
          } else {
            expect(argv).not.toContain("--resume");
            expect(argv).not.toContain("--continue");
          }
          if (access === "read") {
            expect(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2)).toEqual([
              "--sandbox",
              "enabled",
            ]);
            expect(argv.slice(argv.indexOf("--mode"), argv.indexOf("--mode") + 2)).toEqual([
              "--mode",
              "ask",
            ]);
            expect(argv).not.toContain("--force");
          } else {
            expect(argv).not.toContain("--sandbox");
            expect(argv.filter((a) => a === "--force")).toHaveLength(1);
          }
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      }
    }, 80000);
  }
}
