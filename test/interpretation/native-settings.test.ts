import { expect, test } from "vitest";
import { parseCodexSettingsRecord } from "../../src/interpretation/native-settings.js";

test("native saved folder limits count UTF-8 bytes, as terminal resume does", () => {
  expect(
    parseCodexSettingsRecord({
      type: "turn_context",
      payload: { cwd: `/${"é".repeat(2048)}`, model: "saved-model", effort: "high" },
    }),
  ).toBeNull();
});
