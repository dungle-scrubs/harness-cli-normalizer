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

/** Spawn `hcn session claude` against a fake native peer, with the env
 * isolation the CLI session tests use (isolated HOME/XDG/state). */
const spawnInteractive = (
  runtime: string,
  root: string,
  peerSource: string,
  args: readonly string[],
) => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), peerSource, { mode: 0o755 });
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
  return spawn(runtime, [cli, "session", "claude", ...args], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
};

/** Collect a session child's streams under a kill deadline. Returns the
 * close promise; the deadline kills a hung child so `await closed` fails
 * the test instead of hanging it. */
const watchSession = (
  child: ReturnType<typeof spawnInteractive>,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
): Promise<number | null> => {
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
  void closed.finally(() => clearTimeout(deadline));
  child.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => onStdout(chunk.toString()));
  return closed;
};

test.each(runtimes)(
  "%s: interactive session renders background completion and follow-up before the next send",
  async (runtime) => {
    const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-session-background-"));
    const child = spawnInteractive(runtime, root, peer, ["--questions", "none"]);
    let stdout = "";
    let stderr = "";
    let sent = false;
    let completionSeen = false;
    let followUpBeforeSend = false;
    let nextReplySeen = false;
    const closed = watchSession(
      child,
      (chunk) => {
        stdout += chunk;
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
      },
      (chunk) => {
        stderr += chunk;
      },
    );
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
      child.kill("SIGKILL");
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);

// A send whose reply records name its uuid while Claude's own unsolicited
// turn is still streaming: the runner merges it into that turn (no turn of
// its own), and the interactive prompt must return when that turn ends -
// never wait for a tagged turn that never comes.
const mergedReplyPeer = `#!${process.execPath}
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let sends = 0;
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "user") return;
  sends += 1;
  const records = sends === 1 ? [
    { type: "system", subtype: "init", user_message_uuids: [request.uuid] },
    { type: "assistant", user_message_uuids: [request.uuid], message: { role: "assistant",
      content: [{ type: "text", text: "FIRST-REPLY" }] } },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
    // Claude's own follow-up starts streaming and stays open (no result
    // yet): its records name no send.
    { type: "assistant", message: { role: "assistant",
      content: [{ type: "text", text: "UNSOLICITED-STREAMING" }] } },
  ] : [
    // The second send's reply records name its uuid while that turn is
    // live, then end the turn: a merged input with no turn of its own.
    { type: "assistant", user_message_uuids: [request.uuid], message: { role: "assistant",
      content: [{ type: "text", text: "MERGED-INTO-UNSOLICITED" }] } },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
  ];
  process.stdout.write(records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
});
`;

test.each(runtimes)(
  "%s: a send merged into the streaming unsolicited turn returns to the prompt",
  async (runtime) => {
    const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-session-merged-"));
    try {
      const child = spawnInteractive(runtime, root, mergedReplyPeer, ["--questions", "none"]);
      let stdout = "";
      let stderr = "";
      let stage = 0;
      const closed = watchSession(
        child,
        (chunk) => {
          stdout += chunk;
          if (stage === 0 && stdout.includes("you › ")) {
            stage = 1;
            child.stdin.write("first request\n");
          }
          // Written while the unsolicited turn is still open (no result of
          // its own has rendered): this is the merge window.
          if (stage === 1 && stdout.includes("UNSOLICITED-STREAMING")) {
            stage = 2;
            child.stdin.write("second request\n");
          }
          if (stage === 2 && stdout.includes("MERGED-INTO-UNSOLICITED")) stage = 3;
          if (stage === 3 && stdout.includes("you › ", stdout.indexOf("MERGED-INTO-UNSOLICITED"))) {
            stage = 4;
            child.stdin.end("exit\n");
          }
        },
        (chunk) => {
          stderr += chunk;
        },
      );
      const code = await closed;
      expect(code, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      expect(stage, `stdout: ${stdout}`).toBe(4);
      const plain = stripVTControlCharacters(stdout);
      const merged = plain.indexOf("MERGED-INTO-UNSOLICITED");
      expect(plain.indexOf("you › ", merged)).toBeGreaterThan(merged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);

// An unsolicited turn that ends awaiting input: no send opened it, and the
// interactive REPL still offers the answer prompt (issue #44 extended to
// turns no send opened).
const unsolicitedQuestionPeer = `#!${process.execPath}
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let sends = 0;
const ask = [
  "I need a decision.",
  "\`\`\`hcn-question",
  JSON.stringify({ question: "Pick a color", options: ["red", "blue"], recommended: "red" }),
  "\`\`\`",
].join("\\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "user") return;
  sends += 1;
  const records = sends === 1 ? [
    { type: "system", subtype: "init", user_message_uuids: [request.uuid] },
    { type: "assistant", user_message_uuids: [request.uuid], message: { role: "assistant",
      content: [{ type: "text", text: "FIRST-REPLY" }] } },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
    // The unsolicited follow-up asks: its final message carries the
    // hcn-question block, and its records name no send.
    { type: "assistant", message: { role: "assistant",
      content: [{ type: "text", text: ask }] } },
    { type: "result", subtype: "success" },
  ] : [
    { type: "assistant", user_message_uuids: [request.uuid], message: { role: "assistant",
      content: [{ type: "text", text: "ANSWERED-REPLY" }] } },
    { type: "result", subtype: "success", user_message_uuids: [request.uuid] },
  ];
  process.stdout.write(records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
});
`;

test.each(runtimes)(
  "%s: an unsolicited turn ending with a question offers the answer prompt",
  async (runtime) => {
    const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-session-question-"));
    try {
      // No --questions none: the answer prompt needs ask mode.
      const child = spawnInteractive(runtime, root, unsolicitedQuestionPeer, []);
      let stdout = "";
      let stderr = "";
      let stage = 0;
      const closed = watchSession(
        child,
        (chunk) => {
          stdout += chunk;
          if (stage === 0 && stdout.includes("you › ")) {
            stage = 1;
            child.stdin.write("start something\n");
          }
          if (stage === 1 && stdout.includes("answer › pick a number")) {
            stage = 2;
            child.stdin.write("1\n");
          }
          if (stage === 2 && stdout.includes("ANSWERED-REPLY")) stage = 3;
          if (stage === 3 && stdout.includes("you › ", stdout.indexOf("ANSWERED-REPLY"))) {
            stage = 4;
            child.stdin.end("exit\n");
          }
        },
        (chunk) => {
          stderr += chunk;
        },
      );
      const code = await closed;
      expect(code, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      expect(stage, `stdout: ${stdout}`).toBe(4);
      expect(stdout).toContain("Pick a color");
      expect(stdout).toContain("1. red (recommended)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);
