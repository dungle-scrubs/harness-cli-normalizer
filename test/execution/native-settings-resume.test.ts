import { expect, test } from "vitest";
import { planTurn } from "../../src/cli/plan-turn.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import type { NativeSettingsInspector } from "../../src/execution/native-settings.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { NativeSettingsSnapshot } from "../../src/knowledge/native-settings.js";
import { FakeClock, fakeSignal } from "./fakes.js";

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

test("changed native settings refuse at the final runner boundary before any spawn", async () => {
  let current = saved;
  const inspectNativeSettings = () => current;
  const prepared = await planTurn(
    codexCli,
    [
      "--resume",
      saved.sessionId,
      "--cwd",
      saved.cwd,
      "--native-settings-fingerprint",
      saved.fingerprint,
      "--prompt",
      "EXACT_INPUT",
      "--questions",
      "none",
    ],
    { command: "run" },
    {
      inspectNativeSettings,
      loadUserConfig: () => null,
      loadProjectConfig: () => null,
      listKnownSkills: () => [],
      resolveSkillNames: () => [],
      readPrompt: async () => ({ prompt: "EXACT_INPUT", source: "prompt-flag" }),
    },
  );
  expect(prepared.kind).toBe("plan");
  if (prepared.kind !== "plan") throw new Error("Expected a prepared native resume");
  expect(prepared.plan.argv).toContain(saved.model);
  current = { ...saved, fingerprint: "b".repeat(64) };
  let spawnCalls = 0;
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(codexCli, prepared.plan.options, {
    spawn: () => {
      spawnCalls++;
      throw new Error("Must not spawn");
    },
    signal: fakeSignal().signal,
    clock: new FakeClock(),
    inspectNativeSettings,
  }))
    events.push(event);
  expect(spawnCalls).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "failure",
      class: "rejected",
      issue: "native-settings-changed",
    }),
  );
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed", exitCode: null });
});

test.each<{ name: string; inspect?: NativeSettingsInspector }>([
  { name: "no inspector" },
  {
    name: "incomplete source",
    inspect: () => ({ harness: "codex", status: "unavailable", reason: "source-incomplete", v: 1 }),
  },
  {
    name: "mismatched target",
    inspect: () => ({ ...saved, sessionId: "507feafe-e82b-4df4-91ba-4f1aeb987508" }),
  },
  {
    name: "failed source read",
    inspect: () => {
      throw new Error("DO_NOT_RETURN_SOURCE_ERROR_DETAILS");
    },
  },
])("$name refuses without a native spawn", async ({ inspect }) => {
  let spawnCalls = 0;
  const events: HarnessEvent[] = [];
  for await (const event of streamTurn(
    codexCli,
    {
      prompt: "EXACT_INPUT",
      questions: "none",
      cwd: saved.cwd,
      resume: saved.sessionId,
      nativeSettingsFingerprint: saved.fingerprint,
    },
    {
      spawn: () => {
        spawnCalls++;
        throw new Error("Must not spawn");
      },
      signal: fakeSignal().signal,
      clock: new FakeClock(),
      inspectNativeSettings: inspect,
    },
  ))
    events.push(event);
  expect(spawnCalls).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "failure",
      class: "rejected",
      issue: "native-settings-unavailable",
    }),
  );
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed", exitCode: null });
  expect(JSON.stringify(events)).not.toContain("DO_NOT_RETURN_SOURCE_ERROR_DETAILS");
});
