import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { AsyncChannel } from "../../src/execution/channel.js";
import { disposableOutputStream, nodeRunnerDeps } from "../../src/execution/node-deps.js";
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
  test("adapter suppresses only its own disposal rejection", async () => {
    const disposalCause = new Error("adapter output disposal");
    const unrelatedCause = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    const disposalSource = new Readable({ read: () => {} });
    const disposed = disposableOutputStream(
      disposalSource,
      disposalCause,
      Promise.resolve("spawned"),
    );
    const disposedRead = disposed.stream[Symbol.asyncIterator]().next();
    disposed.dispose();
    await expect(disposedRead).resolves.toMatchObject({ done: true });

    const unrelatedSource = new Readable({ read: () => {} });
    const unrelated = disposableOutputStream(
      unrelatedSource,
      disposalCause,
      Promise.resolve("spawned"),
    );
    const unrelatedRead = unrelated.stream[Symbol.asyncIterator]().next();
    unrelatedSource.destroy(unrelatedCause);
    unrelated.dispose();
    await expect(unrelatedRead).rejects.toBe(unrelatedCause);
  });

  test("adapter drains runtime-buffered chunks before settling output disposal", async () => {
    const source = new Readable({ read: () => {} });
    const output = disposableOutputStream(
      source,
      new Error("adapter output disposal"),
      Promise.resolve("spawned"),
    );
    const iterator = output.stream[Symbol.asyncIterator]();
    source.push(Buffer.from("one"));
    expect(Buffer.from((await iterator.next()).value as Uint8Array).toString()).toBe("one");
    source.push(Buffer.from("two"));
    source.push(Buffer.from("three"));

    output.dispose();

    const buffered = await iterator.next();
    expect(Buffer.from(buffered.value).toString()).toBe("twothree");
    source.push(Buffer.from("written-after-disposal"));
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

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
    proc.emitChunk("written after disposal");

    await expect(pendingRead).resolves.toMatchObject({ done: true });
    await expect(stdout.next()).resolves.toMatchObject({ done: true });
    expect(proc.outputDisposed).toBe(true);
    expect(proc.outputDisposalCount).toBe(1);
  });

  test("the Node/Bun adapter settles descendant-held stdout and stderr reads", async () => {
    const directChildSource = String.raw`
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30000)"], {
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
      const first = await settleWithin(stdout.next(), 5_000);
      expect(first.done).toBe(false);
      ({ descendantPid } = JSON.parse(Buffer.from(first.value as Uint8Array).toString("utf8")) as {
        descendantPid: number;
      });
      const exitCode = await proc.exited;
      if (exitCode !== 7) throw new Error(`expected direct child exit 7, got ${exitCode}`);
      const heldReads = [stdout.next(), stderr.next()];

      proc.disposeOutput();
      proc.disposeOutput();

      settlements = await settleWithin(Promise.allSettled(heldReads), 5_000);
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
