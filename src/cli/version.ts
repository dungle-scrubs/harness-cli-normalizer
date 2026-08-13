import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export const getVersion = (): string => {
  if (cached !== null) return cached;
  // dist/cli.js is at dist/cli.js -> repo root is one level up from dist, or two from src/cli per build.
  // Try to locate package.json via fileURLToPath.
  try {
    const current = fileURLToPath(import.meta.url);
    // src/cli/version.ts -> ../../package.json ; dist/cli.js -> ../package.json
    const candidates = [
      resolve(dirname(current), "../../package.json"),
      resolve(dirname(current), "../package.json"),
      resolve(dirname(current), "../../../package.json"),
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (typeof parsed.version === "string") {
          cached = parsed.version;
          return cached;
        }
      } catch {}
    }
  } catch {}
  cached = "0.0.0";
  return cached;
};
