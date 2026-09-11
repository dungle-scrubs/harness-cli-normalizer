import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { InteractiveRequest } from "../interpretation/interactive.js";
import { interactiveArgv } from "../interpretation/interactive.js";
import { asRecord } from "../interpretation/shape.js";
import { storePath } from "../interpretation/store.js";
import { codexCli } from "../knowledge/codex.js";
import { UUID_SHAPE } from "../knowledge/descriptor.js";
import type { InteractiveRefusal } from "../knowledge/interactive.js";
import { executablePath } from "./executable.js";
import { readNativeProcessOwner } from "./process-identity.js";

export type InteractivePreflight =
  | { readonly kind: "ready"; readonly argv: readonly string[] }
  | { readonly kind: "refused"; readonly reason: InteractiveRefusal };

function withRegularFile<TValue>(path: string, read: (fd: number) => TValue): TValue | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(fd).isFile() ? read(fd) : undefined;
  } finally {
    closeSync(fd);
  }
}

function nativeExecutable(bin: string, cwd: string, searchPath: string): string | undefined {
  const candidate = executablePath(bin, cwd, searchPath);
  if (candidate === null) return undefined;
  try {
    const path = realpathSync(candidate);
    return withRegularFile(path, (fd) => {
      const magic = Buffer.alloc(4);
      if (readSync(fd, magic, 0, 4, 0) !== 4) return undefined;
      // A wrapper can fork or exec another executable. Until normalized, it
      // cannot supply the native process identity promised by this operation.
      if (
        [0x7f454c46, 0xcffaedfe, 0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(magic.readUInt32BE())
      )
        return path;
      return undefined;
    });
  } catch {
    // Failed executable inspection cannot authorize another PATH candidate.
  }
  return undefined;
}

function codexSavedFolder(root: string, sessionId: string): string | undefined {
  const matches: string[] = [];
  let remaining = 16_384;
  const visit = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (--remaining < 0) throw new Error("Session scan bound exceeded");
      const path = join(directory, entry.name);
      if (depth < 3 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) visit(path, depth + 1);
      if (
        depth === 3 &&
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(`-${sessionId}.jsonl`)
      )
        matches.push(path);
    }
  };
  visit(root, 0);
  if (matches.length !== 1 || !matches[0]) return undefined;
  return withRegularFile(matches[0], (fd) => {
    const bytes = Buffer.alloc(1024 * 1024);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, count).indexOf(10);
    if (end < 0) return undefined;
    const record = asRecord(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, end))),
    );
    const meta = asRecord(record?.payload);
    return record?.type === "session_meta" && meta?.id === sessionId && typeof meta.cwd === "string"
      ? meta.cwd
      : undefined;
  });
}

/** Checks exact identity and folder before any process creation; does not load model history. */
export function preflightInteractive(
  request: InteractiveRequest,
  runtime: {
    readonly codexHome: string | undefined;
    readonly home: string;
    readonly searchPath: string;
  },
): InteractivePreflight {
  const args = interactiveArgv(request);
  if (!args) return { kind: "refused", reason: "unsupported-interface" };
  if (!UUID_SHAPE.test(request.sessionId)) return { kind: "refused", reason: "resume-unavailable" };
  let cwd: string;
  try {
    cwd = realpathSync(request.cwd);
    if (!statSync(cwd).isDirectory()) return { kind: "refused", reason: "cwd-refused" };
  } catch {
    return { kind: "refused", reason: "cwd-refused" };
  }
  try {
    const root = runtime.codexHome
      ? join(runtime.codexHome, "sessions")
      : storePath(codexCli, { cwd, home: runtime.home, sessionId: request.sessionId });
    const folder = codexSavedFolder(root, request.sessionId);
    if (!folder) return { kind: "refused", reason: "resume-unavailable" };
    if (realpathSync(folder) !== cwd) return { kind: "refused", reason: "cwd-refused" };
  } catch {
    return { kind: "refused", reason: "resume-unavailable" };
  }
  const executable = nativeExecutable(codexCli.bin, cwd, runtime.searchPath);
  if (!executable || !readNativeProcessOwner(process.pid))
    return { kind: "refused", reason: "executable-unavailable" };
  return { argv: [executable, ...args], kind: "ready" };
}
