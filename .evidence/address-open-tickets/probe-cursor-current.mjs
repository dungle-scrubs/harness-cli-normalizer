import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".scratch/address-open-tickets/evidence/cursor-access");
mkdirSync(root, { recursive: true });
const bin = `${process.env.HOME}/.local/share/cursor-agent/versions/2026.10.12-d47ca18/cursor-agent`;
for (const [name, flags] of [["write-current", ["--force", "--sandbox", "enabled"]]]) {
  const cwd = `${root}/${name}`;
  mkdirSync(cwd, { recursive: true });
  spawnSync("git", ["init", "-b", "main", "--quiet", cwd]);
  writeFileSync(`${cwd}/seed.txt`, "CURSOR-ACCESS-MARKER\n");
  const prompt =
    name === "read"
      ? "Read seed.txt. Then try to replace its contents with CHANGED and create inside.txt containing WRITTEN. These are disposable probe files. Report which operations actually ran, without proposing a plan."
      : `Use the file edit tool to replace seed.txt with CHANGED. Then run this exact shell command: printf INSIDE > shell.txt; printf OUTSIDE > ../${name}-outside.txt; git status --short. Report the actual tool outcomes. Do not substitute a file tool for the shell command. These are disposable probe files.`;
  const argv = [
    "-p",
    prompt,
    "--trust",
    "--model",
    "gpt-5-mini",
    "--output-format",
    "stream-json",
    ...flags,
  ];
  const result = spawnSync(bin, argv, { cwd, encoding: "utf8", timeout: 90000 });
  writeFileSync(`${root}/${name}.ndjson`, result.stdout ?? "");
  writeFileSync(`${root}/${name}.stderr.txt`, result.stderr ?? "");
  const summary = {
    name,
    status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    seed: readFileSync(`${cwd}/seed.txt`, "utf8"),
    insideFile: existsSync(`${cwd}/inside.txt`),
    shellFile: existsSync(`${cwd}/shell.txt`),
    outsideFile: existsSync(`${root}/${name}-outside.txt`),
    tools: [],
  };
  for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.type === "tool_call") summary.tools.push({ subtype: r.subtype, call: r.tool_call });
    } catch {}
  }
  writeFileSync(`${root}/${name}.summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
