import { homedir } from "node:os";
import { resolve } from "node:path";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { nodeTranscriptFiles } from "../execution/transcript/files.js";
import type { HarnessListingRequest } from "../execution/transcript/list.js";
import { listSessions } from "../execution/transcript/list.js";
import { emptyTranscript, failure, readTranscript } from "../execution/transcript/read.js";
import { snapshotTranscriptFiles } from "../execution/transcript/snapshot.js";
import type { ReadTranscriptRequest } from "../interpretation/transcript/envelopes.js";
import { encodeJson, TranscriptError } from "../interpretation/transcript/json.js";
import { listingForHarness } from "../interpretation/transcript/listings.js";
import { chooseTranscriptMethod } from "../interpretation/transcript/methods.js";
import type {
  TranscriptListOptions,
  TranscriptOptions,
} from "../interpretation/transcript/options.js";
import {
  parseTranscriptListOptions,
  parseTranscriptOptions,
  transcriptHarness,
} from "../interpretation/transcript/options.js";
import { readerForMethod } from "../interpretation/transcript/readers.js";
import { transcriptCapabilities } from "../interpretation/transcript-capabilities.js";
import { HARNESS_NAMES } from "../knowledge/descriptor.js";
import type { SessionListResult, SessionListSource } from "../knowledge/transcript/listing.js";
import { resolveHarness } from "./resolve-harness.js";
import { transcriptListingRoot, transcriptStoreRoot } from "./store-root.js";
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
/** Whether `transcript read` has a verified method for this harness. */
function transcriptReadable(harness: (typeof HARNESS_NAMES)[number]): boolean {
  const selection = chooseTranscriptMethod(resolveHarness(harness).transcript, {
    acceptedLimits: [],
    selector: "id",
    incremental: false,
    paging: false,
  });
  return selection.method !== null && readerForMethod(selection.method) !== null;
}
function listingRequests(
  harnesses: readonly (typeof HARNESS_NAMES)[number][],
  cwd: string,
): HarnessListingRequest[] {
  const opts = { env: process.env, cwd, home: homedir() };
  return harnesses.map((harness) => {
    const listing = listingForHarness(harness);
    let listingRoot: string | null = null;
    try {
      listingRoot = listing ? transcriptListingRoot(harness, opts) : null;
    } catch {
      listingRoot = null;
    }
    return {
      harness,
      listing: listingRoot ? listing : null,
      listingRoot,
      readable: transcriptReadable(harness),
      divergence: listing
        ? listingRoot
          ? null
          : `${harness} declares no resolvable native session store.`
        : `${harness} has no transcript listing method in v1; listing reports divergence.`,
    };
  });
}
async function refuseList(version: string, error: unknown, raw: readonly string[]): Promise<void> {
  const source: SessionListSource = {
    schemaVersion: 1,
    kind: "session-list-source",
    hcnVersion: version,
    harnesses: [],
    scope: {
      workspace: raw.includes("--all-workspaces") ? null : process.cwd(),
      headless: raw.includes("--headless"),
      limit: null,
    },
  };
  const result: SessionListResult = {
    schemaVersion: 1,
    kind: "session-list-result",
    exitCode: 2,
    status: "refused",
    rowsReturned: 0,
    more: false,
    harnesses: [],
    failure: failure(
      error instanceof TranscriptError ? error.issue : "invalid-option-value",
      "validate",
      "input",
      error instanceof TranscriptError ? error.message : "Invalid transcript list arguments.",
    ),
  };
  await writeTranscriptLine(`${encodeJson(source)}\n`);
  await writeTranscriptLine(`${encodeJson(result)}\n`);
  process.exitCode = 2;
}
export async function transcriptList(raw: readonly string[]): Promise<void> {
  const version = getVersion();
  let options: TranscriptListOptions;
  try {
    options = parseTranscriptListOptions(raw);
  } catch (error) {
    await refuseList(version, error, raw);
    return;
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const abort = new AbortController();
  const interrupt = (): void => abort.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const deps = nodeRunnerDeps();
    process.exitCode = await listSessions(
      {
        harnesses: listingRequests(
          options.harnesses.length ? options.harnesses : [...HARNESS_NAMES],
          cwd,
        ),
        hcnVersion: version,
        workspace: options.allWorkspaces ? null : cwd,
        headless: options.headless,
        limit: options.limit,
      },
      {
        files: nodeTranscriptFiles,
        snapshotFiles: snapshotTranscriptFiles({ deps, signal: abort.signal }),
        signal: abort.signal,
        write: writeTranscriptLine,
      },
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
export async function transcript(raw: string[]): Promise<void> {
  if (raw[0] === "ls") return transcriptList(raw.slice(1));
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
  const knowledge = resolveHarness(options.harness).transcript;
  if (knowledge === null) {
    const request: ReadTranscriptRequest = {
      nativeStoreRoot: "",
      selection: options.id
        ? { kind: "id", nativeId: options.id }
        : { kind: "file", path: resolve(options.cwd ?? process.cwd(), options.file ?? "") },
      limit: options.limit,
      since: options.since,
      acceptedLimits: options.acceptedLimits,
      harness: options.harness,
      hcnVersion: version,
      workspace: resolve(options.cwd ?? process.cwd()),
    };
    const { result, source } = emptyTranscript(request);
    if (options.id)
      source.selection = {
        kind: "id",
        storeRoots: [],
        value: options.id,
        workspace: request.workspace,
      };
    result.failure = failure(
      "transcript-divergence",
      "validate",
      "retrieval",
      `${options.harness} has no transcript surface in v1; transcript reads report divergence.`,
    );
    await writeTranscriptLine(`${encodeJson(source)}\n`);
    await writeTranscriptLine(`${encodeJson(result)}\n`);
    process.exitCode = 2;
    return;
  }
  const workspace = resolve(options.cwd ?? process.cwd());
  const storeRoot = transcriptStoreRoot(options.harness, {
    env: process.env,
    cwd: workspace,
    home: homedir(),
  });
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
    const deps = nodeRunnerDeps();
    process.exitCode = await readTranscript(request, {
      reader,
      clock: deps.clock,
      files:
        reader.consistency === "snapshot"
          ? snapshotTranscriptFiles({
              deps,
              signal: abort.signal,
              cleanupTimeoutMs: reader.method.cleanupTimeoutMs,
            })
          : nodeTranscriptFiles,
      signal: abort.signal,
      write: writeTranscriptLine,
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
