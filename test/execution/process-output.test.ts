import { describe, expect, test } from "vitest";
import { AsyncChannel } from "../../src/execution/channel.js";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";
import { FakeProcess } from "./fakes.js";

const settleWithin = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`settlement exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

describe("injected process output disposal", () => {
  test("queue close alone leaves a held output read pending; fake disposal settles it idempotently", async () => {
    const proc = new FakeProcess();
    const queue = new AsyncChannel<unknown>();
    const stdout = proc.stdout[Symbol.asyncIterator]();
    const pendingRead = stdout.next();
    let readSettled = false;
    void pendingRead.then(() => {
      readSettled = true;
    });

    proc.exitWithoutClosing(0);
    queue.close();
    await Promise.resolve();
    expect(readSettled).toBe(false);

    proc.disposeOutput();
    proc.disposeOutput();

    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(proc.outputDisposed).toBe(true);
    expect(proc.outputDisposalCount).toBe(1);
  });

  test("the Node/Bun adapter settles descendant-held stdout and stderr reads", async () => {
    const directChildSource = String.raw`
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 2000)"], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      descendant.unref();
      process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
      process.exit(7);
    `;
    const proc = nodeRunnerDeps().spawn([process.execPath, "-e", directChildSource], {
      stdin: "close",
    });
    let descendantPid: number | undefined;
    let cleanupError: unknown;
    let settlements: PromiseSettledResult<IteratorResult<string | Uint8Array>>[] = [];
    try {
      const stdout = proc.stdout[Symbol.asyncIterator]();
      const stderr = proc.stderr[Symbol.asyncIterator]();
      const first = await settleWithin(stdout.next(), 1_000);
      expect(first.done).toBe(false);
      ({ descendantPid } = JSON.parse(Buffer.from(first.value as Uint8Array).toString("utf8")) as {
        descendantPid: number;
      });
      const exitCode = await proc.exited;
      if (exitCode !== 7) throw new Error(`expected direct child exit 7, got ${exitCode}`);
      const heldReads = [stdout.next(), stderr.next()];

      proc.disposeOutput();
      proc.disposeOutput();

      settlements = await settleWithin(Promise.allSettled(heldReads), 1_000);
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
        }
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    expect(settlements).toHaveLength(2);
    expect(settlements.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
