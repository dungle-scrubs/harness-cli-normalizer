#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FailureSummary } from "../execution/failure.js";
import { HARNESS_NAMES } from "../knowledge/descriptor.js";
import { installCrashHandlers, reportMainCrash } from "./crash.js";
import { EXIT_REFUSAL } from "./exit-codes.js";
import { TOP_LEVEL_HELP } from "./help.js";
import { beginCommandRecord } from "./ledger.js";
import { handleOutputError } from "./output-errors.js";
import { writeFailurePair } from "./refuse.js";
import { getVersion } from "./version.js";

/** The one harness list, read from the descriptor vocabulary. */
const SUPPORTED: readonly string[] = HARNESS_NAMES;

let strictOutput = false;

// Prevent EPIPE crashes when piped to head/grep -q (e.g., hcn ls | head, hcn run --json | head)
const outputError = (error: NodeJS.ErrnoException): void => handleOutputError(error, strictOutput);
process.stdout.on("error", outputError);
process.stderr.on("error", outputError);

const printVersion = (): void => {
  process.stdout.write(`${getVersion()}\n`);
};

const printTopHelp = (): void => {
  process.stdout.write(TOP_LEVEL_HELP);
};

/** Dispatch-level usage failure: stderr for humans, the structured pair a
 * --json stream is owed when --json is in argv, exit 2 either way. */
const usageFailureSummary = (message: string): FailureSummary => ({
  class: "rejected",
  retryable: false,
  message,
});

const usageFailure = (message: string, json: boolean, help = false): void => {
  process.stderr.write(`${message}\n`);
  if (help) process.stderr.write(TOP_LEVEL_HELP);
  if (json) writeFailurePair(usageFailureSummary(message));
  process.exitCode = EXIT_REFUSAL;
};

export const failUnknownHarness = (name: string, json = false): void => {
  usageFailure(`unknown harness ${JSON.stringify(name)}; supported: ${SUPPORTED.join(", ")}`, json);
};

export const dispatch = async (raw: string[]): Promise<void> => {
  strictOutput = raw[0] === "transcript" || (raw[0] === "inspect" && raw.includes("--transcript"));
  // Dispatch-level usage failures must join the output contract too: when
  // --json is anywhere in argv, the pair goes to stdout even though the
  // command never ran (standards-cli: parser errors join the output contract).
  const jsonOutput = raw.includes("--json");
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
    case "transcript": {
      if (raw.includes("--version") || raw.includes("-V")) {
        printVersion();
        return;
      }
      if (raw.includes("--help") || raw.includes("-h")) {
        const { TRANSCRIPT_HELP } = await import("./help.js");
        process.stdout.write(TRANSCRIPT_HELP);
        return;
      }
      const { transcript } = await import("./transcript.js");
      await transcript(raw.slice(1));
      return;
    }
    case "interactive": {
      const { interactive } = await import("./interactive.js");
      await interactive(raw.slice(1));
      return;
    }
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
          usageFailure(`unknown flag for ls: ${extra.join(" ")}`, jsonOutput);
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
      if (raw.includes("--transcript")) {
        const { inspectTranscript } = await import("./transcript.js");
        await inspectTranscript(raw[1], raw.slice(2));
        return;
      }
      const harness = raw[1];
      if (!harness || harness.startsWith("-")) {
        usageFailure(`inspect requires <harness>; supported: ${SUPPORTED.join(", ")}`, jsonOutput);
        return;
      }
      if (!(SUPPORTED as readonly string[]).includes(harness)) {
        failUnknownHarness(harness, jsonOutput);
        return;
      }
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
        usageFailure(`run requires <harness>; supported: ${SUPPORTED.join(", ")}`, jsonOutput);
        return;
      }
      if (!(SUPPORTED as readonly string[]).includes(harness)) {
        failUnknownHarness(harness, jsonOutput);
        return;
      }
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
        usageFailure(`session requires <harness>; supported: ${SUPPORTED.join(", ")}`, jsonOutput);
        return;
      }
      if (!(SUPPORTED as readonly string[]).includes(harness)) {
        failUnknownHarness(harness, jsonOutput);
        return;
      }
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
        usageFailure(`missing command; did you mean 'hcn run ${cmd} <prompt>'?`, jsonOutput, true);
        return;
      }
      usageFailure(`unknown command ${JSON.stringify(cmd)}`, jsonOutput, true);
      return;
    }
  }
};

export const main = async (): Promise<void> => {
  await dispatch(process.argv.slice(2));
};

// The bin entry invokes this directly. Auto-run below covers direct
// execution of this module itself (node dist/cli/index.js, bun src/cli/index.ts).
// Crash handlers and the durable ledger live here, not in dispatch, so
// programmatic dispatch (tests) stays side-effect free.
export const run = (): void => {
  installCrashHandlers();
  beginCommandRecord(process.argv[2]);
  // The ledger's end line is written by the process exit handler with the
  // final exit code, so a crash after the stream finished still records
  // the truthful code. Only the crash path needs a catch here.
  main().catch((err: unknown) => {
    reportMainCrash("uncaught in main", err);
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
