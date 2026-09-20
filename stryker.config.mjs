import os from "node:os";
import path from "node:path";

const mutateFlagIndex = process.argv.indexOf("--mutate");
const mutatedFile = mutateFlagIndex === -1 ? undefined : process.argv[mutateFlagIndex + 1];
const lanes = {
  "src/execution/failure.ts": { floor: 75, name: "failure" },
  "src/interpretation/argv.ts": { floor: 84, name: "argv" },
  "src/interpretation/content.ts": { floor: 81, name: "content" },
  "src/interpretation/session-input.ts": { floor: 99, name: "session-input" },
};
const selectedLane = mutatedFile === undefined ? undefined : lanes[mutatedFile];

if (selectedLane === undefined) {
  const received = mutatedFile === undefined ? "no --mutate target" : `--mutate ${mutatedFile}`;
  throw new Error(
    `Unsupported Stryker mutation lane (${received}). Run one of: ` +
      "pnpm test:mutation:failure, pnpm test:mutation:argv, " +
      "pnpm test:mutation:content, pnpm test:mutation:session-input.",
  );
}

const lane = selectedLane.name;

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
  tempDirName: path.join(os.tmpdir(), "hcn-stryker", lane),
  testRunner: "command",
  thresholds: {
    break: selectedLane.floor,
    high: 80,
    low: 60,
  },
};

export default config;
