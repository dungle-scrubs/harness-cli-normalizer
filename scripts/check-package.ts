import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackedFile[];
}

interface PackageManifest {
  readonly private?: boolean;
  readonly publishConfig?: {
    readonly access?: string;
  };
  readonly bin?: Record<string, string>;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

assert.notEqual(manifest.private, true, "package is still private");
assert.equal(manifest.publishConfig?.access, "public");

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});

assert.equal(result.status, 0, result.stderr);

const [pack] = JSON.parse(result.stdout) as readonly PackResult[];
assert.ok(pack, "npm pack returned no package result");

const files = new Set(pack.files.map(({ path }) => path));
for (const required of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/knowledge/index.js",
  "dist/interpretation/index.js",
  "dist/execution/index.js",
  "dist/cli.js",
  "dist/cli/index.js",
  "LICENSE",
  "README.md",
  "package.json",
]) {
  assert.ok(files.has(required), `packed package is missing ${required}`);
}

assert.ok(
  manifest.bin?.hcn === "./dist/cli.js",
  `package.json bin.hcn must be "./dist/cli.js", got ${JSON.stringify(manifest.bin?.hcn)}`,
);
assert.ok(files.has("dist/cli.js"), "dist/cli.js must be packed");
assert.ok(files.has("dist/cli/index.js"), "dist/cli/index.js must be packed");

for (const forbiddenPrefix of [".plans/", "scripts/", "test/"]) {
  assert.equal(
    [...files].some((path) => path.startsWith(forbiddenPrefix)),
    false,
    `packed package contains ${forbiddenPrefix}`,
  );
}

const importBuilt = async (relativePath: string): Promise<Record<string, unknown>> =>
  import(new URL(relativePath, import.meta.url).href) as Promise<Record<string, unknown>>;

const root = await importBuilt("../dist/index.js");
const knowledge = await importBuilt("../dist/knowledge/index.js");
const interpretation = await importBuilt("../dist/interpretation/index.js");
const execution = await importBuilt("../dist/execution/index.js");

assert.equal(root.claudeCode, knowledge.claudeCode);
assert.equal(root.buildLaunchArgv, interpretation.buildLaunchArgv);
assert.equal(root.streamTurn, execution.streamTurn);
