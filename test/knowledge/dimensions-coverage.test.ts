import { describe, expect, test } from "vitest";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

/**
 * Gate 2->3 guard, re-anchored (RFC-02 change 7): the key set every
 * descriptor carries is exactly the HarnessDescriptor type's keys. The
 * list below is checked against the type in both directions at typecheck
 * time - `satisfies` refuses a key the type lacks, and `complete` refuses
 * a type key the list lacks - so a descriptor change cannot add or drop a
 * key unnoticed. Whether a key has a consumer is
 * descriptor-consumers.test.ts's job.
 */
const DESCRIPTOR_KEYS = [
  "name",
  "transcript",
  "bin",
  "verifiedAgainst",
  "versionSource",
  "launch",
  "resume",
  "sessionMode",
  "output",
  "identity",
  "limitMatchers",
  "authMatchers",
  "autonomy",
  "vocabulary",
  "store",
  "contextInspection",
  "nativeContextManagement",
  // ADR 0009 adds the compaction-reporting key: which channel carries a
  // harness's compaction, or null where none does.
  "compactionReporting",
  "resumeLast",
  "stdin",
  "presence",
  "capabilities",
  "escalation",
  "turnOptions",
  "skills",
  "tools",
  // RFC-05 Phase 1 adds the optional trust-matchers top-level key.
  "trustMatchers",
  // Issue #179 adds the optional approval-observer top-level key (only
  // muse carries it).
  "approvalObserver",
] as const satisfies readonly (keyof HarnessDescriptor)[];

type Missing = Exclude<keyof HarnessDescriptor, (typeof DESCRIPTOR_KEYS)[number]>;
const complete: Missing extends never ? true : false = true;

// RFC-05 Phase 1 makes trustMatchers the first optional top-level key
// (only cursor carries it), so "exactly the type's keys" becomes two
// checks: every required key present, and no key outside the type.
// Issue #179 adds approvalObserver as the second (only muse carries it).
const OPTIONAL_KEYS = [
  "trustMatchers",
  "approvalObserver",
] as const satisfies readonly (keyof HarnessDescriptor)[];

describe("descriptor key coverage", () => {
  test("every descriptor carries the required keys and no unknown keys", () => {
    expect(complete).toBe(true);
    const expected = [...DESCRIPTOR_KEYS].sort();
    const required = expected.filter((k) => !(OPTIONAL_KEYS as readonly string[]).includes(k));
    for (const h of [claudeCode, codexCli, piCli, museCode, cursorCli, antigravityCli]) {
      const keys = Object.keys(h).sort();
      for (const k of required) expect(keys).toContain(k);
      for (const k of keys) expect(expected).toContain(k);
    }
  });

  test("resumeLast headless dimension: renderable set vs parse-only set (RFC-06 Phase 5: cursor renders)", () => {
    const renderable = [claudeCode, codexCli, piCli, cursorCli, antigravityCli]
      .map((h) => h.name)
      .sort();
    const parseOnly = [museCode].map((h) => h.name).sort();
    for (const h of [claudeCode, codexCli, piCli, museCode, cursorCli, antigravityCli]) {
      expect(h.resumeLast).not.toBeNull();
    }
    expect(
      [claudeCode, codexCli, piCli, museCode, cursorCli, antigravityCli]
        .filter((h) => h.resumeLast?.headless === true)
        .map((h) => h.name)
        .sort(),
    ).toEqual(renderable);
    expect(
      [claudeCode, codexCli, piCli, museCode, cursorCli, antigravityCli]
        .filter((h) => h.resumeLast?.headless === false)
        .map((h) => h.name)
        .sort(),
    ).toEqual(parseOnly);
  });
});
