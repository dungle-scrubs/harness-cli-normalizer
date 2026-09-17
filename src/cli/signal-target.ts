import type { SignalName, SpawnedProcess } from "../execution/deps.js";

/** L6: signal forwarding for `hcn run` targets the harness child
 * explicitly. The runner spawns the harness child first and the approval
 * observer's helper later; remembering the last spawned process would
 * retarget SIGINT/SIGTERM at the helper the moment observation starts. The
 * first spawn wins, so the helper can never take the target. */
export const createHarnessSignalTarget = (
  signal: (proc: SpawnedProcess, sig: SignalName) => void,
): {
  readonly forward: (sig: SignalName) => void;
  readonly noteSpawn: (proc: SpawnedProcess) => void;
} => {
  let harness: SpawnedProcess | null = null;
  return {
    forward: (sig: SignalName): void => {
      if (harness !== null) signal(harness, sig);
    },
    noteSpawn: (proc: SpawnedProcess): void => {
      harness ??= proc;
    },
  };
};
