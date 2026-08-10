import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const fixtureLines = (): unknown[] =>
  readFileSync(join(__dirname, "../fixtures/a001-raw.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

describe("decodeIdentity (claude, A-001 fixture)", () => {
  test("emits identity exactly once across a 3-turn session that re-emits init per turn (D-022)", () => {
    const events = fixtureLines();
    const inits = events.filter(
      (e) => typeof e === "object" && e !== null && (e as { subtype?: string }).subtype === "init",
    );
    expect(inits.length).toBeGreaterThan(1); // the fixture really re-emits init

    let lastSeen: string | null = null;
    const identities: string[] = [];
    for (const raw of events) {
      const decoded = decodeIdentity(claudeCode, raw, lastSeen);
      if (decoded.identity !== null) identities.push(decoded.identity);
      lastSeen = decoded.sessionId ?? lastSeen;
    }
    expect(identities).toEqual(["eb04301d-8756-4a8b-ae3e-aac0e71f7265"]);
  });

  test("emits identity again when the announced id actually changes", () => {
    const first = decodeIdentity(
      claudeCode,
      { type: "system", subtype: "init", session_id: "a" },
      null,
    );
    expect(first.identity).toBe("a");
    const dup = decodeIdentity(
      claudeCode,
      { type: "system", subtype: "init", session_id: "a" },
      "a",
    );
    expect(dup.identity).toBeNull();
    const changed = decodeIdentity(
      claudeCode,
      { type: "system", subtype: "init", session_id: "b" },
      "a",
    );
    expect(changed.identity).toBe("b");
  });
});
