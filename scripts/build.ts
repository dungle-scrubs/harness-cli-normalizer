import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const cliIndexJs = resolve(outputDirectory, "cli", "index.js");
if (existsSync(cliIndexJs)) {
  const content = readFileSync(cliIndexJs, "utf8");
  if (!content.startsWith("#!/usr/bin/env node")) {
    writeFileSync(cliIndexJs, `#!/usr/bin/env node\n${content}`);
  }
  chmodSync(cliIndexJs, 0o755);
}
const cliWrapperPath = resolve(outputDirectory, "cli.js");
// Dedicated bin entry (package.json bin.hcn). npm installs it as a symlink
// named `hcn`, so it must invoke the entrypoint directly rather than rely on
// argv filename sniffing inside cli/index.js - the link name defeats that
// (issue #33: every `hcn` invocation exited 0 with no output).
writeFileSync(
  cliWrapperPath,
  '#!/usr/bin/env node\nimport { run } from "./cli/index.js";\nrun();\n',
);
chmodSync(cliWrapperPath, 0o755);
