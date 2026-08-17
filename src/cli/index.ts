#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TOP_LEVEL_HELP } from "./help.js";
import { getVersion } from "./version.js";

const SUPPORTED = ["claude", "codex", "pi", "muse"] as const;

// Prevent EPIPE crashes when piped to head/grep -q (e.g., hcn ls | head, hcn run --json | head)
process.stdout.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPIPE") process.exit(0);
});
process.stderr.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPIPE") process.exit(0);
});

const printVersion = (): void => {
  process.stdout.write(`${getVersion()}\n`);
};

const printTopHelp = (): void => {
  process.stdout.write(TOP_LEVEL_HELP);
};

export const failUnknownHarness = (name: string): never => {
  process.stderr.write(
    `unknown harness ${JSON.stringify(name)}; supported: ${SUPPORTED.join(", ")}\n`,
  );
  process.stderr.write(`supported: ${SUPPORTED.join(", ")}\n`);
  process.exitCode = 2;
  // Use process.exit to ensure exit code is set even if async
  process.exit(2);
};

export const dispatch = async (raw: string[]): Promise<void> => {
  // Shared dispatch for programmatic use (tests) - mirrors main but takes argv slice
  // Global --help / --version without command
  if (raw.length === 0 || raw[0] === "--help" || raw[0] === "-h") {
    if (raw.includes("--version") || raw.includes("-V")) {
      printVersion();
      return;
    }
    printTopHelp();
    return;
  }
  if (raw[0] === "--version" || raw[0] === "-V") {
    printVersion();
    return;
  }

  const cmd = raw[0] as string;

  switch (cmd) {
    case "ls": {
      if (raw.includes("--help") || raw.includes("-h")) {
        const { LS_HELP } = await import("./help.js");
        process.stdout.write(LS_HELP);
        return;
      }
      if (raw.includes("--version") || raw.includes("-V")) {
        printVersion();
        return;
      }
      if (raw.length > 1) {
        const extra = raw.slice(1);
        const hasUnknown = extra.some((a) => a.startsWith("-"));
        if (hasUnknown) {
          process.stderr.write(`unknown flag for ls: ${extra.join(" ")}\n`);
          process.exitCode = 2;
          return;
        }
      }
      const { ls } = await import("./ls.js");
      ls();
      return;
    }
    case "check": {
      const { check } = await import("./check.js");
      await check(raw.slice(1));
      return;
    }
    case "inspect": {
      if (raw.slice(1).includes("--help") || raw.slice(1).includes("-h")) {
        const { INSPECT_HELP } = await import("./help.js");
        process.stdout.write(INSPECT_HELP);
        return;
      }
      const harness = raw[1];
      if (!harness || harness.startsWith("-")) {
        process.stderr.write(`inspect requires <harness>; supported: ${SUPPORTED.join(", ")}\n`);
        process.exitCode = 2;
        return;
      }
      if (!(SUPPORTED as readonly string[]).includes(harness)) failUnknownHarness(harness);
      const { inspect } = await import("./inspect.js");
      await inspect(harness, raw.slice(2));
      return;
    }
    case "run": {
      if (raw.slice(1).includes("--help") || raw.slice(1).includes("-h")) {
        const { RUN_HELP } = await import("./help.js");
        process.stdout.write(RUN_HELP);
        return;
      }
      if (raw.slice(1).includes("--version") || raw.slice(1).includes("-V")) {
        printVersion();
        return;
      }
      const harness = raw[1];
      if (!harness || harness.startsWith("-")) {
        process.stderr.write(`run requires <harness>; supported: ${SUPPORTED.join(", ")}\n`);
        process.exitCode = 2;
        return;
      }
      if (!(SUPPORTED as readonly string[]).includes(harness)) failUnknownHarness(harness);
      const { run } = await import("./run.js");
      await run(harness, raw.slice(2));
      return;
    }
    case "session": {
      if (raw.slice(1).includes("--help") || raw.slice(1).includes("-h")) {
        const { SESSION_HELP } = await import("./help.js");
        process.stdout.write(SESSION_HELP);
        return;
      }
      const harness = raw[1];
      if (!harness || harness.startsWith("-")) {
        process.stderr.write(`session requires <harness>; supported: ${SUPPORTED.join(", ")}\n`);
        process.exitCode = 2;
        return;
      }
      if (!(SUPPORTED as readonly string[]).includes(harness)) failUnknownHarness(harness);
      const { session } = await import("./session.js");
      await session(harness, raw.slice(2));
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      printTopHelp();
      return;
    }
    default: {
      if ((SUPPORTED as readonly string[]).includes(cmd)) {
        process.stderr.write(`missing command; did you mean 'hcn run ${cmd} <prompt>'?\n`);
        process.stderr.write(TOP_LEVEL_HELP);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`unknown command ${JSON.stringify(cmd)}\n`);
      process.stderr.write(TOP_LEVEL_HELP);
      process.exitCode = 2;
      return;
    }
  }
};

export const main = async (): Promise<void> => {
  await dispatch(process.argv.slice(2));
};

// The bin entry invokes this directly. Auto-run below covers direct
// execution of this module itself (node dist/cli/index.js, bun src/cli/index.ts).
export const run = (): void => {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${message}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
};

// Run only when this module is the process main entry. process.argv[1] is
// the path as invoked - a bin symlink such as npm's `hcn` keeps its link
// name - while import.meta.url is this file's realpath, so resolving argv[1]
// the same way survives symlinks. Filename suffix sniffing cannot (issue #33).
const isMainEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
})();

if (isMainEntry) run();
