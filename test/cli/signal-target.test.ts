/**
 * L6: `hcn run` forwards SIGINT/SIGTERM to the harness child explicitly,
 * not to whatever spawned last. After the identity event the approval
 * observer spawns its helper, which must never retarget signals.
 */
import { describe, expect, test, vi } from "vitest";
import { createHarnessSignalTarget } from "../../src/cli/signal-target.js";
import type { SpawnedProcess } from "../../src/execution/deps.js";

const proc = (): SpawnedProcess =>
  ({
    exited: new Promise(() => {}),
    disposeOutput: () => {},
  }) as SpawnedProcess;

describe("createHarnessSignalTarget", () => {
  test("forwarding reaches the first spawn even after the observer spawns", () => {
    const signal = vi.fn();
    const target = createHarnessSignalTarget(signal);
    const exec = proc();
    const serve = proc();
    target.noteSpawn(exec);
    target.noteSpawn(serve);
    target.forward("SIGTERM");
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(exec, "SIGTERM");
  });

  test("forwarding before any spawn signals nothing", () => {
    const signal = vi.fn();
    const target = createHarnessSignalTarget(signal);
    target.forward("SIGTERM");
    expect(signal).not.toHaveBeenCalled();
  });
});
