import { defineConfig } from "vitest/config";

// Scope discovery to test/ so future spikes/, docs/, or fixture directories
// never enter the deterministic suite by default-glob accident.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // CLI tests start subprocesses. Bound workers on high-core developer hosts.
    maxWorkers: 2,
    // The default 5 s is a deadline tuned to a fast local machine. These
    // tests spawn real children and build real SQLite stores; a loaded CI
    // runner has been measured 15x slower on the same test (5598 ms for
    // one that takes 362 ms here). A deadline inside that range turns
    // "slow runner" into a red suite. 20 s clears it and still fails a
    // genuine hang well inside the ~40 s the whole suite takes.
    // Keep this in step with the --timeout on `test:bun`.
    testTimeout: 20_000,
  },
});
