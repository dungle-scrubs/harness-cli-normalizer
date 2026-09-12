import { createHash } from "node:crypto";
import { closeSync, fstatSync, readSync, realpathSync, statSync } from "node:fs";
import { isNativeFolder } from "../interpretation/native-path.js";
import { parseCodexSettingsRecord } from "../interpretation/native-settings.js";
import type { HarnessName } from "../knowledge/descriptor.js";
import { UUID_SHAPE } from "../knowledge/descriptor.js";
import type { NativeSettingsReason, NativeSettingsResult } from "../knowledge/native-settings.js";
import { NATIVE_SETTINGS_SOURCES } from "../knowledge/native-settings.js";
import { codexRecordPath, codexRecordsRoot } from "./native-codex-record.js";
import { openRegularFile } from "./regular-file.js";

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
  runtime: { readonly codexHome: string | undefined; readonly home: string },
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
    const root = codexRecordsRoot({ ...runtime, cwd, sessionId: request.sessionId });
    const path = codexRecordPath(root, request.sessionId);
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
    const line = (bytes: Uint8Array): void => {
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
