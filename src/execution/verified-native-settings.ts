import { isNativeFolder } from "../interpretation/native-path.js";
import { hasCompetingNativeSettingsOptions } from "../interpretation/native-settings-argv.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { type HarnessDescriptor, UUID_SHAPE } from "../knowledge/descriptor.js";
import type { NativeSettingsSnapshot } from "../knowledge/native-settings.js";
import { NATIVE_SETTINGS_FINGERPRINT_SHAPE } from "../knowledge/native-settings.js";
import type { NativeSettingsInspector } from "./native-settings.js";
import type { TurnRunOptions } from "./stream-turn.js";

/** Re-read caller-identified evidence. No cached snapshot authorizes execution. */
export function verifyNativeSettings(
  h: HarnessDescriptor,
  opts: TurnRunOptions,
  inspect: NativeSettingsInspector | undefined,
): NativeSettingsSnapshot | undefined {
  const fingerprint = opts.nativeSettingsFingerprint;
  if (fingerprint === undefined) return undefined;
  if (
    !NATIVE_SETTINGS_FINGERPRINT_SHAPE.test(fingerprint) ||
    h.name !== "codex" ||
    !opts.resume ||
    !UUID_SHAPE.test(opts.resume) ||
    !isNativeFolder(opts.cwd) ||
    hasCompetingNativeSettingsOptions(opts)
  )
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      option: "nativeSettingsFingerprint",
      supported: [
        "a native settings fingerprint with exact Codex resume and cwd, without competing settings or passthrough",
      ],
    });
  const unavailable = (reason: string): ArgvRefusalError =>
    new ArgvRefusalError({
      issue: "native-settings-unavailable",
      harness: h.name,
      detail: reason,
    });
  if (!inspect) throw unavailable("inspector unavailable");
  let saved: ReturnType<NativeSettingsInspector>;
  try {
    saved = inspect({ cwd: opts.cwd, harness: h.name, sessionId: opts.resume, env: opts.env });
  } catch {
    throw unavailable("source read failed");
  }
  if (saved.status === "unavailable") throw unavailable(saved.reason);
  if (saved.harness !== h.name || saved.sessionId !== opts.resume || saved.cwd !== opts.cwd)
    throw unavailable("source target mismatch");
  if (saved.fingerprint !== fingerprint)
    throw new ArgvRefusalError({ issue: "native-settings-changed", harness: h.name });
  return saved;
}
