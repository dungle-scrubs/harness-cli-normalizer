import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Resolve package metadata without loading the SDK's agent stack. */
export const installedCursorSdkVersion = (): string | null => {
  try {
    const entry = createRequire(import.meta.url).resolve("@cursor/sdk");
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", pathToFileURL(entry)), "utf8"),
    ) as { name?: string; version?: string };
    return manifest.name === "@cursor/sdk" && typeof manifest.version === "string"
      ? manifest.version
      : null;
  } catch {
    return null;
  }
};
