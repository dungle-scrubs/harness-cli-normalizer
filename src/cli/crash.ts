import { writeSync } from "node:fs";
import { type FailureSummary, failureFromInternal } from "../execution/failure.js";
import { EXIT_CRASH } from "./exit-codes.js";
import { markCrashed } from "./ledger.js";

/** Crash tier (standards-cli: the error-delivery contract, failure class
 * "uncaught exception"). Every route ends in one structured shape, one
 * dedicated exit code, and one durable ledger end record.
 *
 * Routes:
 * - `reportMainCrash`: a rejected main loop. The event loop is intact, so
 *   writes flush naturally; set the exit code and return.
 * - `handleProcessCrash`: `uncaughtException` / `unhandledRejection`. The
 *   process state is not trustworthy, so delivery is a synchronous stdout
 *   write followed by an explicit exit. */

let jsonStream = false;

/** Marks whether the active command owes a --json stream a terminal pair.
 * Set by run/session once the mode is known (and by refuse, which owns the
 * pair a refused stream is owed). */
export const markJsonCrashStream = (active: boolean): void => {
  jsonStream = active;
};

const detailOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const crashSummary = (kind: string, error: unknown): FailureSummary =>
  failureFromInternal(`${kind}: ${detailOf(error)}`);

/** The failure/done pair a --json stream is owed when hcn itself dies. The
 * done event carries cause "crash" and hcn's own exit code (4): there is no
 * child exit code to report at this point. */
export const writeCrashPair = (summary: FailureSummary): void => {
  process.stdout.write(`${JSON.stringify({ kind: "failure", ...summary })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      kind: "done",
      exitCode: EXIT_CRASH,
      cause: "crash",
      failure: summary,
    })}\n`,
  );
};

const writeStderrLines = (summary: FailureSummary, error: unknown): void => {
  process.stderr.write(`${summary.message}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
};

/** Main-loop failure: natural exit. The exit handler writes the ledger's
 * end line with the final code once the process actually exits. */
export const reportMainCrash = (kind: string, error: unknown): void => {
  const summary = crashSummary(kind, error);
  writeStderrLines(summary, error);
  if (jsonStream) writeCrashPair(summary);
  process.exitCode = EXIT_CRASH;
  markCrashed(summary.message);
};

/** Process-level crash: synchronous delivery, then exit. An uncaught
 * exception leaves the runtime in an unknown state; do not rely on the
 * event loop to flush anything after this. The writer is injectable so
 * tests can capture the synchronous pair without owning fd 1. */
const syncWriteFd1 = (line: string): void => {
  writeSync(1, line);
};

export const handleProcessCrash = (
  kind: string,
  error: unknown,
  write: (line: string) => void = syncWriteFd1,
): never => {
  const summary = crashSummary(kind, error);
  try {
    writeStderrLines(summary, error);
  } catch {
    // stderr may itself be broken; the sync stdout pair below is the
    // consumer's channel.
  }
  if (jsonStream) {
    try {
      write(`${JSON.stringify({ kind: "failure", ...summary })}\n`);
      write(
        `${JSON.stringify({ kind: "done", exitCode: EXIT_CRASH, cause: "crash", failure: summary })}\n`,
      );
    } catch {
      // Last resort failed; exit code 4 still carries the class.
    }
  }
  markCrashed(summary.message);
  process.exit(EXIT_CRASH);
};

export const installCrashHandlers = (): void => {
  process.on("uncaughtException", (error) => {
    handleProcessCrash("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    handleProcessCrash("unhandledRejection", reason);
  });
};
