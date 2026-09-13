import { expect, test } from "vitest";
import {
  ArgvRefusalError,
  buildSpawnArgv,
  type SpawnArgvOptions,
} from "../../src/interpretation/argv.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import type { NativeSettingsSnapshot } from "../../src/knowledge/native-settings.js";

// Synthetic source evidence. Execution must independently re-read its fingerprint.
const saved: NativeSettingsSnapshot = {
  cwd: "/project",
  effort: "high",
  fingerprint: "a".repeat(64),
  harness: "codex",
  model: "custom-saved-model",
  provider: "saved-provider",
  sessionId: "407feafe-e82b-4df4-91ba-4f1aeb987508",
  source: "codex-rollout-v1",
  status: "available",
  v: 1,
};

test("verified Codex resume renders saved selectors before the prompt without catalog substitution", () => {
  const argv = buildSpawnArgv(codexCli, {
    prompt: "EXACT_INPUT",
    resume: saved.sessionId,
    verifiedNativeSettings: saved,
  });
  expect(argv).toEqual([
    "codex",
    "exec",
    "resume",
    saved.sessionId,
    "--json",
    "--skip-git-repo-check",
    "--model",
    "custom-saved-model",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'model_provider="saved-provider"',
    "EXACT_INPUT",
  ]);
});

test.each<Partial<SpawnArgvOptions>>([
  { resume: undefined },
  { resume: "507feafe-e82b-4df4-91ba-4f1aeb987508" },
  { model: "gpt-6-astra" },
  { effort: "low" },
  { provider: "other" },
  { passthrough: ["-c", "model=other"] },
  { verifiedNativeSettings: { ...saved, model: "--bad" } },
  { verifiedNativeSettings: { ...saved, provider: "bad\nprovider" } },
  { verifiedNativeSettings: { ...saved, effort: "invented" } },
  { verifiedNativeSettings: { ...saved, fingerprint: "invalid" } },
])("verified settings refuse a conflicting or invalid request %j", (override) => {
  expect(() =>
    buildSpawnArgv(codexCli, {
      prompt: "EXACT_INPUT",
      resume: saved.sessionId,
      verifiedNativeSettings: saved,
      ...override,
    }),
  ).toThrow(ArgvRefusalError);
});

test("verified Codex settings cannot select another harness", () => {
  expect(() =>
    buildSpawnArgv(museCode, {
      prompt: "EXACT_INPUT",
      resume: saved.sessionId,
      verifiedNativeSettings: saved,
    }),
  ).toThrow(ArgvRefusalError);
});

test("ordinary custom model admission does not acquire the verified source exception", () => {
  expect(() =>
    buildSpawnArgv(codexCli, {
      prompt: "EXACT_INPUT",
      resume: saved.sessionId,
      model: saved.model,
    }),
  ).toThrow(/unknown.*model/);
});
