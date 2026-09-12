import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { installedVersion } from "../../src/cli/check.js";

test("a version probe times out even when the executable leaves stdout open", async () => {
  const root = mkdtempSync(join(tmpdir(), "hcn-version-timeout-"));
  const binary = join(root, "version");
  writeFileSync(binary, "#!/bin/sh\necho 1.2.3\nsleep 0.3\n", { mode: 0o700 });
  try {
    expect(await installedVersion(binary, { timeoutMs: 50 })).toBeNull();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
