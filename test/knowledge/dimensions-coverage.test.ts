import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
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
  "contextHook",
  "resumeLast",
  "stdin",
  "presence",
  "capabilities",
  "escalation",
  "turnOptions",
  "skills",
  "tools",
] as const satisfies readonly (keyof HarnessDescriptor)[];

type Missing = Exclude<keyof HarnessDescriptor, (typeof DESCRIPTOR_KEYS)[number]>;
const complete: Missing extends never ? true : false = true;

describe("descriptor key coverage", () => {
  test("every descriptor carries exactly the type's keys", () => {
    expect(complete).toBe(true);
    const expected = [...DESCRIPTOR_KEYS].sort();
    for (const h of [claudeCode, codexCli, piCli, museCode]) {
      expect(Object.keys(h).sort()).toEqual(expected);
    }
  });
});
