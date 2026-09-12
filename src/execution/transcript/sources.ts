import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { ReadTranscriptRequest } from "../../interpretation/transcript/envelopes.js";
import { TranscriptError } from "../../interpretation/transcript/json.js";
import type { NativeHistory } from "../../interpretation/transcript/native.js";
import type { TranscriptReader } from "../../interpretation/transcript/readers.js";
import type { FileVersion, TranscriptFile, TranscriptFiles } from "./files.js";

export interface CapturedSource {
  readonly before: FileVersion;
  readonly bytes: Uint8Array;
  readonly completeBytes: number;
  readonly file: TranscriptFile;
  readonly history: NativeHistory;
  readonly nativeId: string;
  readonly path: string;
}
function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function nativeResolver(
  root: string,
  reader: TranscriptReader,
  files: TranscriptFiles,
  checkAbort: () => void,
): (id: string) => Promise<string> {
  async function* scan(): AsyncGenerator<{ name: string; path: string }> {
    if (!root || !files.list)
      throw new TranscriptError("source-not-found", "Native lookup root is unavailable.");
    for (const directory of reader.lookup.directories) {
      const path = join(root, directory);
      for await (const name of files.list(path, reader.lookup.recursive)) {
        checkAbort();
        yield { name, path: join(path, name) };
      }
    }
  }
  let inventory: Promise<readonly { name: string; path: string }[]> | undefined;
  const collect = async (): Promise<readonly { name: string; path: string }[]> => {
    const paths: { name: string; path: string }[] = [];
    for await (const item of scan()) paths.push(item);
    return paths;
  };
  return async (id) => {
    // A lineage shares one namespace observation; Pi's one-source lookup stays streaming.
    if (reader.ancestry && !inventory) inventory = collect();
    const candidates = inventory ? await inventory : scan();
    let match: string | null = null;
    for await (const candidate of candidates) {
      checkAbort();
      if (!reader.lookup.matches(candidate.name, id)) continue;
      if (match !== null)
        throw new TranscriptError(
          "source-ambiguous",
          "Multiple native sources match the requested ID.",
        );
      match = candidate.path;
    }
    if (!match)
      throw new TranscriptError(
        "source-not-found",
        "The requested native conversation does not exist.",
      );
    return match;
  };
}
export async function verifySource(
  source: Pick<CapturedSource, "before" | "bytes" | "file" | "path">,
  files: TranscriptFiles,
  checkAbort: () => void,
): Promise<void> {
  const { before, bytes, file, path } = source;
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    const length = Math.min(1024 * 1024, bytes.length - offset);
    const chunk = await file.read(length, offset);
    if (
      chunk.length !== length ||
      !Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).equals(
        Buffer.from(bytes.buffer, bytes.byteOffset + offset, length),
      )
    )
      throw new TranscriptError(
        "source-changed",
        "The native source prefix changed during the read.",
      );
    checkAbort();
  }
  let named: FileVersion;
  try {
    named = await files.version(path);
  } catch (error) {
    if (missing(error))
      throw new TranscriptError("source-changed", "The selected native source disappeared.");
    throw error;
  }
  const after = await file.version();
  if (
    after.size < before.size ||
    named.size < bytes.length ||
    named.identity !== before.identity ||
    after.identity !== before.identity
  )
    throw new TranscriptError(
      "source-changed",
      "The selected native source was replaced or truncated.",
    );
  checkAbort();
}
export async function captureSource(
  path: string,
  cutoff: number | null,
  reader: TranscriptReader,
  files: TranscriptFiles,
  opened: TranscriptFile[],
  checkAbort: () => void,
): Promise<CapturedSource> {
  if (path.endsWith(".zst"))
    throw new TranscriptError(
      "guarantee-unmet",
      "Compressed native sources are not established by this reader.",
    );
  const file = await files.open(path);
  opened.push(file);
  checkAbort();
  const before = await file.version();
  if (cutoff !== null && cutoff > before.size)
    throw new TranscriptError("guarantee-unmet", "Native base cutoff is beyond the source.");
  const size = cutoff ?? before.size;
  const bytes = await file.read(size);
  if (bytes.length !== size)
    throw new TranscriptError("source-changed", "Native source shrank during the read.");
  await verifySource({ before, bytes, file, path }, files, checkAbort);
  const completeBytes = bytes.lastIndexOf(10) + 1;
  if (cutoff !== null && cutoff !== completeBytes)
    throw new TranscriptError("guarantee-unmet", "Native base cutoff splits a framing unit.");
  const history = reader.parse(bytes.subarray(0, completeBytes));
  return { before, bytes, completeBytes, file, history, nativeId: reader.nativeId(history), path };
}

interface CaptureDeps {
  readonly reader: TranscriptReader;
  readonly files: TranscriptFiles;
  readonly opened: TranscriptFile[];
  readonly checkAbort: () => void;
}
export async function captureSources(
  request: ReadTranscriptRequest,
  deps: CaptureDeps,
): Promise<{
  requested: CapturedSource;
  sources: readonly CapturedSource[];
}> {
  const { reader, files, opened, checkAbort } = deps;
  const selection = request.selection;
  const resolveId = nativeResolver(request.nativeStoreRoot ?? "", reader, files, checkAbort);
  const selectedFile =
    selection.kind === "file" ? selection.path : await resolveId(selection.nativeId);
  const requested = await captureSource(selectedFile, null, reader, files, opened, checkAbort);
  const id = requested.nativeId;
  if (selection.kind === "id" && id !== selection.nativeId)
    throw new TranscriptError(
      "source-identity-mismatch",
      "Native header identity differs from the requested ID.",
    );
  const sources: CapturedSource[] = [requested];
  const seen = new Set([id]);
  let current = requested;
  for (;;) {
    const base = reader.ancestry?.base(current.history);
    if (!base) break;
    if (seen.has(base.nativeId))
      throw new TranscriptError("guarantee-unmet", "Native history base contains a cycle.");
    seen.add(base.nativeId);
    const path = await resolveId(base.nativeId);
    current = await captureSource(path, base.offset, reader, files, opened, checkAbort);
    if (current.nativeId !== base.nativeId)
      throw new TranscriptError(
        "source-identity-mismatch",
        "Native base source belongs to another conversation.",
      );
    reader.ancestry?.validate(current.history, base);
    sources.push(current);
  }
  sources.reverse();
  if (sources.length > 1) for (const item of sources) await verifySource(item, files, checkAbort);
  return { requested, sources };
}
