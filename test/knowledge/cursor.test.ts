import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { checkEffortTable, stemKeyOfSlug } from "./cursor-stem-check.js";

/** The current native roster capture that the descriptor transcribes from.
 *  `test/fixtures/cursor-2026.10.01-e373342/models.txt` is the independent
 *  ground truth; historical snapshot data lives in
 *  `cursor-transcription.snapshot.json` for legacy subset checks. */
const MODELS_TXT_PATH = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "cursor-2026.10.01-e373342",
  "models.txt",
);
const entriesFromModelsTxt = (): string[] =>
  readFileSync(MODELS_TXT_PATH, "utf8")
    .split("\n")
    .filter((line) => line.includes(" - "))
    .map((line) => (line.split(" - ")[0] as string).trim());

describe("cursor descriptor identity", () => {
  test("names the cursor harness at the verified version", () => {
    expect(cursorCli.name).toBe("cursor");
    expect(cursorCli.bin).toBe("agent");
    expect(cursorCli.verifiedAgainst).toBe("2026.10.01-e373342");
    expect(cursorCli.versionSource).toEqual({ kind: "installed" });
  });

  test("is deeply frozen like the other descriptors", () => {
    expect(Object.isFrozen(cursorCli)).toBe(true);
    expect(Object.isFrozen(cursorCli.vocabulary)).toBe(true);
    expect(Object.isFrozen(cursorCli.vocabulary.models)).toBe(true);
  });
});

describe("cursor model vocabulary", () => {
  test("transcribes the 246 slugs from out/models.txt", () => {
    expect(cursorCli.vocabulary.models.length).toBe(246);
    expect(new Set(cursorCli.vocabulary.models).size).toBe(246);
  });

  test("matches the models.txt slug set byte for byte", () => {
    const bytes = `${[...cursorCli.vocabulary.models].sort().join("\n")}\n`;
    const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
    expect(digest).toBe("aafc1543ff180aff388579970c658dbc7a82f71dcae4e53bc973fa6ce3837612");
  });

  test("the current native models.txt capture pins the full roster and effort table", () => {
    // The fixture directory's `models.txt` is the independent ground
    // truth: every listed slug is in the descriptor and vice versa, and
    // `checkEffortTable` validates the table against the same set.
    const entries = entriesFromModelsTxt();
    expect(entries).toHaveLength(246);
    expect(new Set(entries).size).toBe(246);
    expect([...cursorCli.vocabulary.models].sort()).toEqual([...entries].sort());
    expect(() =>
      checkEffortTable(cursorCli.vocabulary.models, cursorCli.vocabulary.effortSlugs ?? {}),
    ).not.toThrow();
  });

  test("the historical snapshot folder is a subset of the current descriptor", () => {
    // The 2026-09-10 transcription snapshot is kept verbatim as historical
    // evidence; every entry it pins still appears in the current roster
    // and effort table. Future additions are not asserted against it.
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, "cursor-transcription.snapshot.json"), "utf8"),
    ) as { models: readonly string[]; effortSlugs: Record<string, Record<string, string>> };
    const currentModels = new Set(cursorCli.vocabulary.models);
    for (const slug of committed.models) {
      expect(currentModels.has(slug)).toBe(true);
    }
    const currentEfforts = cursorCli.vocabulary.effortSlugs ?? {};
    for (const [stem, row] of Object.entries(committed.effortSlugs)) {
      expect(Object.hasOwn(currentEfforts, stem)).toBe(true);
      for (const [effort, value] of Object.entries(row)) {
        expect(currentEfforts[stem]?.[effort]).toBe(value);
      }
    }
  });

  test("carries 79 -fast twins plus the opaque composer-2.5-fast", () => {
    const fast = cursorCli.vocabulary.models.filter((s) => s.endsWith("-fast"));
    expect(fast.length).toBe(79);
    expect(fast).toContain("composer-2.5-fast");
  });
});

describe("cursor effortSlugs stem rows", () => {
  test("matches the RFC representative rows", () => {
    const rows = cursorCli.vocabulary.effortSlugs ?? {};
    expect(rows["claude-opus-4-8"]).toEqual({
      low: "claude-opus-4-8-low",
      medium: "claude-opus-4-8-medium",
      high: "claude-opus-4-8-high",
      xhigh: "claude-opus-4-8-xhigh",
      max: "claude-opus-4-8-max",
    });
    expect(rows["gpt-5.2"]).toEqual({
      low: "gpt-5.2-low",
      medium: "gpt-5.2",
      high: "gpt-5.2-high",
      xhigh: "gpt-5.2-xhigh",
    });
    expect(rows["gpt-5.5"]?.xhigh).toBe("gpt-5.5-extra-high");
    expect(rows["kimi-k3"]).toEqual({
      low: "kimi-k3-low",
      high: "kimi-k3-high",
      max: "kimi-k3-max",
    });
    expect(rows["claude-4.6-sonnet-thinking"]).toEqual({
      medium: "claude-4.6-sonnet-medium-thinking",
    });
    expect(Object.keys(rows).length).toBe(39);
  });

  test("every slug is reachable from exactly one key or is bare-only", () => {
    expect(() =>
      checkEffortTable(cursorCli.vocabulary.models, cursorCli.vocabulary.effortSlugs ?? {}),
    ).not.toThrow();
  });

  test("transcription fails when a bare slug shares its stem with an explicit -medium slug", () => {
    expect(() =>
      checkEffortTable(["acme", "acme-medium", "acme-high"], {
        acme: { medium: "acme-medium", high: "acme-high" },
      }),
    ).toThrow(/double-map medium/);
  });
});

describe("cursor Stem rule", () => {
  test("keys infixed, suffixed, and bare thinking forms separately", () => {
    expect(stemKeyOfSlug("claude-opus-4-8-thinking-low")).toEqual({
      stem: "claude-opus-4-8-thinking",
      effort: "low",
      fast: false,
    });
    expect(stemKeyOfSlug("claude-4.6-sonnet-medium-thinking")).toEqual({
      stem: "claude-4.6-sonnet-thinking",
      effort: "medium",
      fast: false,
    });
    expect(stemKeyOfSlug("claude-4.5-sonnet-thinking")).toEqual({
      stem: "claude-4.5-sonnet-thinking",
      effort: undefined,
      fast: false,
    });
  });

  test("reads -extra-high as xhigh and strips one -fast", () => {
    expect(stemKeyOfSlug("gpt-5.5-extra-high")).toEqual({
      stem: "gpt-5.5",
      effort: "xhigh",
      fast: false,
    });
    expect(stemKeyOfSlug("gpt-5.2-high-fast")).toEqual({
      stem: "gpt-5.2",
      effort: "high",
      fast: true,
    });
    expect(stemKeyOfSlug("gpt-5.2")).toEqual({ stem: "gpt-5.2", effort: undefined, fast: false });
    expect(stemKeyOfSlug("auto")).toEqual({ stem: "auto", effort: undefined, fast: false });
  });
});
