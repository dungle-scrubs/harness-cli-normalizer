import { createHash } from "node:crypto";
import { closeSync, fstatSync, opendirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { isNativeFolder } from "../interpretation/native-path.js";
import { parseCodexSettingsRecord } from "../interpretation/native-settings.js";
import {
  type PiSettingsLine,
  parsePiSettingsLine,
  piSessionSettings,
} from "../interpretation/pi-native-settings.js";
import type { HarnessName } from "../knowledge/descriptor.js";
import { UUID_SHAPE } from "../knowledge/descriptor.js";
import type { NativeSettingsReason, NativeSettingsResult } from "../knowledge/native-settings.js";
import { NATIVE_CONTINUATION, NATIVE_SETTINGS_SOURCES } from "../knowledge/native-settings.js";
import { piCli } from "../knowledge/pi.js";
import { codexRecordPath, codexRecordsRoot } from "./native-codex-record.js";
import { openRegularFile } from "./regular-file.js";
import { resolveStoreRoot } from "./store-root.js";

export interface NativeSettingsRequest {
  readonly cwd: string;
  readonly harness: HarnessName;
  readonly sessionId: string;
}

export type NativeSettingsInspector = (
  request: NativeSettingsRequest & { readonly env?: Readonly<Record<string, string>> },
) => NativeSettingsResult;

class NativeSettingsUnavailable extends Error {
  constructor(readonly code: NativeSettingsReason) {
    super(code);
    this.name = "NativeSettingsUnavailable";
  }
}

/** Passive and bounded. The fingerprint is source evidence, never process ownership. */
export function inspectNativeSettings(
  request: NativeSettingsRequest,
  runtime: {
    readonly codexHome: string | undefined;
    readonly home: string;
    /** The environment the harness will run with; locates the Pi store. */
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): NativeSettingsResult {
  const unavailable = (reason: NativeSettingsReason): NativeSettingsResult => ({
    harness: request.harness,
    reason,
    status: "unavailable",
    v: 1,
  });
  const source = NATIVE_SETTINGS_SOURCES[request.harness];
  if (!source) return unavailable("unsupported-harness");
  if (!UUID_SHAPE.test(request.sessionId) || !isNativeFolder(request.cwd))
    return unavailable("invalid-request");
  let cwd: string;
  try {
    cwd = realpathSync(request.cwd);
    if (!statSync(cwd).isDirectory()) return unavailable("cwd-refused");
  } catch {
    return unavailable("cwd-refused");
  }
  let fd: number | undefined;
  try {
    const path =
      source === "pi-session-v1"
        ? piSessionPath(cwd, request.sessionId, runtime)
        : codexRecordPath(
            codexRecordsRoot({ ...runtime, cwd, sessionId: request.sessionId }),
            request.sessionId,
          );
    if (!path) return unavailable("session-unavailable");
    const file = openRegularFile(path);
    if (!file) return unavailable("session-unavailable");
    fd = file.fd;
    const before = file.stat;
    if (before.size > 64n * 1024n * 1024n) return unavailable("source-too-large");
    const identity = (stat: typeof before): readonly string[] =>
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    let header:
      | Extract<NonNullable<ReturnType<typeof parseCodexSettingsRecord>>, { kind: "metadata" }>
      | undefined;
    let settings:
      | Extract<NonNullable<ReturnType<typeof parseCodexSettingsRecord>>, { kind: "settings" }>
      | undefined;
    let ordinal = 0;
    let settingsOrdinal = 0;
    const decoder = new TextDecoder("utf8", { fatal: true });
    const piLines: PiSettingsLine[] = [];
    const line = (bytes: Uint8Array): void => {
      if (source === "pi-session-v1") {
        const text = decoder.decode(bytes);
        // Pi skips blank lines; a malformed line holds instead (RFC 35 step 3).
        if (text.trim() === "") return;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new NativeSettingsUnavailable("settings-unavailable");
        }
        const record = parsePiSettingsLine(value);
        if (!record) throw new NativeSettingsUnavailable("settings-unavailable");
        piLines.push(record);
        return;
      }
      const record = parseCodexSettingsRecord(JSON.parse(decoder.decode(bytes)));
      if (!record || (ordinal === 0 && record.kind !== "metadata"))
        throw new NativeSettingsUnavailable("settings-unavailable");
      if (record.kind === "metadata") {
        if (header || record.sessionId !== request.sessionId)
          throw new NativeSettingsUnavailable("session-unavailable");
        if (realpathSync(record.cwd) !== cwd) throw new NativeSettingsUnavailable("cwd-refused");
        header = record;
      } else if (record.kind === "settings") {
        if (realpathSync(record.cwd) !== cwd) throw new NativeSettingsUnavailable("cwd-refused");
        if (record.sessionId !== undefined && record.sessionId !== request.sessionId)
          throw new NativeSettingsUnavailable("session-unavailable");
        settings = {
          ...record,
          approvalsReviewer: record.approvalsReviewer ?? settings?.approvalsReviewer,
          provider: record.provider ?? settings?.provider,
        };
        settingsOrdinal = ordinal;
      }
      ordinal++;
    };
    // Pi rewrites a session file in place, so a stat identity alone can miss
    // an edit inside one timestamp tick; the bytes read go into the digest.
    const content = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let offset = 0;
    while (offset < Number(before.size)) {
      const count = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      if (!count) throw new NativeSettingsUnavailable("source-changed");
      offset += count;
      const bytes = buffer.subarray(0, count);
      content.update(bytes);
      let start = 0;
      while (start < count) {
        const end = bytes.indexOf(10, start);
        const part = bytes.subarray(start, end === -1 ? count : end);
        const length = pendingBytes + part.length;
        if (length > 1024 * 1024) throw new NativeSettingsUnavailable("source-too-large");
        if (end === -1) {
          pending.push(Buffer.from(part));
          pendingBytes = length;
          break;
        }
        line(pendingBytes ? Buffer.concat([...pending, part], length) : part);
        pending = [];
        pendingBytes = 0;
        start = end + 1;
      }
    }
    const after = fstatSync(fd, { bigint: true });
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after)))
      return unavailable("source-changed");
    if (pendingBytes) return unavailable("source-incomplete");
    if (source === "pi-session-v1") {
      const pi = piSessionSettings(piLines);
      if (typeof pi === "string") return unavailable(pi);
      if (pi.sessionId !== request.sessionId) return unavailable("session-unavailable");
      let recorded: string | undefined;
      try {
        recorded = realpathSync(pi.cwd);
      } catch {
        recorded = undefined;
      }
      if (recorded !== cwd) return unavailable("cwd-refused");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            source,
            request.harness,
            request.sessionId,
            request.cwd,
            ...identity(before),
            content.digest("hex"),
            pi.modelEntry,
            pi.effortEntry,
            pi.model,
            pi.effort,
            pi.provider,
          ]),
        )
        .digest("hex");
      return {
        continuation: NATIVE_CONTINUATION[source],
        cwd: request.cwd,
        harness: request.harness,
        sessionId: request.sessionId,
        effort: pi.effort,
        fingerprint,
        model: pi.model,
        provider: pi.provider,
        source,
        status: "available",
        v: 1,
      };
    }
    if (!header || !settings) return unavailable("settings-unavailable");
    const { model, effort } = settings;
    const permissions =
      settings.permissions.status === "recorded" && settings.approvalsReviewer !== undefined
        ? { ...settings.permissions, approvalsReviewer: settings.approvalsReviewer }
        : settings.permissions;
    const provider = settings.provider ?? header.provider;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          source,
          request.harness,
          request.sessionId,
          request.cwd,
          ...identity(before),
          settingsOrdinal,
          model,
          effort,
          provider,
          permissions,
        ]),
      )
      .digest("hex");
    return {
      continuation: NATIVE_CONTINUATION[source],
      cwd: request.cwd,
      harness: request.harness,
      sessionId: request.sessionId,
      effort,
      fingerprint,
      model,
      permissions,
      provider,
      source,
      status: "available",
      v: 1,
    };
  } catch (cause) {
    return unavailable(
      cause instanceof NativeSettingsUnavailable ? cause.code : "session-unavailable",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The Pi session file for one id: `<ISO-stamp>_<id>.jsonl` directly in the
 * store root the harness resolves for this folder (hcn 0.7.4 store table).
 * Bounded; more than one match is ambiguous and refuses. */
function piSessionPath(
  cwd: string,
  sessionId: string,
  runtime: {
    readonly home: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): string | undefined {
  const root = resolveStoreRoot(piCli, { env: runtime.env ?? {}, cwd, home: runtime.home });
  if (root === undefined) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  const matches: string[] = [];
  let remaining = 16_384;
  const entries = opendirSync(root);
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      if (--remaining < 0) return undefined;
      if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(join(root, entry.name));
    }
  } finally {
    entries.closeSync();
  }
  return matches.length === 1 ? matches[0] : undefined;
}
