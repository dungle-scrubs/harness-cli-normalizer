import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";

// Synthetic native control peer, not a captured harness recording.
function fixture(
  version = claudeCode.verifiedAgainst,
  paused = false,
  totalTokens = 25000,
): {
  readonly dir: string;
  readonly run: (args: readonly string[]) => ReturnType<typeof spawnSync>;
} {
  const dir = mkdtempSync(join(tmpdir(), "hcn-context-"));
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
fs.writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
fs.writeFileSync("pid", String(process.pid));
const send = value => console.log(JSON.stringify(value));
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  if (${JSON.stringify(paused)}) return;
  const frame = JSON.parse(line);
  if (frame.type === "user") {
    fs.writeFileSync("staged.json", line);
    if (frame.shouldQuery !== false) process.exit(71);
    send(frame);
  } else if (frame.request.subtype === "initialize") {
    send({type:"control_response",response:{subtype:"success",request_id:frame.request_id,response:{}}});
  } else {
    send({type:"control_response",response:{subtype:"success",request_id:frame.request_id,response:{model:"claude-opus-5",totalTokens:${totalTokens},maxTokens:1000000,autoCompactThreshold:967000,isAutoCompactEnabled:true}}});
  }
});


`,
    { mode: 0o700 },
  );
  return {
    dir,
    run: (args) =>
      spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          "claude",
          "--context",
          "--json",
          "--model",
          "opus",
          "--effort",
          "high",
          "--prompt",
          "Pending request",
          ...args,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            PATH: `${dir}:${env.PATH ?? ""}`,
          },
        },
      ),
  };
}

test("public accounting binds provenance, stages the composed prompt and forks resume", () => {
  const { dir, run } = fixture();
  try {
    const result = run(["--resume", "11111111-1111-4111-8111-111111111111"]);
    expect(result.status, String(result.stderr)).toBe(0);
    const output = JSON.parse(String(result.stdout));
    expect(output).toMatchObject({
      v: 1,
      harness: "claude",
      mode: "headless-turn",
      executable: { path: realpathSync(join(dir, "claude")), version: claudeCode.verifiedAgainst },
      accounting: {
        status: "available",
        method: "native-context-estimate",
        model: "claude-opus-5",
        totalTokens: 25000,
        inputLimitTokens: 967000,
      },
    });
    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
    expect(argv).toContain("--fork-session");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain("Pending request");
    const staged = JSON.parse(readFileSync(join(dir, "staged.json"), "utf8"));
    expect(staged.shouldQuery).toBe(false);
    expect(staged.message.content).toContain("hcn-question");
    expect(staged.message.content).toContain("Pending request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a matching version cannot authorize malformed accounting", () => {
  const { dir, run } = fixture(claudeCode.verifiedAgainst, false, -1);
  try {
    const result = run([]);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout)).accounting).toEqual({
      status: "unavailable",
      reason: "protocol",
    });
    expect(JSON.parse(readFileSync(join(dir, "staged.json"), "utf8")).shouldQuery).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["codex", "pi", "muse"])(
  "%s version-independent invocation support does not fabricate context accounting",
  (harness) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-unavailable-context-"));
    writeFileSync(join(dir, harness), "#!/bin/sh\nprintf '999.0.0\\n'\n", { mode: 0o700 });
    try {
      const result = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          harness,
          "--context",
          "--json",
          "--prompt",
          "Pending request",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 10_000,
          env: { HOME: dir, XDG_CONFIG_HOME: dir, PATH: `${dir}:${env.PATH ?? ""}` },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        resume: { status: "supported" },
        accounting: { status: "unavailable", reason: "unsupported-adapter" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("summary accounting preserves tool-free isolation and does not inject the question contract twice", () => {
  const { dir, run } = fixture();
  try {
    const result = run(["--isolation", "tool-free", "--questions", "none"]);
    expect(result.status, String(result.stderr)).toBe(0);
    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
    expect(argv).toContain("--bare");
    expect(argv).toContain("--tools");
    expect(argv).not.toContain("--fork-session");
    const staged = JSON.parse(readFileSync(join(dir, "staged.json"), "utf8"));
    expect(staged.message.content).toBe("Pending request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["0.0.0", "no version available"])(
  "accounting validates the operation independent of version metadata: %s",
  (version) => {
    const { dir, run } = fixture(version);
    try {
      const result = run([]);
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout)).accounting).toMatchObject({
        status: "available",
        totalTokens: 25000,
      });
      expect(JSON.parse(readFileSync(join(dir, "staged.json"), "utf8")).shouldQuery).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([
  { args: ["--runtime"] },
  { args: ["--mode", "interactive"] },
  { args: ["--mode", "headless-session"] },
  { args: ["--", "--model", "other"] },
])("accounting refuses incompatible request $args", ({ args }) => {
  const { dir, run } = fixture();
  try {
    const result = run(args);
    expect(result.status, String(result.stderr)).toBe(2);
    expect(() => readFileSync(join(dir, "argv.json"))).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a positive inspection timeout bounds native preparation", () => {
  const { dir, run } = fixture(claudeCode.verifiedAgainst, true);
  try {
    const result = run(["--timeout", "1"]);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout)).accounting).toEqual({
      status: "unavailable",
      reason: "timeout",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI interruption cancels the probe, reaps its native child and exits with failure", async () => {
  const { dir } = fixture(claudeCode.verifiedAgainst, true);
  const child = spawn(
    "bun",
    [
      resolve("src/cli/index.ts"),
      "inspect",
      "claude",
      "--context",
      "--json",
      "--prompt",
      "Pending",
    ],
    {
      cwd: dir,
      env: {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        PATH: `${dir}:${env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  let nativePid: number | undefined;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        nativePid = Number(readFileSync(join(dir, "pid"), "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(nativePid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    expect(await exited).toBe(1);
    expect(JSON.parse(output).accounting).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(() => process.kill(nativePid ?? 0, 0)).toThrow();
  } finally {
    child.kill("SIGKILL");
    if (nativePid !== undefined) {
      try {
        process.kill(nativePid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
