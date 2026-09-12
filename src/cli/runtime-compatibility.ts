import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { mergeEnvironment } from "../execution/environment.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { installedVersion } from "./check.js";

function executablePath(bin: string, cwd: string, searchPath: string): string | null {
  const candidates =
    isAbsolute(bin) || bin.includes("/")
      ? [resolve(cwd, bin)]
      : searchPath.split(delimiter).map((dir) => resolve(cwd, dir, bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // PATH lookup continues when an earlier directory has no executable.
    }
  }
  return null;
}

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
  return {
    executable: { path, version },
    resume: {
      status: supported ? "supported" : "unknown",
      reason: supported ? null : "The selected executable could not be resolved.",
    },
    verifiedAgainst: harness.verifiedAgainst,
  };
}
