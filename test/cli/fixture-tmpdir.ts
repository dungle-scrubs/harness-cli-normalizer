import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const parent = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".scratch",
  "cli-fixtures",
);

// Preserve the CommonJS default of system temp fixtures without inheriting the
// repository's module scope. Publish atomically so parallel workers see valid JSON.
mkdirSync(parent, { recursive: true });
// Stop hcn's project-config discovery before it reaches the checkout.
// These synthetic native peers have their own configuration and no git history.
mkdirSync(join(parent, ".git"), { recursive: true });
const staging = mkdtempSync(join(parent, ".scope-"));
try {
  writeFileSync(join(staging, "package.json"), '{"type":"commonjs"}\n');
  renameSync(join(staging, "package.json"), join(parent, "package.json"));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

export function cliFixtureTmpdir(): string {
  // Bun 1.3.14 script startup slows with the working directory's parent size.
  // These fixtures change child cwd; the shared system temp parent exceeded
  // 1.5 million entries during validation. Each test still uses its own directory.
  return parent;
}
