import { expect, test } from "vitest";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";

async function within(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("real adapter output disposal settles stderr while its process is still alive", async () => {
  const deps = nodeRunnerDeps();
  const child = deps.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdin: "pipe",
  });
  try {
    const drained = (async () => {
      for await (const _ of child.stderr) {
        /* Drain until disposed. */
      }
    })();
    child.disposeOutput();
    expect(await within(drained)).toBe(true);
  } finally {
    deps.signal(child, "SIGKILL");
    await child.exited;
  }
});

test("real adapter catches asynchronous EPIPE and reports its input error", async () => {
  const deps = nodeRunnerDeps();
  const child = deps.spawn(
    [
      "node",
      "-e",
      "require('node:fs').closeSync(0); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ],
    { stdin: "pipe" },
  );
  const reader = child.stdout[Symbol.asyncIterator]();
  try {
    await reader.next();
    child.stdin?.write("x".repeat(128_000));
    expect(child.inputError).toBeDefined();
    expect(await within(child.inputError ?? Promise.resolve())).toBe(true);
  } finally {
    deps.signal(child, "SIGKILL");
    child.disposeOutput();
    await child.exited;
    await reader.return?.();
  }
});
