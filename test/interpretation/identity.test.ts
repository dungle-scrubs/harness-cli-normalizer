import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const fixtureLines = (): unknown[] =>
  readFileSync(join(import.meta.dirname, "../fixtures/a001-raw.ndjson"), "utf8")
    .split("\n")
    .filter((l: string) => l.trim() !== "")
    .map((l: string) => JSON.parse(l) as unknown);

const init = (id: string) => ({ type: "system", subtype: "init", session_id: id });

describe("decodeIdentity (claude, A-001 fixture)", () => {
  test("emits identity exactly once across a 3-turn session that re-emits init per turn (D-022)", () => {
    const events = fixtureLines();
    const inits = events.filter(
      (e) => typeof e === "object" && e !== null && (e as { subtype?: string }).subtype === "init",
    );
    expect(inits.length).toBeGreaterThan(1); // the fixture really re-emits init
    const sessionId = (inits[0] as { session_id: string }).session_id;
    expect(typeof sessionId).toBe("string");

    let lastSeen: string | null = null;
    const identities: string[] = [];
    for (const raw of events) {
      const decoded = decodeIdentity(claudeCode, raw, lastSeen);
      if (decoded.identity !== null) identities.push(decoded.identity);
      lastSeen = decoded.sessionId ?? lastSeen;
    }
    expect(identities).toEqual([sessionId]);
  });

  test("classifies duplicate re-announcements as turn-start metadata, not news", () => {
    expect(decodeIdentity(claudeCode, init("a1"), null)).toMatchObject({
      identity: "a1",
      outcome: "announced",
    });
    expect(decodeIdentity(claudeCode, init("a1"), "a1")).toMatchObject({
      identity: null,
      outcome: "duplicate",
    });
  });

  test("a changed id under caller-assigned authority is a rotation anomaly, never silently bound", () => {
    const rotated = decodeIdentity(claudeCode, init("b2"), "a1", "a1");
    expect(rotated.outcome).toBe("rotated");
    expect(rotated.identity).toBeNull();
    expect(rotated.sessionId).toBe("b2");
  });

  test("an announced id failing the shape rule is not believed (least-trusted input)", () => {
    expect(decodeIdentity(claudeCode, init("--dangerously-skip-permissions"), null).outcome).toBe(
      "malformed",
    );
    expect(decodeIdentity(claudeCode, init("../../../etc/passwd"), null).outcome).toBe("malformed");
  });
});
