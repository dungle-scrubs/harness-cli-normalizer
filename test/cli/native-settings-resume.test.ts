import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const cli = resolve("src/cli/index.ts");
const sessionId = "807feafe-e82b-4df4-91ba-4f1aeb987508";

test("the public verified resume runs the exact saved custom model, effort and provider", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-verified-resume-")));
  try {
    const codexHome = join(root, "codex-home");
    const directory = join(codexHome, "sessions", "2026", "09", "12");
    const bin = join(root, "bin");
    mkdirSync(directory, { recursive: true });
    mkdirSync(bin);
    // Synthetic native record and executable, not a live-model claim.
    writeFileSync(
      join(directory, `rollout-fixture-${sessionId}.jsonl`),
      `${[
        {
          type: "session_meta",
          payload: { id: sessionId, cwd: root, model_provider: "saved-provider" },
        },
        {
          type: "turn_context",
          payload: { cwd: root, model: "saved-custom-model", effort: "high" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!${bun}\nif (process.argv.includes("--version")) { console.log("codex 0.154.0"); process.exit(0); }\nimport {writeFileSync} from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "native-argv.json"))}, JSON.stringify(process.argv.slice(2)));\n${[
        { type: "thread.started", thread_id: sessionId },
        { type: "item.completed", item: { type: "agent_message", text: "FIXTURE_DONE" } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ]
        .map((record) => `console.log(${JSON.stringify(JSON.stringify(record))});`)
        .join("\n")}\n`,
      { mode: 0o700 },
    );
    const env = {
      CODEX_HOME: codexHome,
      HCN_CONFIG_DIR: join(root, "hcn-config"),
      HOME: root,
      PATH: bin,
    };
    const inspect = spawnSync(
      bun,
      [
        cli,
        "inspect",
        "codex",
        "--native-settings",
        "--resume",
        sessionId,
        "--cwd",
        root,
        "--json",
      ],
      { cwd: root, env, encoding: "utf8", timeout: 2000 },
    );
    expect(inspect.status).toBe(0);
    const fingerprint = JSON.parse(inspect.stdout).fingerprint;
    const preview = spawnSync(
      bun,
      [
        cli,
        "inspect",
        "codex",
        "--runtime",
        "--resume",
        sessionId,
        "--cwd",
        root,
        "--native-settings-fingerprint",
        fingerprint,
        "--prompt",
        "EXACT_INPUT",
        "--questions",
        "none",
        "--json",
      ],
      { cwd: root, env, encoding: "utf8", timeout: 3000 },
    );
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).argv).toContain("saved-custom-model");
    expect(JSON.parse(preview.stdout).argv).toContain('model_provider="saved-provider"');
    expect(existsSync(join(root, "native-argv.json"))).toBe(false);
    const args = [
      cli,
      "run",
      "codex",
      "--resume",
      sessionId,
      "--cwd",
      root,
      "--native-settings-fingerprint",
      fingerprint,
      "--access",
      "read",
      "--questions",
      "none",
      "--prompt",
      "EXACT_INPUT",
      "--json",
    ];
    for (const extra of [
      ["--model", "other-model"],
      ["--effort", "low"],
      ["--provider", "other-provider"],
      ["--mode", "headless-session"],
      ["--mode", "interactive"],
      ["--", "-c", "model=other"],
    ]) {
      const refused = spawnSync(bun, [...args, ...extra], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 3000,
      });
      expect(refused.status).toBe(2);
      expect(refused.stdout).toContain('"issue":"invalid-option-value"');
      expect(existsSync(join(root, "native-argv.json"))).toBe(false);
    }
    const run = spawnSync(bun, args, { cwd: root, env, encoding: "utf8", timeout: 3000 });
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "native-argv.json"), "utf8"))).toEqual([
      "exec",
      "resume",
      sessionId,
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "--model",
      "saved-custom-model",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'model_provider="saved-provider"',
      "EXACT_INPUT",
    ]);
    expect(run.stdout).toContain('"cause":"clean"');
    expect(run.stdout).toContain(sessionId);
    rmSync(join(root, "native-argv.json"));
    appendFileSync(
      join(directory, `rollout-fixture-${sessionId}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: { cwd: root, model: "later-native-model", effort: "low" } })}\n`,
    );
    const stale = spawnSync(bun, args, { cwd: root, env, encoding: "utf8", timeout: 3000 });
    expect(stale.status).toBe(2);
    expect(stale.stdout).toContain('"issue":"native-settings-changed"');
    expect(existsSync(join(root, "native-argv.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
