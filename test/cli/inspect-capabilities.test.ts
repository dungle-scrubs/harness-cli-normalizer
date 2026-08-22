import { describe, expect, test } from "vitest";
import { dispatch } from "../../src/cli/index.js";
import { resolveHarness } from "../../src/cli/resolve-harness.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";

// Helper to capture stdout/stderr and exitCode for dispatch (mirrors cli.test.ts)
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
  // Bun's process.exitCode = undefined does not clear, so set to 0 explicitly
  process.exitCode = 0;
  // Mock process.exit to not actually exit
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

describe("hcn inspect --capabilities", () => {
  test("bare --capabilities prints one JSON line matching capabilitiesOf for the default model and headless-turn", async () => {
    const out = await captureDispatch(["inspect", "claude", "--capabilities"]);
    expect(out.exitCode).toBeUndefined();
    const lines = out.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual(capabilitiesOf(resolveHarness("claude"), "", "headless-turn"));
    expect(parsed.source).toBe("curated");
    expect(parsed.streaming).toBe("token");
  });

  test("--mode changes the reported streaming per mode", async () => {
    const claude = resolveHarness("claude");
    const codex = resolveHarness("codex");

    // claude: headless-turn/headless-session stream token, interactive message
    const session = await captureDispatch([
      "inspect",
      "claude",
      "--capabilities",
      "--mode",
      "headless-session",
    ]);
    expect(session.exitCode).toBeUndefined();
    const sessionParsed = JSON.parse(session.stdout.trim());
    expect(sessionParsed).toEqual(capabilitiesOf(claude, "", "headless-session"));
    expect(sessionParsed.streaming).toBe("token");

    const interactive = await captureDispatch([
      "inspect",
      "claude",
      "--capabilities",
      "--mode",
      "interactive",
    ]);
    expect(interactive.exitCode).toBeUndefined();
    const interactiveParsed = JSON.parse(interactive.stdout.trim());
    expect(interactiveParsed).toEqual(capabilitiesOf(claude, "", "interactive"));
    expect(interactiveParsed.streaming).toBe("message");
    expect(sessionParsed.streaming).not.toBe(interactiveParsed.streaming);

    // codex: headless-turn message vs headless-session none - the mode flips it
    const codexOut = await captureDispatch([
      "inspect",
      "codex",
      "--capabilities",
      "--mode",
      "headless-session",
    ]);
    const codexParsed = JSON.parse(codexOut.stdout.trim());
    expect(codexParsed).toEqual(capabilitiesOf(codex, "", "headless-session"));
    expect(codexParsed.streaming).toBe("none");
    expect(codexParsed).not.toEqual(capabilitiesOf(codex, "", "headless-turn"));
  });

  test("invalid --mode refuses exit 2 naming the three valid modes", async () => {
    const out = await captureDispatch(["inspect", "claude", "--capabilities", "--mode", "bogus"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("headless-turn");
    expect(out.stderr).toContain("headless-session");
    expect(out.stderr).toContain("interactive");
    expect(out.stderr).toMatch(/--mode|mode/i);
    expect(out.stdout).toBe("");
  });

  test("--capabilities with --argv refuses exit 2", async () => {
    const out = await captureDispatch([
      "inspect",
      "claude",
      "--capabilities",
      "--argv",
      "--prompt",
      "hi",
    ]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(/mutually exclusive/i);
    expect(out.stdout).toBe("");
  });

  test("a model outside the vocabulary degrades source to unknown", async () => {
    const out = await captureDispatch([
      "inspect",
      "claude",
      "--capabilities",
      "--model",
      "not-a-curated-model",
    ]);
    expect(out.exitCode).toBeUndefined();
    const parsed = JSON.parse(out.stdout.trim());
    expect(parsed).toEqual(
      capabilitiesOf(resolveHarness("claude"), "not-a-curated-model", "headless-turn"),
    );
    expect(parsed.source).toBe("unknown");
    expect(parsed.confidence).toBe("none");
    expect(parsed.streaming).toBe("none");
    expect(parsed.session).toBe(false);
  });

  test("a curated model keeps source curated", async () => {
    const claude = resolveHarness("claude");
    const curated = claude.vocabulary.models[0]!;
    const out = await captureDispatch(["inspect", "claude", "--capabilities", "--model", curated]);
    expect(out.exitCode).toBeUndefined();
    const parsed = JSON.parse(out.stdout.trim());
    expect(parsed).toEqual(capabilitiesOf(claude, curated, "headless-turn"));
    expect(parsed.source).toBe("curated");
  });
});
