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

/** The `hcn session --json` surface (ADR 0006, ADR 0007): the send
 * dispositions and the four control event kinds that frame the stream. */
const SESSION_DISPOSITIONS = ["started", "rejected"] as const;
const SESSION_EVENT_KINDS = ["session", "turn", "disposition", "closed"] as const;

describe("README contract", () => {
  it("lists every session disposition and no removed one", () => {
    for (const disposition of SESSION_DISPOSITIONS) {
      expect(readme, `README missing disposition "${disposition}"`).toContain(`\`${disposition}\``);
    }
    // ADR 0007 removed hcn's own send queue; the disposition went with it.
    expect(readme, "README documents the removed queued disposition").not.toMatch(/`queued`/);
  });

  it("lists every session control event kind", () => {
    for (const kind of SESSION_EVENT_KINDS) {
      expect(readme, `README missing session event kind "${kind}"`).toContain(`\`${kind}\``);
    }
  });

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
