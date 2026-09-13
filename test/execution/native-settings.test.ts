import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nodeNativeSettingsInspector } from "../../src/execution/node-deps.js";

test("native source inspection does not return the process environment supplied for its lookup", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-settings-environment-")));
  try {
    const home = join(root, "codex-home");
    const directory = join(home, "sessions", "2026", "09", "12");
    mkdirSync(directory, { recursive: true });
    const sessionId = "907feafe-e82b-4df4-91ba-4f1aeb987508";
    // Synthetic environment marker, never a credential or a real environment read.
    writeFileSync(
      join(directory, `rollout-fixture-${sessionId}.jsonl`),
      [
        { type: "session_meta", payload: { id: sessionId, cwd: root, model_provider: "saved" } },
        { type: "turn_context", payload: { cwd: root, model: "saved-model", effort: "high" } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const result = nodeNativeSettingsInspector({
      cwd: root,
      harness: "codex",
      sessionId,
      env: { CODEX_HOME: home, FIXTURE_ONLY_MARKER: "DO_NOT_RETURN_ENVIRONMENT" },
    });
    expect(result.status).toBe("available");
    expect(result).not.toHaveProperty("env");
    expect(JSON.stringify(result)).not.toContain("DO_NOT_RETURN_ENVIRONMENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
