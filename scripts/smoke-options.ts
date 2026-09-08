import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerDeps, SpawnedProcess } from "../src/execution/deps.js";
import { nodeRunnerDeps } from "../src/execution/node-deps.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";

/** Opt into one installed harness without starting the other live models. */
export function smokeHarnesses(harnesses: HarnessDescriptor[]): HarnessDescriptor[] {
  const name = process.env.SMOKE_HARNESS;
  if (name === undefined) return harnesses;
  const selected = harnesses.filter((harness) => harness.name === name);
  if (selected.length !== 1) throw new Error(`Unknown SMOKE_HARNESS: ${name}`);
  return selected;
}

export const smokeCwd = resolve(process.env.SMOKE_CWD ?? process.cwd());
let captureNumber = 0;

/** Use the runner's deadline: it stops and reaps the child before the next
 * scenario starts. A Promise.race deadline would leave that child running.
 * Optional raw recordings are real native bytes, never reconstructed events. */
export function smokeDeps(): RunnerDeps {
  const originals = new WeakMap<SpawnedProcess, SpawnedProcess>();
  const deps = nodeRunnerDeps();
  const directory = process.env.SMOKE_CAPTURE_DIR;
  return {
    ...deps,
    turnTimeoutMs: 90_000,
    signal(child, signal) {
      deps.signal(originals.get(child) ?? child, signal);
    },
    spawn(argv, options) {
      const child = deps.spawn(argv, options);
      if (!directory) return child;
      mkdirSync(directory, { recursive: true });
      const prefix = join(directory, `${String(++captureNumber).padStart(2, "0")}`);
      const record = async function* (
        stream: AsyncIterable<string | Uint8Array>,
        suffix: string,
      ): AsyncIterable<string | Uint8Array> {
        for await (const chunk of stream) {
          appendFileSync(`${prefix}.${suffix}`, chunk);
          yield chunk;
        }
      };
      const recorded = {
        ...child,
        stderr: record(child.stderr, "stderr.txt"),
        stdout: record(child.stdout, "ndjson"),
      };
      originals.set(recorded, child);
      return recorded;
    },
  };
}
