import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export function executablePath(bin: string, cwd: string, searchPath: string): string | null {
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
