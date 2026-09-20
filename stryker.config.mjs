import path from "node:path";

const mutateFlagIndex = process.argv.indexOf("--mutate");
const mutatedFile = mutateFlagIndex === -1 ? undefined : process.argv[mutateFlagIndex + 1];
const lane = mutatedFile === undefined ? "all" : path.basename(mutatedFile, path.extname(mutatedFile));

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  clearTextReporter: {
    logTests: false,
    reportMutants: false,
    reportTests: false,
  },
  commandRunner: {
    command: "pnpm exec vitest run --bail=1 --config vitest.mutation.config.ts",
  },
  concurrency: 8,
  coverageAnalysis: "off",
  ignorePatterns: [
    ".e2e",
    ".lucid",
    ".native-artifacts",
    ".scratch",
    ".smoke",
    "coverage",
    "dist",
    "docs",
  ],
  jsonReporter: {
    fileName: `reports/mutation/${lane}.json`,
  },
  mutate: [
    "src/execution/failure.ts",
    "src/interpretation/argv.ts",
    "src/interpretation/content.ts",
    "src/interpretation/session-input.ts",
  ],
  reporters: ["clear-text", "progress", "json"],
  testRunner: "command",
  thresholds: {
    break: null,
    high: 80,
    low: 60,
  },
};

export default config;
