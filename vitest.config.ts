import { defineConfig } from "vitest/config";

// Scope discovery to test/ so future spikes/, docs/, or fixture directories
// never enter the deterministic suite by default-glob accident.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
