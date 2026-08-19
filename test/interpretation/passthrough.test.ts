/**
 * Phase 4 (D6): passthrough separator and native error labeling.
 * - splitPassthrough: first `--` splits normalized surface from verbatim
 *   harness tokens; no separator means empty passthrough
 * - passthrough tokens ride after the prompt tail, post `--`, never
 *   validated by hcn
 * - a wrong-harness flag after -- fails IN the harness and surfaces as a
 *   native failure: labeled message, nativeExitCode as data, done.exitCode
 *   null, hcn process exit 1 (never 2 - that is hcn's refusal code)
 * - empty passthrough after -- refuses (exit 2) - a bare separator is
 *   almost certainly a mistake
 */
import { describe, expect, it } from "vitest";
import { splitPassthrough } from "../../src/cli/args.js";
import { failureFromNative } from "../../src/execution/failure.js";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { codexCli } from "../../src/knowledge/codex.js";

describe("splitPassthrough", () => {
  it("splits at the first bare --", () => {
    const { normalized, passthrough } = splitPassthrough([
      "--prompt",
      "hi",
      "--",
      "--allowedTools",
      "Read",
    ]);
    expect(normalized).toEqual(["--prompt", "hi"]);
    expect(passthrough).toEqual(["--allowedTools", "Read"]);
  });

  it("no separator means empty passthrough", () => {
    const { normalized, passthrough } = splitPassthrough(["--prompt", "hi"]);
    expect(normalized).toEqual(["--prompt", "hi"]);
    expect(passthrough).toEqual([]);
  });

  it("only the FIRST separator splits; later -- stay in passthrough", () => {
    const { normalized, passthrough } = splitPassthrough(["a", "--", "b", "--", "c"]);
    expect(normalized).toEqual(["a"]);
    expect(passthrough).toEqual(["b", "--", "c"]);
  });

  it("a -- value bound to a flag does not split (--prompt=--x form is one token)", () => {
    const { normalized, passthrough } = splitPassthrough(["--prompt=--x", "y"]);
    expect(normalized).toEqual(["--prompt=--x", "y"]);
    expect(passthrough).toEqual([]);
  });
});

describe("failureFromNative (D6 labeling)", () => {
  it("carries class native, native exit code as data, verbatim tail in message", () => {
    const f = failureFromNative(2, ["error: unexpected argument '--allowedTools' found"]);
    expect(f.class).toBe("native");
    expect(f.retryable).toBe(false);
    expect(f.nativeExitCode).toBe(2);
    expect(f.message).toMatch(/NATIVE ERROR from harness/);
    expect(f.message).toContain("--allowedTools");
  });

  it("a null exit code is omitted, not zero", () => {
    expect(failureFromNative(null, ["boom"]).nativeExitCode).toBeUndefined();
  });
});

describe("passthrough reaches the built argv", () => {
  it("tokens append verbatim after -- at the argv tail", () => {
    const argv = [...buildLaunchArgv(codexCli, { prompt: "hi" }), "--", "--allowedTools", "Read"];
    expect(argv.indexOf("--")).toBe(argv.length - 3);
    expect(argv.slice(-2)).toEqual(["--allowedTools", "Read"]);
  });
});
