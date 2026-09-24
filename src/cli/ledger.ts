import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Durable command ledger (standards-cli: durable start/end records).
 *
 * One JSON line is appended before work begins; the end line is written by
 * the process `exit` handler with the FINAL exit code, so a crash after the
 * command stream finished still records the truthful code (the crash tier
 * marks the record via `markCrashed`). A start with no end is the trace of
 * a hung or SIGKILLed invocation - the one death that fires no event.
 * Appends are diagnostics: a failed append must never fail the command.
 *
 * Root resolution honors `HCN_STATE_DIR`, then `XDG_STATE_HOME`, then the
 * XDG default `~/.local/state/hcn`. Read at call time so tests can point
 * it at a temp directory. */
const stateDir = (): string => {
  const override = process.env.HCN_STATE_DIR;
  if (override && override !== "") return override;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg !== "") return join(xdg, "hcn");
  return join(homedir(), ".local", "state", "hcn");
};

export const commandLedgerPath = (): string => join(stateDir(), "commands.jsonl");

interface Pending {
  readonly command: string;
}

let pending: Pending | null = null;
let crashed: { message: string } | null = null;
let exitHandlerInstalled = false;

const append = (entry: Record<string, unknown>): void => {
  try {
    const path = commandLedgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is diagnostics; a failed append must not fail the command.
  }
};

/** The exit handler: the only end-record writer in production. Fires on
 * natural exit, on `process.exit` (including the crash tier's exit 4), and
 * on signal-induced exits - never on SIGKILL, which is exactly the
 * start-without-end trace. */
export const recordExit = (code: number): void => {
  if (pending === null) return;
  append({
    at: new Date().toISOString(),
    command: pending.command,
    event: "end",
    exit: code,
    ok: code === 0,
    ...(crashed !== null ? { crashed: true, message: crashed.message } : {}),
  });
  pending = null;
};

const installExitHandlerOnce = (): void => {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", (code) => {
    recordExit(typeof code === "number" ? code : 0);
  });
};

/** Append the start line before work. `command` is the subcommand name, or
 * "hcn" for a bare invocation. Also installs the exit handler that will
 * write this invocation's end line. */
export const beginCommandRecord = (command: string | undefined): void => {
  pending = { command: command && command !== "" ? command : "hcn" };
  crashed = null;
  append({
    at: new Date().toISOString(),
    command: pending.command,
    event: "start",
    pid: process.pid,
  });
  installExitHandlerOnce();
};

/** The crash tier marks the pending record before the process exits; the
 * exit handler turns it into a `crashed: true` end line. */
export const markCrashed = (message: string): void => {
  if (pending === null) return;
  crashed = { message };
};
