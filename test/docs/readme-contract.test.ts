import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES } from "../../src/execution/failure.js";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");

const EXIT_CAUSES = [
  "clean",
  "limit",
  "crash",
  "stall",
  "killed",
  "failed",
  "awaiting-input",
] as const;

const HARNESS_EVENT_KINDS = [
  "identity",
  "token",
  "message",
  "progress",
  "tool",
  "context",
  "question",
  "limit",
  "error",
  "failure",
  "done",
] as const;

describe("README contract", () => {
  it("lists every FailureClass", () => {
    for (const cls of FAILURE_CLASSES) {
      expect(readme, `README missing FailureClass "${cls}"`).toContain(`"${cls}"`);
    }
  });

  it("lists every ExitCause", () => {
    for (const cause of EXIT_CAUSES) {
      expect(readme, `README missing ExitCause "${cause}"`).toContain(`"${cause}"`);
    }
  });

  it("lists every HarnessEvent kind", () => {
    for (const kind of HARNESS_EVENT_KINDS) {
      const present =
        readme.includes(`"${kind}"`) ||
        readme.includes(`'${kind}'`) ||
        readme.includes(`\`${kind}\``);
      expect(present, `README missing HarnessEvent kind "${kind}"`).toBe(true);
    }
  });
});
