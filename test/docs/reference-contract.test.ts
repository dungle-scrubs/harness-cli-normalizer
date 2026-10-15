import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES } from "../../src/execution/failure.js";
import { canonicalNames, READ_PRESET } from "../../src/interpretation/tool-vocabulary.js";
import { CANONICAL_TOOLS } from "../../src/knowledge/descriptor.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";

/** The full contract lives in docs/reference.md; the README links to it. */
const reference = readFileSync(resolve(import.meta.dirname, "../../docs/reference.md"), "utf8");

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
  "tool-result",
  "usage",
  "compaction",
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

describe("Reference contract", () => {
  it("lists every session disposition and no removed one", () => {
    for (const disposition of SESSION_DISPOSITIONS) {
      expect(reference, `reference missing disposition "${disposition}"`).toContain(
        `\`${disposition}\``,
      );
    }
    // ADR 0007 removed hcn's own send queue; the disposition went with it.
    expect(reference, "reference documents the removed queued disposition").not.toMatch(/`queued`/);
  });

  it("lists every session control event kind", () => {
    for (const kind of SESSION_EVENT_KINDS) {
      expect(reference, `reference missing session event kind "${kind}"`).toContain(`\`${kind}\``);
    }
  });

  it("lists every FailureClass", () => {
    for (const cls of FAILURE_CLASSES) {
      expect(reference, `reference missing FailureClass "${cls}"`).toContain(`"${cls}"`);
    }
  });

  it("lists every ExitCause", () => {
    for (const cause of EXIT_CAUSES) {
      expect(reference, `reference missing ExitCause "${cause}"`).toContain(`"${cause}"`);
    }
  });

  it("lists every HarnessEvent kind", () => {
    for (const kind of HARNESS_EVENT_KINDS) {
      const present =
        reference.includes(`"${kind}"`) ||
        reference.includes(`'${kind}'`) ||
        reference.includes(`\`${kind}\``);
      expect(present, `reference missing HarnessEvent kind "${kind}"`).toBe(true);
    }
  });

  it("lists every canonical tool name", () => {
    for (const name of canonicalNames(defaultDescriptors())) {
      expect(reference, `reference missing canonical tool "${name}"`).toContain(name);
    }
  });

  it("lists every CANONICAL_TOOLS name", () => {
    for (const name of CANONICAL_TOOLS) {
      expect(reference, `reference missing CANONICAL_TOOLS "${name}"`).toContain(name);
    }
  });

  it("lists every READ_PRESET name", () => {
    for (const name of READ_PRESET) {
      expect(reference, `reference missing READ_PRESET "${name}"`).toContain(name);
    }
  });

  it("documents the resume-last signal (RFC-06 Phase 3)", () => {
    expect(reference).toContain("--resume-last");
    expect(reference).toContain("resumeLast: true");
  });

  it("documents toolMap with verification disclaimer", () => {
    expect(reference).toContain("toolMap");
    expect(reference).toContain(
      "hcn cannot verify that a declared native name exists at run time; a wrong name reaches the harness as an unknown tool",
    );
  });
});
