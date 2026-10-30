import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { validateEffort } from "../../src/interpretation/vocabulary.js";
import { codexCli } from "../../src/knowledge/codex.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/codex-0.160.0/${file}`, import.meta.url), "utf8");

test("Codex retains historical effort contracts and matches the current native ladders", () => {
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
  expect(validateEffort(codexCli, "max", "gpt-5.5").ok).toBe(false);
  expect(validateEffort(codexCli, "ultra", "gpt-6.1-sol").ok).toBe(false);
  const readCurrent = (file: string): string =>
    readFileSync(new URL(`../fixtures/codex-0.165.0/${file}`, import.meta.url), "utf8");
  const roster = JSON.parse(readCurrent("models-all.rpc.ndjson")).result.data;
  const visible = JSON.parse(readCurrent("models.rpc.ndjson")).result.data;
  // The 0.165.0 catalog omits gpt-5.5 (visible and hidden); the descriptor
  // retains its historical ladder for older compatible codex installs, and
  // native acceptance was not re-probed on 0.165.0. The catalog is not
  // demanded to equal the descriptor: the legacy model outlives its listing.
  expect(codexCli.vocabulary.models).toContain("gpt-5.5");
  expect(codexCli.vocabulary.effortsByModel?.["gpt-5.5"]).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  expect(roster.find((entry: { model: string }) => entry.model === "gpt-5.5")).toBeUndefined();
  // Every curated model except the historical gpt-5.5 is still in the native
  // picker roster, and the curated effort ladder matches the native one.
  for (const model of codexCli.vocabulary.models.filter((entry) => entry !== "gpt-5.5")) {
    const entry = visible.find((candidate: { model: string }) => candidate.model === model);
    expect(entry, `${model} must be in the native roster`).toBeDefined();
    const efforts: string[] = entry.supportedReasoningEfforts
      .map((level: { reasoningEffort: string }) => level.reasoningEffort)
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
  // The 0.165.0 roster adds one model that hcn has not curated. The native
  // catalog is the evidence for it; the curated list grows in its own change.
  expect(visible.map((entry: { model: string }) => entry.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6.1-terra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  const terra = visible.find((entry: { model: string }) => entry.model === "gpt-6.1-terra");
  expect(
    terra.supportedReasoningEfforts.map(
      (level: { reasoningEffort: string }) => level.reasoningEffort,
    ),
  ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(
    roster
      .filter((entry: { hidden: boolean }) => entry.hidden)
      .map((entry: { model: string }) => entry.model),
  ).toEqual(["gpt-reserve", "codex-auto-review"]);
  // Historical catalog evidence: 0.162.1 still listed gpt-5.5 as hidden
  // with a scheduled retirement date.
  const readPrior = (file: string): string =>
    readFileSync(new URL(`../fixtures/codex-0.162.1/${file}`, import.meta.url), "utf8");
  const priorRoster = JSON.parse(readPrior("models-all.rpc.ndjson")).result.data;
  expect(priorRoster.find((entry: { model: string }) => entry.model === "gpt-5.5")).toMatchObject({
    hidden: true,
    upgradeInfo: { retirementAt: 1792004400 },
  });
  const source = JSON.parse(readCurrent("version-source.snapshot.json"));
  expect(source.latest).toBe(codexCli.verifiedAgainst);
  expect(source.versionSource).toEqual(codexCli.versionSource);
});
