import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptError } from "../../interpretation/transcript/json.js";
import { TRANSCRIPT_SNAPSHOT } from "../../knowledge/transcript/snapshot.js";
import type { RunnerDeps } from "../deps.js";
import type { TranscriptFile, TranscriptFiles } from "./files.js";
import { nodeTranscriptFiles } from "./files.js";

interface SnapshotOptions {
  readonly cloneExecutable?: string;
  readonly deps: RunnerDeps;
  readonly cleanupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly temporaryRoot?: string;
}
interface SnapshotFiles extends TranscriptFiles {
  snapshot(path: string): Promise<TranscriptFile>;
}

async function cloneSource(
  options: SnapshotOptions,
  path: string,
  destination: string,
): Promise<void> {
  const { deps } = options;
  if (options.signal?.aborted)
    throw new TranscriptError("interrupted", "The caller interrupted snapshot acquisition.");
  const target =
    process.platform === "darwin" ? "darwin-universal" : `${process.platform}-${process.arch}`;
  const executable =
    options.cloneExecutable ??
    fileURLToPath(
      new URL(
        `../../../dist/execution/transcript/native/${target}/hcn-transcript-clone`,
        import.meta.url,
      ),
    );
  let child: ReturnType<RunnerDeps["spawn"]>;
  try {
    child = deps.spawn([executable, path, destination], { stdin: "close" });
  } catch {
    throw new TranscriptError(
      "guarantee-unmet",
      "The packaged filesystem snapshot helper is unavailable.",
      "consistency",
    );
  }
  let exited = false;
  const exit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const drain = async (stream: AsyncIterable<string | Uint8Array>): Promise<void> => {
    for await (const _chunk of stream) {
      /* The helper emits no transcript content. */
    }
  };
  const output = Promise.all([drain(child.stdout), drain(child.stderr)]);
  const completed = Promise.all([exit, output]);
  let timer: number | undefined;
  let interrupt: (() => void) | undefined;
  try {
    const [code] = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timer = deps.clock.setTimeout(
          () =>
            reject(
              new TranscriptError(
                "native-read-failed",
                "Filesystem snapshot acquisition timed out.",
                "consistency",
              ),
            ),
          TRANSCRIPT_SNAPSHOT.acquisitionTimeoutMs,
        );
        interrupt = () =>
          reject(
            new TranscriptError("interrupted", "The caller interrupted snapshot acquisition."),
          );
        options.signal?.addEventListener("abort", interrupt, { once: true });
        if (options.signal?.aborted) interrupt();
      }),
    ]);
    if (code !== 0)
      throw new TranscriptError(
        code === 3 ? "source-not-found" : code === 4 ? "source-inaccessible" : "guarantee-unmet",
        "The filesystem could not clone the native source.",
        code === 3 || code === 4 ? "identity" : "consistency",
      );
  } catch (error) {
    if (!exited) {
      try {
        deps.signal(child, "SIGKILL");
      } catch {
        if (error instanceof TranscriptError) error.cleanupFailed = true;
      }
    }
    let cleanupTimer: number | undefined;
    try {
      await Promise.race([
        Promise.allSettled([exit, output]),
        new Promise<never>((_, reject) => {
          cleanupTimer = deps.clock.setTimeout(
            () =>
              reject(new TranscriptError("cleanup-failed", "Snapshot helper cleanup timed out.")),
            options.cleanupTimeoutMs ?? TRANSCRIPT_SNAPSHOT.cleanupTimeoutMs,
          );
        }),
      ]);
    } catch {
      if (error instanceof TranscriptError) error.cleanupFailed = true;
    } finally {
      if (cleanupTimer !== undefined) deps.clock.clearTimeout(cleanupTimer);
    }
    throw error;
  } finally {
    if (timer !== undefined) deps.clock.clearTimeout(timer);
    if (interrupt) options.signal?.removeEventListener("abort", interrupt);
    child.disposeOutput();
  }
}

export function snapshotTranscriptFiles(options: SnapshotOptions): SnapshotFiles {
  return {
    ...nodeTranscriptFiles,
    async snapshot(path) {
      const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "hcn-transcript-"));
      const destination = join(directory, "snapshot");
      let file: TranscriptFile;
      try {
        await cloneSource(options, path, destination);
        file = await nodeTranscriptFiles.open(destination);
      } catch (error) {
        try {
          await rm(directory, { force: true, recursive: true });
        } catch {
          if (error instanceof TranscriptError) error.cleanupFailed = true;
        }
        throw error;
      }
      let closing: Promise<void> | undefined;
      return {
        close() {
          closing ??= file.close().finally(() => rm(directory, { force: true, recursive: true }));
          return closing;
        },
        read: (length, start) => file.read(length, start),
        version: () => file.version(),
      };
    },
  };
}
