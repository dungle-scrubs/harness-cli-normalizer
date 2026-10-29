/**
 * Placement gate for disposable CLI fixtures.
 *
 * The rule lives in docs/agents/rules.md: a temporary directory that a CLI
 * test allocates belongs under the shared CLI fixture root
 * (`.test-tmp/cli-fixtures`), which keeps its CommonJS package and
 * Git-discovery boundaries. The gate reads the TypeScript AST of every source
 * under `test/cli`, so a script that only mentions `mkdtempSync` inside a
 * string is not an allocation.
 *
 * The scope is the CLI test tree - `test/cli` and its subdirectories - and
 * only the `.ts` and `.tsx` sources in it. The rule concerns disposable CLI
 * fixtures; it does not reach the database, parser or other unit tests
 * elsewhere in the test tree.
 *
 * A file that existed at base f3131d4 keeps a per-file allowance for the
 * allocations it already had; every other file starts at zero. The
 * allowances are literal numbers, generated once from that base, and they
 * only ever shrink: a migrated allocation must lower its entry, so an
 * allowance cannot stay quietly reusable.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { type FixtureAllocation, scanFixtureAllocations } from "./cli/fixture-placement.js";
import { cliFixtureTmpdir } from "./cli/fixture-tmpdir.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_TEST_ROOT = join(REPO_ROOT, "test", "cli");

/**
 * Per-file allowances for the allocations that predate this gate, generated
 * once from base f3131d4 within the CLI test tree. A file that is not listed
 * here gets no allowance.
 */
const BASELINE: Readonly<Record<string, number>> = {
  "test/cli/build-state.test.ts": 1,
  "test/cli/cli.test.ts": 20,
  "test/cli/fixture-tmpdir.ts": 1,
  "test/cli/inspect-models.test.ts": 1,
  "test/cli/installed-version.test.ts": 1,
  "test/cli/ledger.test.ts": 1,
  "test/cli/muse-blocked-approval.test.ts": 1,
  "test/cli/muse-sigint-observer.test.ts": 1,
  "test/cli/observer-run.test.ts": 2,
  "test/cli/observer.test.ts": 1,
  "test/cli/post-turn-crash.test.ts": 1,
  "test/cli/question.test.ts": 2,
  "test/cli/reap.test.ts": 2,
  "test/cli/resume-guard-cli.test.ts": 15,
  "test/cli/resume-guard.test.ts": 35,
  "test/cli/resume-last-guard.test.ts": 10,
  "test/cli/resume-last.test.ts": 4,
  "test/cli/run-line-limit.test.ts": 1,
  "test/cli/session-context-window.test.ts": 1,
  "test/cli/session-json.test.ts": 3,
  "test/cli/session-skills.test.ts": 1,
  "test/cli/setup-state.test.ts": 3,
  "test/cli/setup-state.ts": 1,
};

/** Every TypeScript source under the CLI test tree. */
const listCliTestFiles = (): string[] =>
  readdirSync(CLI_TEST_ROOT, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .map((file) => `test/cli/${file.split(sep).join("/")}`);

describe("disposable CLI fixture placement", () => {
  test("every temporary-directory allocation in the CLI test tree derives from the shared CLI fixture root", async () => {
    const files = listCliTestFiles();
    const allocations = await scanFixtureAllocations(files);
    const offenders = allocations.filter((allocation) => !allocation.canonical);
    const counts = new Map<string, number>();
    for (const offender of offenders) {
      counts.set(offender.file, (counts.get(offender.file) ?? 0) + 1);
    }

    const problems: string[] = [];
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const actual = counts.get(file) ?? 0;
      if (actual < allowed) {
        problems.push(
          `${file} has ${actual} noncanonical allocation(s) but the baseline allows ${allowed}; lower the baseline entry to ${actual}`,
        );
      }
      if (!files.includes(file)) {
        problems.push(`${file} is in the baseline but no longer exists; remove its baseline entry`);
      }
    }
    for (const offender of offenders) {
      const allowed = BASELINE[offender.file] ?? 0;
      if ((counts.get(offender.file) ?? 0) <= allowed) continue;
      problems.push(
        `${offender.file}:${offender.line}:${offender.column} allocates a temporary directory outside the shared CLI fixture root (${offender.callee}); use cliFixtureTmpdir() from test/cli/fixture-tmpdir.ts`,
      );
    }

    expect(problems).toEqual([]);
  });
});

