import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";
import { cli, runtimes } from "./session-fixture.js";

// Synthetic native peer: a task finishes and triggers a follow-up turn after
// its launching turn's result. The next send gets its own distinct reply.
const peer = `#!${process.execPath}
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let sends = 0;
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "user") return;
  sends += 1;
  const records = sends === 1 ? [
    { type: "system", subtype: "init", user_message_uuids: [request.uuid] },
    { type: "system", subtype: "task_started", task_id: "job-1",
      task_type: "local_bash", description: "background loop" },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
    { type: "system", subtype: "task_notification", task_id: "job-1",
      status: "completed", summary: "BETWEEN-TURN-COMPLETION" },
    { type: "assistant", message: { role: "assistant",
      content: [{ type: "text", text: "UNSOLICITED-FOLLOW-UP" }] } },
    { type: "result", subtype: "success" },
  ] : [
    { type: "system", subtype: "init", user_message_uuids: [request.uuid] },
    { type: "assistant", user_message_uuids: [request.uuid], message: { role: "assistant",
      content: [{ type: "text", text: "NEXT-SEND-REPLY" }] } },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
  ];
  process.stdout.write(records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
});
`;

test.each(runtimes)(
  "%s: interactive session renders background completion and follow-up before the next send",
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
    let followUpBeforeSend = false;
    let nextReplySeen = false;
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
      }
      if (!followUpBeforeSend && stdout.includes("UNSOLICITED-FOLLOW-UP")) {
        // No next send or EOF until the unsolicited turn has rendered.
        followUpBeforeSend = true;
        child.stdin.write("another request\n");
      }
      if (!nextReplySeen && stdout.includes("NEXT-SEND-REPLY")) {
        nextReplySeen = true;
        child.stdin.end("exit\n");
      }
    });
    try {
      expect(await closed, stdout + stderr).toBe(0);
      expect(completionSeen, stdout + stderr).toBe(true);
      expect(stdout).toContain("background shell running background loop");
      expect(stdout).toContain("background shell completed BETWEEN-TURN-COMPLETION");
      expect(followUpBeforeSend, stdout + stderr).toBe(true);
      expect(nextReplySeen, stdout + stderr).toBe(true);
      const plain = stripVTControlCharacters(stdout);
      const completion = plain.indexOf("background shell completed");
      const followUp = plain.indexOf("UNSOLICITED-FOLLOW-UP");
      const nextReply = plain.indexOf("NEXT-SEND-REPLY");
      expect(followUp).toBeGreaterThan(completion);
      expect(nextReply).toBeGreaterThan(followUp);
      expect(plain).not.toContain("you › UNSOLICITED-FOLLOW-UP");
      expect(plain.slice(completion, followUp)).toContain("\nyou › ");
      expect(plain.slice(followUp, nextReply)).toContain("\nyou › ");
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);
