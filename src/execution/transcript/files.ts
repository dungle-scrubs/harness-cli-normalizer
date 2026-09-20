import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FileVersion {
  readonly identity: string;
  readonly size: number;
}
/** What one stat of a listed source tells the listing. Both facts come from
 * the same call: taking the mtime and discarding the size would cost a second
 * stat to get it back. */
export interface SourceStat {
  /** The last native write, as an ISO 8601 UTC time. */
  readonly lastWriteAt: string;
  readonly size: number;
}
export interface TranscriptFile {
  close(): Promise<void>;
  read(length: number, start?: number): Promise<Uint8Array>;
  version(): Promise<FileVersion>;
}
export interface TranscriptFiles {
  snapshot?(path: string): Promise<TranscriptFile>;
  /** Regular files under `path`. `prune` drops a directory before it is
   * opened, so a store's child conversations cost no walk. */
  list?(
    path: string,
    recursive?: boolean,
    prune?: (name: string) => boolean,
  ): AsyncIterable<string>;
  open(path: string): Promise<TranscriptFile>;
  realpath?(path: string): Promise<string>;
  version(path: string): Promise<FileVersion>;
  /** The write time and size of one listed regular file. */
  sourceStat?(path: string): Promise<SourceStat>;
}
async function version(handle: FileHandle): Promise<FileVersion> {
  const result = await handle.stat({ bigint: true });
  if (!result.isFile() || result.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Not a supported regular file");
  return { identity: `${result.dev}:${result.ino}`, size: Number(result.size) };
}
async function* listDirectory(
  path: string,
  recursive: boolean,
  missingRoot: boolean,
  prune: (name: string) => boolean = () => false,
): AsyncGenerator<string> {
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(path);
  } catch (error) {
    if (
      missingRoot &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
  let started = false;
  try {
    for await (const entry of directory) {
      started = true;
      if (recursive && entry.isDirectory()) {
        if (prune(entry.name)) continue;
        for await (const child of listDirectory(join(path, entry.name), true, false, prune))
          yield join(entry.name, child);
      } else if (!entry.isDirectory()) yield entry.name;
    }
  } catch (error) {
    // Bun can defer opendir's missing-root error until the first iterator step.
    if (
      missingRoot &&
      !started &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
}
export const nodeTranscriptFiles: TranscriptFiles = {
  async *list(path, recursive = false, prune) {
    yield* listDirectory(path, recursive, true, prune);
  },
  async open(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    return {
      close: () => handle.close(),
      async read(length, start = 0) {
        const buffer = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
          const result = await handle.read(
            buffer,
            offset,
            Math.min(length - offset, 1024 * 1024),
            start + offset,
          );
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        return buffer.subarray(0, offset);
      },
      version: () => version(handle),
    };
  },
  realpath: (path) => realpath(path),
  async sourceStat(path) {
    const result = await stat(path, { bigint: true });
    return {
      lastWriteAt: result.mtime.toISOString(),
      size: result.size > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(result.size),
    };
  },
  async version(path) {
    const result = await stat(path, { bigint: true });
    return { identity: `${result.dev}:${result.ino}`, size: Number(result.size) };
  },
};
