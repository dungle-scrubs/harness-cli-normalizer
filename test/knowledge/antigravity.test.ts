import { describe, expect, test } from "vitest";
import {
  buildLaunchArgv,
  buildResumeArgv,
  buildSessionArgv,
  buildSpawnArgv,
} from "../../src/interpretation/argv.js";
import { decodeIdentity } from "../../src/interpretation/identity.js";
import { parseResumeCommand } from "../../src/interpretation/parse-resume.js";
import { storePath } from "../../src/interpretation/store.js";
import { validateEffort, validateModel } from "../../src/interpretation/vocabulary.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";

const id = "c3b4fe40-7c75-4f22-b863-51061aa8b20b";

describe("Antigravity descriptor", () => {
  test("renders the print prompt before stream-json flags", () => {
    expect(buildLaunchArgv(antigravityCli, { prompt: "hello" })).toEqual([
      "agy",
      "--print",
      "hello",
      "--output-format",
      "stream-json",
    ]);
  });

  test("renders named and most-recent resume grammars", () => {
    expect(
      buildResumeArgv(antigravityCli, {
        sessionId: id,
        prompt: "continue",
        effort: "high",
        sandbox: "workspace-write",
      }),
    ).toEqual([
      "agy",
      "--conversation",
      id,
      "--print",
      "continue",
      "--output-format",
      "stream-json",
      "--effort",
      "high",
      "--sandbox",
    ]);
    expect(
      buildSpawnArgv(antigravityCli, {
        prompt: "continue",
        resumeLast: true,
        effort: "high",
        sandbox: "workspace-write",
      }),
    ).toEqual([
      "agy",
      "--continue",
      "--print",
      "continue",
      "--output-format",
      "stream-json",
      "--effort",
      "high",
      "--sandbox",
    ]);
    expect(parseResumeCommand([antigravityCli], `agy --conversation ${id}`)).toEqual({
      harness: "antigravity",
      sessionId: id,
      autonomy: false,
    });
  });

  test("closes one-shot stdin so missing authentication cannot wait for OAuth input", () => {
    expect(antigravityCli.stdin).toBe("close-required");
  });

  test("renders fresh and resumed persistent sessions", () => {
    expect(buildSessionArgv(antigravityCli, { sessionId: id })).toEqual([
      "agy",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ]);
    expect(buildSessionArgv(antigravityCli, { sessionId: id, isResume: true })).toEqual([
      "agy",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--conversation",
      id,
    ]);
  });

  test("renders model, effort, sandbox, and autonomy through shared options", () => {
    expect(
      buildLaunchArgv(antigravityCli, {
        prompt: "hello",
        model: "custom-model",
        effort: "high",
        sandbox: "workspace-write",
        autonomy: true,
      }),
    ).toEqual([
      "agy",
      "--print",
      "hello",
      "--output-format",
      "stream-json",
      "--model",
      "custom-model",
      "--dangerously-skip-permissions",
      "--effort",
      "high",
      "--sandbox",
    ]);
    expect(validateModel(antigravityCli, "configured/custom-model").ok).toBe(true);
    expect(validateModel(antigravityCli, "--bad").ok).toBe(false);
    expect(validateEffort(antigravityCli, "high", "custom-model").ok).toBe(true);
    expect(validateEffort(antigravityCli, "xhigh", "custom-model").ok).toBe(false);
  });

  test("decodes init identity and resolves the documented brain transcript path", () => {
    expect(
      decodeIdentity(antigravityCli, { event: "init", conversation_id: id }, null),
    ).toMatchObject({ sessionId: id, identity: id, outcome: "announced" });
    expect(storePath(antigravityCli, { home: "/home/user", cwd: "/work", sessionId: id })).toBe(
      `/home/user/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`,
    );
  });
});
