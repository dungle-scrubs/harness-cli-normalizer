/**
 * Shared setup for CLI stub-binary tests (M3): dist/ is git-ignored, so a
 * fresh checkout has none and a working tree may have a stale one. Both
 * cases fail here with an actionable message instead of passing
 * vacuously - the suite builds dist/ before tests run (vitest and both CI
 * lanes), never during a run, so parallel workers cannot rm -rf a dist/
 * another test is executing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const ensureDist = (): string => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

/** Both stub processes must be reaped when the run ends - kill(pid, 0)
 * throws once no process holds the pid. */
export const expectStubsReaped = (outDir: string): void => {
  for (const name of ["exec.pid", "serve.pid"]) {
    const pid = Number(readFileSync(join(outDir, name), "utf8").trim());
    expect(Number.isInteger(pid) && pid > 0, `${name} holds a pid`).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }
};
