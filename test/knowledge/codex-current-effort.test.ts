import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { validateEffort } from "../../src/interpretation/vocabulary.js";
import { codexCli } from "../../src/knowledge/codex.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/codex-0.160.0/${file}`, import.meta.url), "utf8");

test("Codex admits the current native effort ladders and rejects removed minimal", () => {
  for (const [model, effort] of [
    ["gpt-5.6-sol", "low"],
    ["gpt-5.6-terra", "low"],
    ["gpt-5.6-luna", "low"],
    ["gpt-5.5", "xhigh"],
  ] as const) {
    const native = read(`effort-${model}-${effort}.ndjson`);
    expect(native).toContain('"type":"turn.completed"');
    expect(native).toContain('"text":"alpha"');
    expect(validateEffort(codexCli, effort, model)).toEqual({ ok: true, id: effort });
  }
  expect(read("effort-gpt-5.5-minimal-no-web.ndjson")).toContain("unsupported_value");
  expect(validateEffort(codexCli, "minimal", "gpt-5.5").ok).toBe(false);
  expect(validateEffort(codexCli, "ultra", "gpt-6.1-sol").ok).toBe(false);
  const roster = JSON.parse(read("models-curated.json"));
  expect([...codexCli.vocabulary.models].sort()).toEqual(
    roster
      .filter((entry: { visibility: string }) => entry.visibility === "list")
      .map((entry: { slug: string }) => entry.slug)
      .sort(),
  );
  for (const model of codexCli.vocabulary.models) {
    const native = roster.find((entry: { slug: string }) => entry.slug === model);
    expect(native.visibility).toBe("list");
    const efforts = native.supported_reasoning_levels
      .map((level: { effort: string }) => level.effort)
      .filter((effort: string) => effort !== "ultra" && effort !== "none");
    expect([...(codexCli.vocabulary.effortsByModel?.[model] ?? [])].sort()).toEqual(
      [...efforts].sort(),
    );
    for (const effort of [...codexCli.vocabulary.efforts, "ultra", "none"]) {
      const result = validateEffort(codexCli, effort, model);
      if (efforts.includes(effort)) {
        expect(result).toEqual({ ok: true, id: effort });
      } else {
        expect(result.ok, `${model} must reject ${effort}`).toBe(false);
      }
    }
  }
  const source = JSON.parse(read("version-source.snapshot.json"));
  expect(source.latest).toBe(codexCli.verifiedAgainst);
  expect(source.versionSource).toEqual(codexCli.versionSource);
});
