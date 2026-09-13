import { realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";

async function collect(stream: AsyncIterable<string | Uint8Array>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("an inherited terminal child has verifiable process provenance until owned shutdown", async () => {
  const deps = nodeRunnerDeps();
  const child = deps.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    output: "inherit",
    stdin: "inherit",
  });
  try {
    const started = await child.started;
    expect(started?.kind).toBe("started");
    if (started?.kind !== "started") throw new Error("No started provenance");
    expect(started.owner).toMatchObject({ executable: realpathSync(process.execPath) });
    expect(started.owner?.pid).toBeGreaterThan(0);
    expect(started.owner?.pid).not.toBe(process.pid);
    expect(started.owner?.startedAt).toMatch(/^[\da-f-]+:\d+$/);
    expect(await collect(child.stdout)).toEqual([]);
    expect(await collect(child.stderr)).toEqual([]);
  } finally {
    deps.signal(child, "SIGTERM");
    await child.exited;
    child.disposeOutput();
  }
});

test("an OS no-child error is distinct from a native process exit code", async () => {
  const deps = nodeRunnerDeps();
  const child = deps.spawn([join(import.meta.dirname, "missing-native-executable")], {
    output: "inherit",
    stdin: "inherit",
  });
  try {
    expect(await child.started).toEqual({ code: "ENOENT", kind: "not-started" });
    expect(await child.exited).toBe(127);
  } finally {
    child.disposeOutput();
  }
});
