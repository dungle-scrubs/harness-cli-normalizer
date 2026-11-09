import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";
import { cli, runtimes } from "./session-fixture.js";

// Synthetic native peer: a task finishes after its launching turn's result.
const peer = `#!${process.execPath}
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "user") return;
  const records = [
    { type: "system", subtype: "init", user_message_uuids: [request.uuid] },
    { type: "system", subtype: "task_started", task_id: "job-1",
      task_type: "local_bash", description: "background loop" },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
    { type: "system", subtype: "task_notification", task_id: "job-1",
      status: "completed", summary: "BETWEEN-TURN-COMPLETION" },
  ];
  process.stdout.write(records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
});
`;

test.each(runtimes)(
  "%s: interactive session renders bare background completion while awaiting input",
  async (runtime) => {
    const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-session-background-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), peer, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      XDG_STATE_HOME: root,
      HCN_STATE_DIR: join(root, "state"),
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.HCN_CONFIG_DIR;
    delete env.HCN_OBSERVER;
    delete env.HCN_INVOCATION_ID;
    const child = spawn(runtime, [cli, "session", "claude", "--questions", "none"], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sent = false;
    let completionSeen = false;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!sent && stdout.includes("you › ")) {
        sent = true;
        child.stdin.write("launch a background loop\n");
      }
      if (!completionSeen && stdout.includes("BETWEEN-TURN-COMPLETION")) {
        completionSeen = true;
        // No next send or EOF until the idle observation has rendered.
        child.stdin.end("exit\n");
      }
    });
    try {
      expect(await closed, stderr).toBe(0);
      expect(completionSeen, stdout + stderr).toBe(true);
      expect(stdout).toContain("background shell running background loop");
      expect(stdout).toContain("background shell completed BETWEEN-TURN-COMPLETION");
      expect(stdout.split("you › ")).toHaveLength(3);
      expect(stdout.indexOf("background shell completed")).toBeGreaterThan(
        stdout.lastIndexOf("you › "),
      );
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);
