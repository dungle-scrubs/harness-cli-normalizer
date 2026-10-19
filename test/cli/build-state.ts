import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Validate the explicit build without rebuilding under active test workers. */
export const ensureCurrentBuild = (
  root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): string => {
  const cli = join(root, "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("test setup: dist/cli.js is missing - run `pnpm build` first");
  }
  const newestSource = (dir: string): number => {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, newestSource(at));
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        newest = Math.max(newest, statSync(at).mtimeMs);
    }
    return newest;
  };
  if (statSync(cli).mtimeMs < newestSource(join(root, "src"))) {
    throw new Error("test setup: dist/cli.js is older than src/ - run `pnpm build` first");
  }
  return cli;
};
