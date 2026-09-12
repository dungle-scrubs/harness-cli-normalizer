import { homedir } from "node:os";
import { resolve } from "node:path";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { nodeTranscriptFiles } from "../execution/transcript/files.js";
import { emptyTranscript, failure, readTranscript } from "../execution/transcript/read.js";
import type { ReadTranscriptRequest } from "../interpretation/transcript/envelopes.js";
import { encodeJson, TranscriptError } from "../interpretation/transcript/json.js";
import { chooseTranscriptMethod } from "../interpretation/transcript/methods.js";
import type { TranscriptOptions } from "../interpretation/transcript/options.js";
import { parseTranscriptOptions, transcriptHarness } from "../interpretation/transcript/options.js";
import { readerForMethod } from "../interpretation/transcript/readers.js";
import { transcriptCapabilities } from "../interpretation/transcript-capabilities.js";
import { resolveHarness } from "./resolve-harness.js";
import { getVersion } from "./version.js";

export function writeTranscriptLine(line: string): Promise<void> {
  return new Promise<void>((done, reject) =>
    process.stdout.write(line, (error) => (error ? reject(error) : done())),
  );
}
export async function inspectTranscript(
  harnessName: string | undefined,
  args: readonly string[],
): Promise<void> {
  const harness = transcriptHarness(harnessName);
  const issue = args.some((arg) => arg === "--argv" || arg === "--capabilities")
    ? "mutually-exclusive-options"
    : "invalid-option-value";
  if (!harness || args.length !== 1 || args[0] !== "--transcript") {
    process.exitCode = 2;
    await writeTranscriptLine(
      `${encodeJson({
        exitCode: 2,
        failure: failure(issue, "validate", "input", "Invalid transcript inspection arguments."),
        harness,
        hcnVersion: getVersion(),
        kind: "transcript-inspection-error",
        schemaVersion: 1,
      })}\n`,
    );
    return;
  }
  await writeTranscriptLine(
    `${encodeJson(transcriptCapabilities(resolveHarness(harness), getVersion()))}\n`,
  );
}
export async function transcript(raw: string[]): Promise<void> {
  const version = getVersion();
  let options: TranscriptOptions;
  try {
    options = parseTranscriptOptions(raw);
  } catch (error) {
    const request = {
      acceptedLimits: [],
      selection: { kind: "unknown" as const },
      harness: transcriptHarness(raw[1]),
      hcnVersion: version,
      workspace: process.cwd(),
    };
    const { result, source } = emptyTranscript(request);
    if (raw.some((arg) => arg === "--since" || arg.startsWith("--since=")))
      result.continuation = { input: "not-checked", output: "unavailable" };
    result.failure = failure(
      error instanceof TranscriptError ? error.issue : "invalid-option-value",
      "validate",
      "input",
      error instanceof TranscriptError ? error.message : "Invalid transcript arguments.",
    );
    await writeTranscriptLine(`${encodeJson(source)}\n`);
    await writeTranscriptLine(`${encodeJson(result)}\n`);
    process.exitCode = 2;
    return;
  }
  const workspace = resolve(options.cwd ?? process.cwd());
  const storeRoot =
    options.harness === "codex"
      ? resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"))
      : resolve(
          process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi", "agent"),
          "sessions",
          `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
        );
  const request: ReadTranscriptRequest = {
    nativeStoreRoot: storeRoot,
    selection: options.id
      ? { kind: "id", nativeId: options.id }
      : { kind: "file", path: resolve(workspace, options.file ?? "") },
    limit: options.limit,
    since: options.since,
    acceptedLimits: options.acceptedLimits,
    harness: options.harness,
    hcnVersion: version,
    workspace,
  };
  const knowledge = resolveHarness(options.harness).transcript;
  const selection = chooseTranscriptMethod(knowledge, {
    acceptedLimits: options.acceptedLimits,
    selector: request.selection.kind,
    incremental: options.since !== null,
    paging: options.limit !== null,
  });
  const reader = selection.method ? readerForMethod(selection.method) : null;
  if (selection.failure || !reader) {
    const { result, source } = emptyTranscript(request);
    if (options.id) source.selection = { kind: "id", storeRoots: [], value: options.id, workspace };
    result.failure =
      selection.failure ??
      failure(
        "transcript-unverified",
        "validate",
        "retrieval",
        "The selected method has no verified reader.",
      );
    await writeTranscriptLine(`${encodeJson(source)}\n`);
    await writeTranscriptLine(`${encodeJson(result)}\n`);
    process.exitCode = 2;
    return;
  }
  const abort = new AbortController();
  const interrupt = (): void => abort.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await readTranscript(request, {
      reader,
      clock: nodeRunnerDeps().clock,
      files: nodeTranscriptFiles,
      signal: abort.signal,
      write: writeTranscriptLine,
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
