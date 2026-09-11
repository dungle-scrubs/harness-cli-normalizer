import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, opendir, stat } from "node:fs/promises";

export interface FileVersion {
  readonly identity: string;
  readonly size: number;
}
export interface TranscriptFile {
  close(): Promise<void>;
  read(length: number, start?: number): Promise<Uint8Array>;
  version(): Promise<FileVersion>;
}
export interface TranscriptFiles {
  list?(path: string): AsyncIterable<string>;
  open(path: string): Promise<TranscriptFile>;
  version(path: string): Promise<FileVersion>;
}
async function version(handle: FileHandle): Promise<FileVersion> {
  const result = await handle.stat({ bigint: true });
  if (!result.isFile() || result.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Not a supported regular file");
  return { identity: `${result.dev}:${result.ino}`, size: Number(result.size) };
}
export const nodeTranscriptFiles: TranscriptFiles = {
  async *list(path) {
    const directory = await opendir(path);
    for await (const entry of directory) yield entry.name;
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
  async version(path) {
    const result = await stat(path, { bigint: true });
    return { identity: `${result.dev}:${result.ino}`, size: Number(result.size) };
  },
};
