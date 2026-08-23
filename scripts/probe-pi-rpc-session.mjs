// Drive one pi rpc turn: write a prompt, hold stdin until agent_settled, then close.
import { spawn } from "node:child_process";

const [, , sessionId, message, out] = process.argv;
const fs = await import("node:fs");
const proc = spawn("pi", ["--mode", "rpc", "--session-id", sessionId, "--no-tools"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "",
  all = "",
  err = "";
proc.stderr.on("data", (d) => {
  err += d;
});
proc.stdout.on("data", (d) => {
  all += d;
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      if (JSON.parse(l).type === "agent_settled") {
        proc.stdin.end();
      }
    } catch {}
  }
});
proc.stdin.write(JSON.stringify({ id: "p", type: "prompt", message }) + "\n");
const code = await new Promise((r) => proc.on("close", r));
fs.writeFileSync(out, all);
fs.writeFileSync(out + ".err", err);
console.log(`exit=${code} lines=${all.split("\n").filter(Boolean).length}`);
