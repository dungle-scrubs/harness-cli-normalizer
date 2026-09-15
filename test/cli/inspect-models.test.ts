import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { dispatch } from "../../src/cli/index.js";

// Helper to capture stdout/stderr and exitCode for dispatch (mirrors inspect-capabilities.test.ts)
const captureDispatch = async (
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    stderr += String(chunk);
    return true;
  };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const originalExit = process.exit;
  let exited: number | undefined;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exited = code;
    process.exitCode = code;
    throw new Error(`process.exit:${code}`);
  }) as unknown as typeof process.exit;
  let caught: unknown;
  try {
    await dispatch(argv);
  } catch (err) {
    caught = err;
    if (!(err instanceof Error && err.message.startsWith("process.exit:"))) throw err;
  }
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  process.exit = originalExit;
  const rawCode = exited ?? process.exitCode;
  const code = rawCode === 0 ? undefined : rawCode;
  process.exitCode = prevExit;
  if (caught && !(caught instanceof Error && caught.message.startsWith("process.exit:")))
    throw caught;
  return { stdout, stderr, exitCode: code };
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

const writeStores = (custom: unknown, builtin: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "hcn-inspect-models-"));
  dirs.push(dir);
  if (custom !== undefined) writeFileSync(join(dir, "models.json"), JSON.stringify(custom));
  if (builtin !== undefined) writeFileSync(join(dir, "models-store.json"), JSON.stringify(builtin));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
};

describe("hcn inspect pi --models --json", () => {
  test("live registry fixture carries 23 pairs from both stores", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const line = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-installed-models.ndjson"),
      "utf8",
    ).trim();
    const parsed = JSON.parse(line) as {
      v: number;
      source: string;
      models: { provider: string; model: string }[];
      skipped: string[];
    };
    // Captured 2026-09-15 from the live stores; the count pins the shape,
    // not the person's registry - a registry edit re-captures this file.
    expect(parsed.v).toBe(1);
    expect(parsed.source).toBe("stores");
    expect(parsed.skipped).toEqual([]);
    expect(parsed.models).toHaveLength(23);
    expect(parsed.models).toContainEqual({ provider: "lmstudio", model: "qwen3.6-35b-a3b-ud-mlx" });
    expect(parsed.models).toContainEqual({ provider: "zai", model: "glm-5.3" });
    expect(parsed.models).toContainEqual({ provider: "openai-codex", model: "gpt-5.6-sol" });
  });

  test("both stores project to one JSON line of pairs", async () => {
    writeStores(
      { providers: { lmstudio: { models: [{ id: "qwen3.6-35b-a3b-ud-mlx" }] } } },
      { zai: { models: [{ id: "glm-5.2" }] } },
    );
    const out = await captureDispatch(["inspect", "pi", "--models", "--json"]);
    expect(out.exitCode).toBeUndefined();
    const lines = out.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      v: 1,
      source: "stores",
      models: [
        { provider: "lmstudio", model: "qwen3.6-35b-a3b-ud-mlx" },
        { provider: "zai", model: "glm-5.2" },
      ],
      skipped: [],
    });
  });

  test("missing stores yield unavailable with both skipped", async () => {
    writeStores(undefined, undefined);
    const out = await captureDispatch(["inspect", "pi", "--models", "--json"]);
    expect(out.exitCode).toBeUndefined();
    expect(JSON.parse(out.stdout.trim())).toEqual({
      v: 1,
      source: "unavailable",
      models: [],
      skipped: ["models.json", "models-store.json"],
    });
  });

  test("one readable store still serves with the other skipped", async () => {
    writeStores({ providers: { lmstudio: { models: [{ id: "m" }] } } }, undefined);
    const out = await captureDispatch(["inspect", "pi", "--models", "--json"]);
    expect(JSON.parse(out.stdout.trim())).toEqual({
      v: 1,
      source: "stores",
      models: [{ provider: "lmstudio", model: "m" }],
      skipped: ["models-store.json"],
    });
  });

  test("a malformed store is skipped, never partial without its source field", async () => {
    const dir = writeStores(
      { providers: { lmstudio: { models: [{ id: "m" }] } } },
      { zai: { models: [{ id: "g" }] } },
    );
    writeFileSync(join(dir, "models-store.json"), "{not json");
    const out = await captureDispatch(["inspect", "pi", "--models", "--json"]);
    expect(JSON.parse(out.stdout.trim())).toEqual({
      v: 1,
      source: "stores",
      models: [{ provider: "lmstudio", model: "m" }],
      skipped: ["models-store.json"],
    });
  });

  test("credentials never enter the output", async () => {
    writeStores(
      {
        providers: {
          lmstudio: { apiKey: "lmstudio", models: [{ id: "m", apiKey: "secret" }] },
        },
      },
      null,
    );
    const out = await captureDispatch(["inspect", "pi", "--models", "--json"]);
    expect(out.stdout).not.toContain("secret");
    expect(JSON.parse(out.stdout.trim()).models).toEqual([{ provider: "lmstudio", model: "m" }]);
  });

  test("non-pi harnesses refuse", async () => {
    const out = await captureDispatch(["inspect", "claude", "--models", "--json"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--models is supported for pi only");
    const failureLine = out.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("{"));
    expect(failureLine).toBeDefined();
    expect((JSON.parse(failureLine!) as { issue?: unknown }).issue).toBe("invalid-option-value");
  });

  test("--models is mutually exclusive with other modes", async () => {
    const out = await captureDispatch(["inspect", "pi", "--models", "--capabilities", "--json"]);
    expect(out.exitCode).toBe(2);
  });
});
