import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/interpretation/purity.test.ts"],
    include: [
      "test/execution/**/*.test.ts",
      "test/interpretation/**/*.test.ts",
      "test/knowledge/**/*.test.ts",
    ],
    maxWorkers: 2,
  },
});
