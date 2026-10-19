import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ensureCurrentBuild } from "./build-state.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const vitestEntry = fileURLToPath(import.meta.resolve("vitest"));
const vitestConfig = fileURLToPath(import.meta.resolve("vitest/config"));
const vitestCli = join(
  dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
  "vitest.mjs",
);

type BuildState = "missing" | "stale" | "fresh" | "equal";

const fixture = (state: BuildState): string => {
  const root = mkdtempSync(join(tmpdir(), "hcn-build-state-"));
  try {
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "dist"));
    const source = join(root, "src", "nested", "input.ts");
    writeFileSync(source, "export {};\n");
    utimesSync(source, 100, 100);
    if (state !== "missing") {
      const cli = join(root, "dist", "cli.js");
      writeFileSync(cli, "// synthetic build\n");
      const time = state === "stale" ? 50 : state === "equal" ? 100 : 150;
      utimesSync(cli, time, time);
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

describe("explicit build validation", () => {
  for (const state of ["missing", "stale", "fresh", "equal"] as const) {
    test(state, () => {
      const root = fixture(state);
      try {
        if (state === "missing" || state === "stale") {
          expect(() => ensureCurrentBuild(root)).toThrow(
            state === "missing"
              ? "dist/cli.js is missing - run `pnpm build` first"
              : "dist/cli.js is older than src/ - run `pnpm build` first",
          );
        } else {
          expect(ensureCurrentBuild(root)).toBe(join(root, "dist", "cli.js"));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("raw runner startup", () => {
  for (const runner of ["vitest", "bun"] as const) {
    for (const state of ["missing", "stale", "fresh"] as const) {
      test(`${runner}: ${state} build`, () => {
        const root = fixture(state);
        try {
          mkdirSync(join(root, "test", "cli"), { recursive: true });
          mkdirSync(join(root, "tmp"));
          mkdirSync(join(root, "home"));
          writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
          for (const name of [
            "build-state.ts",
            "setup-build.ts",
            "setup-state.ts",
            "setup-state.bun.ts",
          ]) {
            copyFileSync(join(repository, "test", "cli", name), join(root, "test", "cli", name));
          }
          const stateModule = join(root, "test", "cli", "setup-state.ts");
          const stateSource = readFileSync(stateModule, "utf8");
          const allocation = "boundDir = mkdtempSync(prefix);";
          expect(stateSource.split(allocation)).toHaveLength(2);
          // Record entry outside the sandbox so teardown cannot erase an ordering violation.
          writeFileSync(
            stateModule,
            'import { writeFileSync as recordAllocation } from "node:fs";\n' +
              stateSource.replace(
                allocation,
                `recordAllocation("allocator-entry", "entered");\n    ${allocation}`,
              ),
          );
          const operatorState = join(root, "operator-state");
          mkdirSync(operatorState);
          const operatorSentinel = join(operatorState, "sentinel");
          const operatorBytes = Buffer.from("owned synthetic operator state\0must survive\n");
          writeFileSync(operatorSentinel, operatorBytes);
          const operatorEntries = readdirSync(operatorState);
          // Exercise the checked-in startup lists, not a parallel test-only configuration.
          writeFileSync(
            join(root, "vitest.config.ts"),
            readFileSync(join(repository, "vitest.config.ts"), "utf8").replace(
              '"vitest/config"',
              JSON.stringify(vitestConfig),
            ),
          );
          copyFileSync(join(repository, "bunfig.toml"), join(root, "bunfig.toml"));
          const api = runner === "bun" ? "bun:test" : vitestEntry;
          writeFileSync(
            join(root, "test", "sentinel.test.ts"),
            `import { test, expect } from ${JSON.stringify(api)};
import { writeFileSync, existsSync } from "node:fs";
writeFileSync("import-sentinel", "loaded");
test("executes with isolated state", () => {
  expect(process.env.HCN_STATE_DIR).not.toBe(${JSON.stringify(join(root, "operator-state"))});
  expect(existsSync(process.env.HCN_STATE_DIR!)).toBe(true);
  writeFileSync("test-sentinel", "ran");
});\n`,
          );
          const child = spawnSync(
            runner === "bun" ? "bun" : "node",
            runner === "bun" ? ["test"] : [vitestCli, "run"],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                HOME: join(root, "home"),
                TMPDIR: join(root, "tmp"),
                HCN_STATE_DIR: join(root, "operator-state"),
                NO_COLOR: "1",
              },
              encoding: "utf8",
              timeout: 15000,
            },
          );
          const output = `${child.stdout}\n${child.stderr}`;
          expect(child.error, output).toBeUndefined();
          expect(child.signal, output).toBeNull();
          if (state === "fresh") {
            expect(child.status, output).toBe(0);
            expect(readFileSync(join(root, "test-sentinel"), "utf8")).toBe("ran");
            expect(readFileSync(join(root, "import-sentinel"), "utf8")).toBe("loaded");
            expect(readFileSync(join(root, "allocator-entry"), "utf8")).toBe("entered");
          } else {
            expect(child.status, output).toBe(1);
            expect(output).toContain(
              state === "missing"
                ? "dist/cli.js is missing - run `pnpm build` first"
                : "dist/cli.js is older than src/ - run `pnpm build` first",
            );
            expect(existsSync(join(root, "import-sentinel"))).toBe(false);
            expect(existsSync(join(root, "test-sentinel"))).toBe(false);
            expect(
              existsSync(join(root, "allocator-entry")),
              "allocator entered before build rejection",
            ).toBe(false);
          }
          expect(existsSync(operatorState), "synthetic operator directory must survive").toBe(true);
          expect(readdirSync(operatorState)).toEqual(operatorEntries);
          expect(readFileSync(operatorSentinel)).toEqual(operatorBytes);
          expect(
            readdirSync(join(root, "tmp")).filter((name) => name.startsWith("hcn-test-state-")),
          ).toEqual([]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