/** The scratch root the scanner cases are written into. */
const CASE_ROOT = mkdtempSync(join(cliFixtureTmpdir(), "hcn-placement-cases-"));
afterAll(() => rmSync(CASE_ROOT, { recursive: true, force: true }));

/** Scan one synthetic source and report the allocations it makes. */
const scanCase = async (name: string, source: string): Promise<FixtureAllocation[]> => {
  const path = join(CASE_ROOT, `${name}.ts`);
  writeFileSync(path, source);
  return await scanFixtureAllocations([path]);
};

describe("fixture placement scanner", () => {
  test("an allocation through the shared fixture helper is canonical", async () => {
    const allocations = await scanCase(
      "safe-direct",
      `import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const dir = mkdtempSync(join(cliFixtureTmpdir(), "hcn-safe-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(true);
  });

  test("an allocation through a local constant prefix is canonical", async () => {
    const allocations = await scanCase(
      "safe-constant",
      `import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const prefix = join(cliFixtureTmpdir(), "hcn-safe-constant-");
export const dir = mkdtempSync(prefix);
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(true);
  });

  test("a direct allocation in the system temp directory is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-direct",
      `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dir = mkdtempSync(join(tmpdir(), "hcn-unsafe-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an aliased allocation import is still detected", async () => {
    const allocations = await scanCase(
      "unsafe-aliased",
      `import { mkdtempSync as makeTemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dir = makeTemp(join(tmpdir(), "hcn-aliased-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.callee).toBe("makeTemp");
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("a namespace allocation import is still detected", async () => {
    const allocations = await scanCase(
      "unsafe-namespace",
      `import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dir = fs.mkdtempSync(join(tmpdir(), "hcn-namespace-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation through a prefix variable is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-prefix-variable",
      `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prefix = join(tmpdir(), "hcn-prefix-");
export const dir = mkdtempSync(prefix);
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation with a literal root is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-literal-root",
      `import { mkdtempSync } from "node:fs";

export const dir = mkdtempSync("/tmp/hcn-literal-");
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an asynchronous allocation outside the fixture root is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-async",
      `import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dir = await mkdtemp(join(tmpdir(), "hcn-async-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation that replaces the root with an absolute path is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-absolute-replacement",
      `import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const dir = mkdtempSync(resolve(cliFixtureTmpdir(), "/tmp/hcn-escape-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation that walks out of the root with a parent segment is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-parent-traversal",
      `import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const dir = mkdtempSync(join(cliFixtureTmpdir(), "..", "..", "escape-"));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation that prepends a literal root is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-prepended-root",
      `import { mkdtempSync } from "node:fs";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const dir = mkdtempSync("/tmp/" + cliFixtureTmpdir());
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation whose root is not the leading path part is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-trailing-root",
      `import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const dir = mkdtempSync(join("hcn-trailing-", cliFixtureTmpdir()));
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation whose prefix variable is reassigned is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-reassigned-prefix",
      `import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

let prefix = join(cliFixtureTmpdir(), "hcn-reassigned-");
prefix = "/tmp/hcn-escape-";
export const dir = mkdtempSync(prefix);
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("an allocation with an unknown dynamic suffix is not canonical", async () => {
    const allocations = await scanCase(
      "unsafe-dynamic-suffix",
      `import { mkdtempSync } from "node:fs";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const make = (label: string): string => mkdtempSync(\`\${cliFixtureTmpdir()}-\${label}\`);
`,
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.canonical).toBe(false);
  });

  test("code that only mentions an allocation inside a string is not an allocation", async () => {
    const allocations = await scanCase(
      "ignored-code-string",
      `import { mkdtempSync } from "node:fs";

export const snippet = "const dir = mkdtempSync(prefix);";
`,
    );
    expect(allocations).toEqual([]);
  });
});
