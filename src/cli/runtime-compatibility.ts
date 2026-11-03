import { installedCursorSdkVersion } from "../execution/cursor-sdk-runtime.js";
import { mergeEnvironment } from "../execution/environment.js";
import { executablePath } from "../execution/executable.js";
import { probeExtensionOption } from "../execution/extension-probe.js";
import { nodeRunnerDeps, sdkWorkerArgvFor } from "../execution/node-deps.js";
import { cursorSdkAccessRestriction } from "../interpretation/cursor-sdk.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { TURN_OPTION_KEYS } from "../knowledge/descriptor.js";
import { installedVersion } from "./check.js";

/** Call after validating the invocation. Version is evidence metadata, never
 * admission. The native operation still owns session existence and success. */
export async function runtimeCompatibility(
  harness: HarnessDescriptor,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<{
  readonly executable: { readonly path: string | null; readonly version: string | null };
  readonly resume: { readonly status: "supported" | "unknown"; readonly reason: string | null };
  readonly verifiedAgainst: string;
  /** Map #300 (#303 decision 3): per-machine truth for every declared
   * extension-registered option - the probe ran against this binary under
   * this environment. Null when the descriptor declares none. */
  readonly extensionOptions: Record<
    string,
    { readonly expressible: boolean; readonly providedBy: string; readonly detail: string }
  > | null;
  /** Issue #440: present when the harness's headless surface is an SDK
   * worker. The worker argv is the spawn adapter's rewrite of the
   * descriptor's private marker, and `access` is the exact restriction
   * mapping the worker's open line carries for each preset - inspect
   * describes it instead of leaving the preset's CLI spelling (which no
   * longer runs) as the only documented behavior. */
  readonly sdk?: {
    readonly kind: string;
    readonly version: string | null;
    readonly workerArgv: readonly string[];
    readonly resumeIdShape: string;
    readonly access: Readonly<
      Record<"bare" | "read" | "write" | "autonomy", ReturnType<typeof cursorSdkAccessRestriction>>
    >;
  };
}> {
  const { cwd = process.cwd(), env: environment } = options;
  const inheritedEnvironment = process.env;
  const effectiveEnvironment = mergeEnvironment(inheritedEnvironment, environment);
  // Node's Unix lookup uses this default when PATH has been removed.
  const searchPath = effectiveEnvironment.PATH ?? "/usr/bin:/bin";
  const path = executablePath(harness.bin, cwd, searchPath);
  const version =
    path === null ? null : await installedVersion(path, { cwd, env: effectiveEnvironment });
  const sdkVersion = harness.sdk == null ? null : installedCursorSdkVersion();
  const workerArgv = harness.sdk == null ? null : sdkWorkerArgvFor(harness.sdk.workerMarker);
  const supported =
    harness.sdk == null
      ? path !== null
      : sdkVersion !== null &&
        workerArgv !== null &&
        executablePath(workerArgv[0] ?? "", cwd, searchPath) !== null;
  // Map #300: run every declared probe under the SAME effective
  // environment the spawn would use (#301: extensions follow the config
  // dir env), answering the planning question for THIS machine. A missing
  // binary answers nothing - every declared option reports not
  // expressible with the executable as the reason.
  const extensionOptions: Record<
    string,
    { readonly expressible: boolean; readonly providedBy: string; readonly detail: string }
  > = {};
  for (const key of TURN_OPTION_KEYS) {
    const spec = harness.turnOptions[key];
    if (spec?.probe === undefined) continue;
    if (path === null) {
      extensionOptions[key] = {
        expressible: false,
        providedBy: spec.probe.providedBy,
        detail: "the executable could not be resolved",
      };
      continue;
    }
    const outcome = await probeExtensionOption(
      harness,
      spec.probe,
      { cwd, env: environment },
      nodeRunnerDeps(),
    );
    extensionOptions[key] = {
      expressible: outcome.ok,
      providedBy: outcome.providedBy,
      detail:
        outcome.reason === "flag-present"
          ? `${outcome.probeShape} carries ${spec.probe.contains}`
          : outcome.reason === "flag-absent"
            ? `${outcome.providedBy} not installed here`
            : `probe could not run (${outcome.probeShape}): ${outcome.reason}`,
    };
  }
  return {
    executable: { path, version },
    resume: {
      status: supported ? "supported" : "unknown",
      reason: supported ? null : "The selected executable could not be resolved.",
    },
    verifiedAgainst: harness.verifiedAgainst,
    extensionOptions: Object.keys(extensionOptions).length > 0 ? extensionOptions : null,
    ...(harness.sdk != null
      ? {
          sdk: {
            kind: harness.sdk.kind,
            version: sdkVersion,
            workerArgv: workerArgv ?? [harness.sdk.workerMarker],
            resumeIdShape: String(harness.sdk.resumeIdShape),
            access: {
              bare: cursorSdkAccessRestriction({}),
              read: cursorSdkAccessRestriction({ access: "read" }),
              write: cursorSdkAccessRestriction({ access: "write" }),
              autonomy: cursorSdkAccessRestriction({ autonomy: true }),
            },
          },
        }
      : {}),
  };
}
