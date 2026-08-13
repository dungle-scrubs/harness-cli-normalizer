import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(repositoryRoot, "dist");

assert.equal(dirname(outputDirectory), repositoryRoot);
rmSync(outputDirectory, { force: true, recursive: true });

const result = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

assert.equal(result.status, 0, "package build failed");
