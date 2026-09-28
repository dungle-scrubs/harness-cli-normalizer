import { mergeEnvironment } from "../execution/environment.js";
import { executablePath } from "../execution/executable.js";
import { probeExtensionOption } from "../execution/extension-probe.js";
import { nodeRunnerDeps } from "../execution/node-deps.js";
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
}> {
  const { cwd = process.cwd(), env: environment } = options;
  const inheritedEnvironment = process.env;
  const effectiveEnvironment = mergeEnvironment(inheritedEnvironment, environment);
  // Node's Unix lookup uses this default when PATH has been removed.
  const searchPath = effectiveEnvironment.PATH ?? "/usr/bin:/bin";
  const path = executablePath(harness.bin, cwd, searchPath);
  const version =
    path === null ? null : await installedVersion(path, { cwd, env: effectiveEnvironment });
  const supported = path !== null;
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
  };
}
