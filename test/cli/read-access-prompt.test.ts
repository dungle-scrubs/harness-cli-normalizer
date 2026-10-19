import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const sessionId = "0199a4c5-1111-2222-3333-444455556666";
const prompt = "Review this checkout without making changes.";
const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

for (const runtime of runtimes) {
  for (const resume of [false, true]) {
    test(`${runtime}: read access preserves the positional prompt on ${resume ? "resume" : "launch"}`, () => {
      const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-read-prompt-"));
      const bin = join(root, "bin");
      const receipt = join(root, "receipt.json");
      mkdirSync(bin);
      // Only the documented grammar used by this invocation: list options consume
      // non-option tokens greedily, while single-value options consume one token.
      writeFileSync(
        join(bin, "claude"),
        `#!${process.execPath}
const args = process.argv.slice(2);
const lists = {};
const positional = [];
const singles = new Set(["--resume", "--model", "--effort", "--output-format", "--permission-mode"]);
const switches = new Set(["-p", "--verbose", "--include-partial-messages"]);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--tools" || arg === "--disallowedTools") {
    const values = [];
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[++i]);
    lists[arg] = values;
  } else if (singles.has(arg)) {
    i++;
  } else if (!switches.has(arg)) {
    if (arg.startsWith("-")) throw new Error("Unexpected fixture option: " + arg);
    positional.push(arg);
  }
}
require("node:fs").writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, lists, positional }));
if (positional.length !== 1) {
  console.error("Input must be provided either through stdin or as a prompt argument when using --print; access read requires argvPlacement: after-prompt");
  process.exit(1);
}
for (const event of [
  { type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} },
  { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } },
  { type: "result", subtype: "success", is_error: false }
]) console.log(JSON.stringify(event));
`,
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          runtime,
          [
            cli,
            "run",
            "claude",
            "--json",
            "--questions",
            "none",
            "--access",
            "read",
            "--model",
            "opus",
            ...(resume ? ["--resume", sessionId] : []),
            "--prompt",
            prompt,
          ],
          {
            cwd: root,
            env: {
              HOME: root,
              PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
              XDG_CONFIG_HOME: root,
              XDG_DATA_HOME: root,
              XDG_STATE_HOME: root,
              HCN_CONFIG_DIR: join(root, "config"),
              HCN_STATE_DIR: join(root, "state"),
            },
            input: "",
            encoding: "utf8",
            timeout: 10000,
          },
        );
        expect(result.error).toBeUndefined();
        const consumed = JSON.parse(readFileSync(receipt, "utf8"));
        expect(
          result.status,
          `access read requires argvPlacement: after-prompt\n${JSON.stringify(consumed)}\n${result.stderr}\n${result.stdout}`,
        ).toBe(0);
        expect(consumed.positional).toEqual([prompt]);
        expect(consumed.lists).toEqual({
          "--tools": ["Read,Grep,Glob,WebFetch,WebSearch"],
          "--disallowedTools": ["mcp__*"],
        });
        for (const flag of ["--tools", "--disallowedTools"]) {
          expect(consumed.args.indexOf(flag)).toBeGreaterThan(consumed.args.indexOf(prompt));
        }
        if (resume) {
          const at = consumed.args.indexOf("--resume");
          expect(consumed.args.slice(at, at + 2)).toEqual(["--resume", sessionId]);
        } else {
          expect(consumed.args).not.toContain("--resume");
        }
        const events = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toContainEqual(
          expect.objectContaining({ kind: "message", role: "assistant", text: "OK" }),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
