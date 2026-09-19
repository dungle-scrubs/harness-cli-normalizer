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
// CLI-only surface (Phase 7): the bin is the product. No root export, no
// library subpaths, no d.ts entry points - src/ ships for reading, dist/
// for running.
for (const required of [
  "dist/cli.js",
  "dist/cli/index.js",
  "LICENSE",
  "README.md",
  "package.json",
]) {
  assert.ok(files.has(required), `packed package is missing ${required}`);
}
for (const forbidden of ["dist/index.js", "dist/index.d.ts"]) {
  assert.equal(files.has(forbidden), false, `packed package must not carry ${forbidden}`);
}

// Issue #193: npm publish rewrites a "./"-prefixed bin path and reports the
// entry as "invalid and removed". The form `npm pkg fix` writes is the only
// one npm publishes untouched.
assert.ok(
  manifest.bin?.hcn === "dist/cli.js",
  `package.json bin.hcn must be "dist/cli.js", got ${JSON.stringify(manifest.bin?.hcn)}`,
);
// The guard that matters: npm must publish the manifest as written. A
// dry-run publish runs the same normalization as a real one, and any
// auto-correction means the published manifest differs from package.json -
// a dropped bin would ship a package with no `hcn` command. The exit status
// is not asserted: between releases the version is already published, and
// npm exits 1 for that after it has normalized and packed.
const publish = spawnSync("npm", ["publish", "--dry-run", "--ignore-scripts"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
assert.match(
  publish.stderr,
  /npm notice name:/,
  `npm publish --dry-run never reached packing:\n${publish.stderr}`,
);
assert.doesNotMatch(
  publish.stderr,
  /auto-corrected|was invalid and removed/,
  "npm publish would rewrite package.json - run `npm pkg fix`",
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

// The packed CLI must actually run: --version exercises the built entry
// end to end.
const cli = spawnSync("node", [new URL("../dist/cli.js", import.meta.url).pathname, "--version"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, `built cli.js --version failed: ${cli.stderr}`);
assert.match(cli.stdout, /\d+\.\d+\.\d+/, "cli --version must print a version");
