import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES } from "../../src/execution/failure.js";
import { canonicalNames, READ_PRESET } from "../../src/interpretation/tool-vocabulary.js";
import { CANONICAL_TOOLS } from "../../src/knowledge/descriptor.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";

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

  it("lists every canonical tool name", () => {
    for (const name of canonicalNames(defaultDescriptors())) {
      expect(readme, `README missing canonical tool "${name}"`).toContain(name);
    }
  });

  it("lists every CANONICAL_TOOLS name", () => {
    for (const name of CANONICAL_TOOLS) {
      expect(readme, `README missing CANONICAL_TOOLS "${name}"`).toContain(name);
    }
  });

  it("lists every READ_PRESET name", () => {
    for (const name of READ_PRESET) {
      expect(readme, `README missing READ_PRESET "${name}"`).toContain(name);
    }
  });

  it("documents toolMap with verification disclaimer", () => {
    expect(readme).toContain("toolMap");
    expect(readme).toContain(
      "hcn cannot verify that a declared native name exists at run time; a wrong name reaches the harness as an unknown tool",
    );
  });
});
