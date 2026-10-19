import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const selfTest = resolve(import.meta.dirname, "check-claims.test.sh");

// Use Node even in the Bun lane because the shell checker verifies Node's floor.
const node = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
  timeout: 5_000,
}).trim();

function resolveMktemp(pathValue: string): string {
  const result = spawnSync("/bin/sh", ["-c", "command -v mktemp"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: pathValue },
  });
  const resolved = result.stdout.trim();
  if (result.error || result.status !== 0 || !/^\//.test(resolved)) {
    throw new Error(
      result.error
        ? `mktemp lookup failed: ${String(result.error)}`
        : `no absolute mktemp resolved (exit ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return resolved;
}

// A working installation whose mktemp lives outside /usr/bin is supported
// (issue #404): the system mktemp is resolved from the caller's PATH before
// any fixture shadows it.
const systemMktemp = resolveMktemp(process.env.PATH ?? "/usr/bin:/bin");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shimScript(realMktemp: string): string {
  return `#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != "-d" ]; then
  echo "implicit temp selection does not honor caller TMPDIR" >&2
  exit 97
fi
case "$2" in
  "$TMPDIR"/*) ;;
  *) echo "template escapes caller TMPDIR" >&2; exit 98 ;;
esac
exec ${shellSingleQuote(realMktemp)} "$@"
`;
}

// A recording delegate: every invocation is logged, then the caller-resolved
// system mktemp runs. A shim reverted to `exec /usr/bin/mktemp` would leave
// the log empty.
function delegateScript(realMktemp: string, logPath: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${shellSingleQuote(logPath)}
exec ${shellSingleQuote(realMktemp)} "$@"
`;
}

type Fixture = {
  root: string;
  bin: string;
  delegateLog: string;
  env: { PATH: string; HOME: string; TMPDIR: string };
};

type FixtureTrace = { roots: string[] };

// The recording delegate lives in realbin - a real, working mktemp outside
// /usr/bin - so the delegation follows the lookup. Setup runs inside one
// try/catch so a failed step cannot leak the partially created root: the
// builder removes only its own root before rethrowing.
function buildFixture(
  options: {
    tmpdirSuffix?: string;
    failSetup?: "non-executable-delegate";
    trace?: FixtureTrace;
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hcn-skill-self-test-"));
  options.trace?.roots.push(root);
  try {
    const bin = join(root, "bin");
    const home = join(root, "home");
    const realbin = join(root, "realbin");
    const temp = join(root, "temp with spaces");
    const delegateLog = join(root, "delegate-invocations");
    for (const path of [bin, home, realbin, temp]) mkdirSync(path);
    symlinkSync(node, join(bin, "node"));
    writeFileSync(join(realbin, "mktemp"), delegateScript(systemMktemp, delegateLog), {
      mode: options.failSetup === "non-executable-delegate" ? 0o644 : 0o700,
    });
    const realMktemp = resolveMktemp(`${realbin}:/usr/bin:/bin`);
    expect(realMktemp).toBe(join(realbin, "mktemp"));
    expect(realMktemp).not.toBe(join(bin, "mktemp"));
    writeFileSync(join(bin, "mktemp"), shimScript(realMktemp), { mode: 0o700 });
    return {
      root,
      bin,
      delegateLog,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: temp + (options.tmpdirSuffix ?? ""),
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe("skill self-test fixture isolation", () => {
  test.each(["", "/"])("honors TMPDIR containing spaces with suffix %j", (suffix) => {
    const { root, env, delegateLog } = buildFixture({ tmpdirSuffix: suffix });
    try {
      const result = spawnSync("/bin/bash", [selfTest], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("skip: no working hcn selected");
      expect(result.stdout).toContain("all check-claims tests passed");
      // The whole shell self-test delegated its guarded allocation to the
      // resolved non-/usr/bin binary, not a hard-coded location: the
      // recording delegate must have been invoked with the guarded call
      // (issue #404). A shim reverted to `exec /usr/bin/mktemp` fails here.
      const delegated = existsSync(delegateLog) ? readFileSync(delegateLog, "utf8") : "";
      expect(delegated, "the resolved recording delegate was never invoked").toContain("-d");
      expect(delegated).toContain("hcn-check-claims");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a self-test reverted to implicit temp allocation", () => {
    const { root, env } = buildFixture();
    try {
      // Recreate the pre-#401 implicit call and prove the whole shell
      // self-test fails on it instead of drifting to the system temp.
      const guardedCall =
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template placeholder
        'fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/hcn-check-claims.XXXXXX") || exit 1';
      const original = readFileSync(selfTest, "utf8");
      expect(original).toContain(guardedCall);
      const reverted = join(root, "check-claims-reverted.test.sh");
      writeFileSync(reverted, original.replace(guardedCall, "fixture_dir=$(mktemp -d) || exit 1"));
      const result = spawnSync("/bin/bash", [reverted], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("implicit temp selection does not honor caller TMPDIR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the shim still rejects templates outside the owned TMPDIR", () => {
    const { root, bin, env } = buildFixture();
    try {
      const result = spawnSync(join(bin, "mktemp"), ["-d", "/tmp/hcn-escape.XXXXXX"], {
        env,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(98);
      expect(result.stderr).toContain("template escapes caller TMPDIR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fixture builder setup cleanup", () => {
  test("a failed setup step removes the partially created fixture root", () => {
    const trace: FixtureTrace = { roots: [] };
    expect(() => buildFixture({ failSetup: "non-executable-delegate", trace })).toThrow();
    expect(trace.roots).toHaveLength(1);
    const leaked = trace.roots[0];
    expect(leaked).toBeDefined();
    expect(existsSync(leaked as string)).toBe(false);
  });
});
