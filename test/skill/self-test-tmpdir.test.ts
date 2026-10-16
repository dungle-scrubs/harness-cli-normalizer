import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const selfTest = resolve(import.meta.dirname, "check-claims.test.sh");

// Use Node even in the Bun lane because the shell checker verifies Node's floor.
const node = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
  timeout: 5_000,
}).trim();

describe("skill self-test fixture isolation", () => {
  test.each(["", "/"])("honors TMPDIR containing spaces with suffix %j", (suffix) => {
    const root = mkdtempSync(join(tmpdir(), "hcn-skill-self-test-"));
    try {
      const bin = join(root, "bin");
      const home = join(root, "home");
      const temp = join(root, "temp with spaces");
      for (const path of [bin, home, temp]) mkdirSync(path);
      symlinkSync(node, join(bin, "node"));
      writeFileSync(
        join(bin, "mktemp"),
        `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != "-d" ]; then
  echo "implicit temp selection does not honor caller TMPDIR" >&2
  exit 97
fi
case "$2" in
  "$TMPDIR"/*) ;;
  *) echo "template escapes caller TMPDIR" >&2; exit 98 ;;
esac
exec /usr/bin/mktemp "$@"
`,
        { mode: 0o700 },
      );
      const result = spawnSync("/bin/bash", [selfTest], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          TMPDIR: temp + suffix,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("skip: no working hcn selected");
      expect(result.stdout).toContain("all check-claims tests passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
