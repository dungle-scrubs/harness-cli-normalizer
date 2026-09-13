import { isValidEnvEntry } from "../interpretation/environment.js";
import {
  hasUserApprovalAuthority,
  validNativeApprovalOptions,
} from "../interpretation/native-approvals.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { NATIVE_APPROVAL_PROTOCOLS } from "../knowledge/native-approvals.js";
import type { NativeSettingsSnapshot } from "../knowledge/native-settings.js";
import type { NativeSettingsInspector } from "./native-settings.js";
import type { TurnRunOptions } from "./stream-turn.js";
import { verifyNativeSettings } from "./verified-native-settings.js";

export function nativeApprovalPlan(
  h: HarnessDescriptor,
  opts: TurnRunOptions,
  inspect: NativeSettingsInspector | undefined,
): { readonly argv: string[]; readonly saved: NativeSettingsSnapshot } {
  const protocol = NATIVE_APPROVAL_PROTOCOLS[h.name];
  const invalidEnv = Object.entries(opts.env ?? {}).find(
    ([key, value]) => !isValidEnvEntry(key, value),
  );
  if (invalidEnv)
    throw new ArgvRefusalError({
      issue: "invalid-env",
      harness: h.name,
      detail: invalidEnv[0],
      supported: ["env keys must match /^[A-Za-z_][A-Za-z0-9_]*$/ and no NUL"],
    });

  if (!protocol || !opts.nativeSettingsFingerprint || !validNativeApprovalOptions(opts))
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      detail:
        "native approvals require exact Codex resume, saved settings and no competing options",
    });
  const saved = verifyNativeSettings(h, opts, inspect);
  if (!hasUserApprovalAuthority(saved))
    throw new ArgvRefusalError({
      issue: "native-settings-unavailable",
      harness: h.name,
      detail: "recorded user reviewer and supported permissions required",
    });
  return { argv: [h.bin, ...protocol.argv], saved };
}
