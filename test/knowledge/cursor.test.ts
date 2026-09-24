import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { checkEffortTable, stemKeyOfSlug } from "./cursor-stem-check.js";

describe("cursor descriptor identity", () => {
  test("names the cursor harness at the verified version", () => {
    expect(cursorCli.name).toBe("cursor");
    expect(cursorCli.bin).toBe("agent");
    expect(cursorCli.verifiedAgainst).toBe("2026.09.23-86fc751");
    expect(cursorCli.versionSource).toEqual({ kind: "installed" });
  });

  test("is deeply frozen like the other descriptors", () => {
    expect(Object.isFrozen(cursorCli)).toBe(true);
    expect(Object.isFrozen(cursorCli.vocabulary)).toBe(true);
    expect(Object.isFrozen(cursorCli.vocabulary.models)).toBe(true);
  });
});

describe("cursor model vocabulary", () => {
  test("transcribes the 223 slugs from out/models.txt", () => {
    expect(cursorCli.vocabulary.models.length).toBe(223);
    expect(new Set(cursorCli.vocabulary.models).size).toBe(223);
  });

  test("matches the models.txt slug set byte for byte", () => {
    const bytes = `${[...cursorCli.vocabulary.models].sort().join("\n")}\n`;
    const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
    expect(digest).toBe("17713126ce312b64f5c27e695d28ace5318c44ed787283b69fb66a68dfc9327d");
  });

  test("pins the transcription against committed data both lanes read identically", () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, "cursor-transcription.snapshot.json"), "utf8"),
    ) as { models: readonly string[]; effortSlugs: Record<string, Record<string, string>> };
    expect([...cursorCli.vocabulary.models].sort()).toEqual(committed.models);
    expect(cursorCli.vocabulary.effortSlugs).toEqual(committed.effortSlugs);
  });

  test("carries 70 -fast twins plus the opaque composer-2.5-fast", () => {
    const fast = cursorCli.vocabulary.models.filter((s) => s.endsWith("-fast"));
    expect(fast.length).toBe(70);
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
    expect(Object.keys(rows).length).toBe(36);
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
