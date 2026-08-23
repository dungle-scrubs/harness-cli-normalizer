// Drive one claude stream-json session turn: write a user message, hold stdin
// until the result event, then close. Mirrors the pi driver's shape.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [, , mode, id, message, out] = process.argv;
const flag = mode === "resume" ? "--resume" : "--session-id";
const args = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  flag,
  id,
];
const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
let all = "",
  err = "",
  buf = "";
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
      if (JSON.parse(l).type === "result") proc.stdin.end();
    } catch {}
  }
});
proc.stdin.write(
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: message }] },
  }) + "\n",
);
const code = await new Promise((r) => proc.on("close", r));
fs.writeFileSync(out, all);
fs.writeFileSync(out + ".err", err);
console.log(`exit=${code} lines=${all.split("\n").filter(Boolean).length} flag=${flag}`);
