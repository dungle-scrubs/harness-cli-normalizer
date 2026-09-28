import { describe, expect, test } from "vitest";
import type { RunnerDeps } from "../../src/execution/deps.js";
import { probeExtensionOption } from "../../src/execution/extension-probe.js";
import type { OptionProbe } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

/**
 * Map #300, ticket #307: the runtime probe for an extension-registered
 * option. Evidence base is ticket #301 - `--help` carrying the exact flag
 * spelling, whitespace-normalized so a wrapped help line still matches.
 * The probe must forward the caller's env and cwd (extensions follow
 * PI_CODING_AGENT_DIR) and bound itself.
 */

const PROBE: OptionProbe = {
  argv: ["--help"],
  contains: "--agent <value>",
  providedBy: "subagent extension",
};

const depsFor = (
  proc: FakeProcess,
  signal = fakeSignal(),
): { deps: RunnerDeps; calls: ReturnType<typeof fakeSpawner>["calls"] } => {
  const spawner = fakeSpawner([proc]);
  return {
    deps: { spawn: spawner.spawn, signal: signal.signal, clock: new FakeClock(), log: () => {} },
    calls: spawner.calls,
  };
};

describe("probeExtensionOption", () => {
  test("flag present: ok, and the spawn carries the caller's env and cwd", async () => {
    const proc = new FakeProcess();
    proc.emitLine("Usage: pi [options]");
    proc.emitLine("  --agent <value>             Start as a named user agent");
    proc.exit(0);
    const { deps, calls } = depsFor(proc);
    const outcome = await probeExtensionOption(
      piCli,
      PROBE,
      { cwd: "/tmp/w", env: { PI_CODING_AGENT_DIR: "/tmp/pihome" } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("flag-present");
    expect(outcome.providedBy).toBe("subagent extension");
    expect(calls[0]?.argv).toEqual(["pi", "--help"]);
    expect(calls[0]?.opts.cwd).toBe("/tmp/w");
    expect(calls[0]?.opts.env?.PI_CODING_AGENT_DIR).toBe("/tmp/pihome");
    expect(calls[0]?.opts.stdin).toBe("close");
  });

  test("a token split across a wrapped help line still matches (whitespace-normalized)", async () => {
    const proc = new FakeProcess();
    proc.emitChunk("  --agent\n      <value>   Start as a named user agent\n");
    proc.exit(0);
    const { deps } = depsFor(proc);
    const outcome = await probeExtensionOption(piCli, PROBE, {}, deps);
    expect(outcome.reason).toBe("flag-present");
  });

  test("flag absent: not ok, flag-absent, exit code carried", async () => {
    const proc = new FakeProcess();
    proc.emitLine("Usage: pi [options]");
    proc.exit(0);
    const { deps } = depsFor(proc);
    const outcome = await probeExtensionOption(piCli, PROBE, {}, deps);
    expect(outcome).toMatchObject({ ok: false, reason: "flag-absent", exitCode: 0 });
  });

  test("nonzero probe exit: spawn-failed, never reported as absent", async () => {
    const proc = new FakeProcess();
    proc.emitStderr("node: bad thing");
    proc.exit(1);
    const { deps } = depsFor(proc);
    const outcome = await probeExtensionOption(piCli, PROBE, {}, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("spawn-failed");
    expect(outcome.startupError).toContain("exit 1");
  });

  test("a probe that never started: spawn-failed with the adapter message", async () => {
    const proc = new FakeProcess();
    proc.exit(1);
    const wrapped = Object.create(proc) as FakeProcess & {
      startupError: () => string;
    };
    wrapped.startupError = () => "spawn ENOENT";
    const { deps } = depsFor(wrapped);
    const outcome = await probeExtensionOption(piCli, PROBE, {}, deps);
    expect(outcome).toMatchObject({
      ok: false,
      reason: "spawn-failed",
      startupError: "spawn ENOENT",
    });
  });

  test("a wedged probe: SIGTERM after the bound, reason timeout", async () => {
    const proc = new FakeProcess();
    const signal = fakeSignal({ autoExit: true });
    const { deps } = depsFor(proc, signal);
    const outcome = await probeExtensionOption(piCli, PROBE, { timeoutMs: 20 }, deps);
    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
    expect(signal.sent).toHaveLength(1);
    expect(signal.sent[0]?.sig).toBe("SIGTERM");
  });
});
