import { fstatSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { env } from "node:process";
import { mergeEnvironment } from "../execution/environment.js";
import { runInteractive } from "../execution/interactive.js";
import { preflightInteractive } from "../execution/interactive-preflight.js";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import {
  interactiveControlAddress,
  makeInteractiveRecord,
  parseInteractiveRequest,
} from "../interpretation/interactive.js";
import { INTERACTIVE_HELP } from "./help.js";

function writeControl(fd: number, record: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("Control write made no progress");
    offset += written;
  }
}

/** Control failures never redirect records to the inherited native terminal. */
export async function interactive(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(INTERACTIVE_HELP);
    return;
  }
  const control = interactiveControlAddress(args);
  if (!control) {
    process.stderr.write("interactive requires an unambiguous launch ID and control fd >= 3.\n");
    process.exitCode = 1;
    return;
  }
  try {
    const pipe = fstatSync(control.fd);
    if (!pipe.isFIFO() && !pipe.isSocket()) throw new Error("Control fd is not a pipe");
    const emit = (record: unknown): void => writeControl(control.fd, record);
    const request = parseInteractiveRequest(args);
    if (!request) {
      emit(
        makeInteractiveRecord(control.launchId, {
          evidence: "spawn-not-attempted",
          kind: "refused",
          reason: "invalid-request",
        }),
      );
      process.exitCode = 2;
      return;
    }
    const controller = new AbortController();
    const environment = mergeEnvironment(env, request.environment);
    const stop = (): void => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      process.exitCode = await runInteractive(request, nodeRunnerDeps(), {
        emit,
        preflight: () =>
          preflightInteractive(request, {
            codexHome: environment.CODEX_HOME,
            home: environment.HOME ?? homedir(),
            searchPath: environment.PATH ?? "/usr/bin:/bin",
          }),
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  } catch {
    process.stderr.write(
      "Interactive control is unavailable. Check launch status before retrying.\n",
    );
  }
  process.exitCode = 1;
}
