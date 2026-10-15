import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("usage: node check-observations.mjs /path/to/hcn");
const bin = resolve(executable);
const root = mkdtempSync(join(tmpdir(), "hcn-observations-"));
const tools = join(root, "bin");
mkdirSync(tools);
const env = {
  HOME: join(root, "home"),
  PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HCN_CONFIG_DIR: join(root, "config"),
  HCN_STATE_DIR: join(root, "state"),
};
const stub = (name, records, capture) =>
  writeFileSync(
    join(tools, name),
    `#!${process.execPath}\n${capture ? `require("node:fs").writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));\n` : ""}process.stdout.write(${JSON.stringify(`${records.map((r) => JSON.stringify(r)).join("\n")}\n`)});\n`,
    { mode: 0o755 },
  );
const run = (args) => {
  const p = spawnSync(bin, args, { cwd: root, env, encoding: "utf8", timeout: 20000 });
  assert.equal(p.error, undefined);
  assert.equal(p.status, 0, p.stderr);
  return p.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
};
try {
  const launch = spawnSync(bin, ["--version"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20000,
  });
  if (launch.error || launch.status !== 0) {
    const detail =
      launch.error?.message ?? launch.stderr.trim().split("\n")[0] ?? `exit ${launch.status}`;
    console.log(
      `blocked: observation checks: ${bin} did not start under the check's isolated HOME (${detail}); set HCN_BIN to the JavaScript entry rather than a HOME-dependent launcher`,
    );
    process.exitCode = 3;
  } else {
    const help = spawnSync(bin, ["run", "--help"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(help.status, 0, help.stderr);
    if (help.stdout.includes("done.denialCount")) {
      const denied = {
        tool_name: "Bash",
        tool_use_id: "fixture-denied-call",
        tool_input: { command: "printf fixture" },
      };
      const result = (permission_denials) => ({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "fixture",
        permission_denials,
      });
      stub("claude", [result([denied, denied])]);
      const events = run(["run", "claude", "--json", "--questions", "none", "--prompt", "fixture"]);
      const observation = {
        tool: "Bash",
        reason: "",
        callId: "fixture-denied-call",
        inputSummary: '{"command":"printf fixture"}',
      };
      assert.deepEqual(
        events.filter((e) => e.kind === "error").map((e) => e.denial),
        [observation, observation],
      );
      assert.equal(events.at(-1).denialCount, 2, "done.denialCount counts observations");
      assert.equal(events.at(-1).cause, "clean");
      assert.equal(
        events.some((e) => e.kind === "failure"),
        false,
      );
      stub("claude", [result([])]);
      const clean = run(["run", "claude", "--json", "--questions", "none", "--prompt", "fixture"]);
      assert.equal("denialCount" in clean.at(-1), false);
      assert.equal(
        clean.some((e) => e.kind === "error" && e.denial),
        false,
      );
      assert.equal(clean.at(-1).cause, "clean");
      console.log("ok: Claude denial observations and counts match the skill");
    }
    if (
      help.stdout
        .replace(/\s+/g, " ")
        .includes("claude --permission-mode acceptEdits plus strict native sandbox")
    ) {
      const registry = join(root, "skills");
      for (const name of ["keep", "drop"]) {
        const directory = join(registry, name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: synthetic fixture\n---\nFixture.\n`,
        );
      }
      env.HCN_SKILLS_ROOT = registry;
      const capture = join(root, "claude-argv.json");
      stub("claude", [{ type: "result", subtype: "success", is_error: false }], capture);
      run([
        "run",
        "claude",
        "--json",
        "--questions",
        "none",
        "--access",
        "write",
        "--skills",
        "keep",
        "--prompt",
        "fixture",
      ]);
      const argv = JSON.parse(readFileSync(capture, "utf8"));
      assert.deepEqual(
        argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2),
        ["--permission-mode", "acceptEdits"],
      );
      assert.equal(argv.includes("--dangerously-skip-permissions"), false);
      assert.equal(argv.includes("--allowedTools"), false);
      assert.equal(argv.filter((arg) => arg === "--settings").length, 1);
      assert.deepEqual(JSON.parse(argv[argv.indexOf("--settings") + 1]), {
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: { disabled: false },
        },
        skillOverrides: { drop: "off" },
      });
      console.log("ok: Claude write and selected skills share strict native settings");
    }
    const inspected = spawnSync(bin, ["inspect", "cursor", "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(inspected.status, 0, inspected.stderr);
    const spec = JSON.parse(inspected.stdout).turnOptions.access;
    assert.deepEqual(spec.renders.read.render, {
      kind: "flag-list",
      flags: ["--mode", "ask", "--sandbox", "enabled"],
    });
    assert.deepEqual(spec.renders.write.render, { kind: "flag-list", flags: ["--force"] });
    const result = {
      content: [{ type: "text", text: "failed" }],
      details: { status: "aborted", agents: [{ error: "fixture" }] },
    };
    stub("pi", [
      { type: "tool_execution_start", toolName: "workflow", toolCallId: "c1", args: {} },
      { type: "tool_execution_end", toolName: "workflow", toolCallId: "c1", result, isError: true },
      {
        type: "message_end",
        message: { role: "toolResult", toolCallId: "c1", ...result, isError: true },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          stopReason: "stop",
          usage: { input: 10, output: 2, cacheRead: 3, cost: { total: 0.01 } },
        },
      },
      { type: "agent_end", messages: [] },
    ]);
    const events = run(["run", "pi", "--json", "--questions", "none", "--prompt", "fixture"]);
    assert.deepEqual(
      events.filter((e) => e.kind === "tool-result"),
      [{ kind: "tool-result", name: "workflow", callId: "c1", result, isError: true }],
    );
    assert.deepEqual(
      events.filter((e) => e.kind === "usage"),
      [
        {
          kind: "usage",
          scope: "message",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          costUsd: 0.01,
          inputIncludesCache: false,
        },
      ],
    );
    assert.equal(events.at(-1).cause, "clean");
    const sessionId = "907feafe-e82b-4df4-91ba-4f1aeb987508";
    stub("codex", [
      { type: "thread.started", thread_id: sessionId },
      {
        type: "turn.completed",
        usage: { input_tokens: 40, cached_input_tokens: 20, output_tokens: 10 },
      },
    ]);
    const resumed = run([
      "run",
      "codex",
      "--json",
      "--questions",
      "none",
      "--resume",
      sessionId,
      "--prompt",
      "fixture",
    ]);
    assert.deepEqual(
      resumed.filter((e) => e.kind === "usage"),
      [
        {
          kind: "usage",
          scope: "session",
          inputTokens: 40,
          cacheReadTokens: 20,
          outputTokens: 10,
          inputIncludesCache: true,
        },
      ],
    );
    assert.equal(resumed.at(-1).cause, "clean");
    const capture = join(root, "argv.json");
    stub("agent", [{ type: "result", subtype: "success", is_error: false }], capture);
    for (const access of ["read", "write"]) {
      run([
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--access",
        access,
        "--prompt",
        "fixture",
      ]);
      const argv = JSON.parse(readFileSync(capture, "utf8"));
      if (access === "read") {
        assert.deepEqual(argv.slice(argv.indexOf("--mode"), argv.indexOf("--mode") + 2), [
          "--mode",
          "ask",
        ]);
        assert.equal(argv.includes("--force"), false);
      } else {
        assert.equal(argv.includes("--force"), true);
        assert.equal(argv.includes("--sandbox"), false);
      }
    }
    console.log("ok: Cursor access and lossless result/usage observations match the skill");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
