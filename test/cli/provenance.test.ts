/**
 * RFC-05 Phase 3: writeProvenance prints the recorded unrenderable tier
 * (profile, user-config, or project-config) so the owner can see which
 * file set the diverged dimension, instead of the hardcoded profile.
 */
import { describe, expect, test } from "vitest";
import { writeProvenance } from "../../src/cli/provenance.js";

const captured = (fn: () => void): string[] => {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
  return lines;
};

describe("writeProvenance", () => {
  test("a divergence line prints the recorded tier, not profile", () => {
    const lines = captured(() =>
      writeProvenance("cursor", [], [{ key: "effort", tier: "user-config" }]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('divergence: user-config "effort"');
  });
});
