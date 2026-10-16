import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

interface CacheRecord {
  readonly command: "pack" | "publish";
  readonly outcome: "accepted" | "rejected";
  readonly cache: string;
}

const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const checker = readFileSync(new URL("../scripts/check-package.ts", import.meta.url), "utf8");

function runPackageCheck(mode: "npm11" | "npm12" | "pack-failure" | "publish-rewrite") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-package-check-test-")));
  try {
    const repository = join(root, "repo");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const temp = join(root, "temp with spaces");
    const trace = join(root, "npm.jsonl");
    const cliTrace = join(root, "cli-state.txt");
    for (const directory of [
      join(repository, "scripts"),
      join(repository, "dist"),
      bin,
      home,
      temp,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(temp, "retained"), "caller artifact");
    writeFileSync(join(repository, "scripts/check-package.ts"), checker);
    writeFileSync(
      join(repository, "package.json"),
      JSON.stringify({
        name: "@dungle-scrubs/harness-cli-normalizer",
        type: "module",
        publishConfig: { access: "public" },
        bin: { hcn: "dist/cli.js" },
      }),
    );
    writeFileSync(
      join(repository, "dist/cli.js"),
      `import fs from "node:fs";
import path from "node:path";
const state = process.env.HCN_STATE_DIR;
if (!state || !state.startsWith(process.env.FIXTURE_TMP + path.sep)) process.exit(96);
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, "fixture-ledger"), "owned CLI effect");
fs.writeFileSync(process.env.FIXTURE_CLI_TRACE, state);
console.log("0.0.0");
`,
    );
    symlinkSync(node, join(bin, "node"));
    writeFileSync(
      join(bin, "npm"),
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const index = args.indexOf("--cache");
const explicit = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith("--cache="))?.slice(8);
const cache = explicit || process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || path.join(process.env.HOME, ".npm");
const relative = path.relative(process.env.FIXTURE_TMP, cache);
const owned = relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
fs.appendFileSync(process.env.FIXTURE_NPM_TRACE, JSON.stringify({ command: args[0], outcome: owned ? "accepted" : "rejected", cache }) + "\n");
if (!owned) {
  console.error("fixture npm: cache must be owned before any write");
  process.exit(97);
}
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, "fixture-cache"), "owned npm effect");
if (args[0] === "pack" && process.env.FIXTURE_MODE === "pack-failure") {
  console.error("fixture npm pack failure after cache write");
  process.exit(99);
}
if (args[0] === "pack") {
  const files = ["dist/cli.js", "dist/cli/index.js", "LICENSE", "README.md", "package.json", "skills/hcn/SKILL.md", "skills/hcn/scripts/check-claims.sh"];
  const packed = { files: files.map(path => ({ path })) };
  console.log(JSON.stringify(process.env.FIXTURE_MODE === "npm12" ? { "@dungle-scrubs/harness-cli-normalizer": packed } : [packed]));
} else if (args[0] === "publish") {
  console.error("npm notice name: @dungle-scrubs/harness-cli-normalizer");
  if (process.env.FIXTURE_MODE === "publish-rewrite") console.error("npm warn package.json auto-corrected");
  process.exitCode = 1;
} else process.exit(98);
`,
      { mode: 0o755 },
    );
    const result = spawnSync(node, [join(repository, "scripts/check-package.ts")], {
      cwd: repository,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: bin,
        HOME: home,
        TMPDIR: temp,
        NPM_CONFIG_CACHE: join(root, "uppercase caller cache"),
        npm_config_cache: join(root, "lowercase caller cache"),
        FIXTURE_TMP: temp,
        FIXTURE_MODE: mode,
        FIXTURE_NPM_TRACE: trace,
        FIXTURE_CLI_TRACE: cliTrace,
      },
    });
    const records = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line): CacheRecord => JSON.parse(line));
    return {
      result,
      records,
      temp,
      cliState: existsSync(cliTrace) ? readFileSync(cliTrace, "utf8") : null,
      remaining: readdirSync(temp),
      callerArtifact: readFileSync(join(temp, "retained"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(["npm11", "npm12"] as const)("package checking owns its temporary cache (%s)", (mode) => {
  const { result, records, cliState, remaining, callerArtifact, temp } = runPackageCheck(mode);
  expect(result.status, result.stderr).toBe(0);
  expect(records.map(({ command }) => command)).toContain("pack");
  expect(records.map(({ command }) => command)).toContain("publish");
  expect(records.filter(({ outcome }) => outcome === "rejected")).toEqual([]);
  expect(cliState).toContain(`${temp}/`);
  expect(remaining).toEqual(["retained"]);
  expect(callerArtifact).toBe("caller artifact");
});

test("package checking removes its cache when npm pack fails", () => {
  const { result, records, remaining, callerArtifact } = runPackageCheck("pack-failure");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("fixture npm pack failure after cache write");
  expect(records.find(({ command }) => command === "pack")?.outcome).toBe("accepted");
  expect(remaining).toEqual(["retained"]);
  expect(callerArtifact).toBe("caller artifact");
});

test("package checking removes its cache when npm would rewrite the manifest", () => {
  const { result, records, remaining, callerArtifact } = runPackageCheck("publish-rewrite");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("npm publish would rewrite package.json");
  expect(records.find(({ command }) => command === "publish")?.outcome).toBe("accepted");
  expect(remaining).toEqual(["retained"]);
  expect(callerArtifact).toBe("caller artifact");
});
