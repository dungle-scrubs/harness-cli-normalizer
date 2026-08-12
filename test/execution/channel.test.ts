import { describe, expect, test } from "vitest";
import { AsyncChannel } from "../../src/execution/channel.js";

const settlesWithinMicrotask = async (promise: Promise<void>): Promise<boolean> => {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  return settled;
};

describe("AsyncChannel backpressure", () => {
  test("close releases a producer blocked above the high-water mark", async () => {
    const channel = new AsyncChannel<number>(2, 1);
    await channel.push(1);
    await channel.push(2);
    const blocked = channel.push(3);

    expect(await settlesWithinMicrotask(blocked)).toBe(false);
    channel.close();
    await expect(blocked).resolves.toBeUndefined();
  });

  test("push after close resolves without storing or delivering the item", async () => {
    const channel = new AsyncChannel<number>();
    channel.close();

    await expect(channel.push(1)).resolves.toBeUndefined();
    const received: number[] = [];
    for await (const item of channel) received.push(item);
    expect(received).toEqual([]);
  });

  test("draining below low water releases producers and a second consumer is refused", async () => {
    const channel = new AsyncChannel<number>(2, 2);
    await channel.push(1);
    await channel.push(2);
    const blocked = channel.push(3);
    const consumer = channel[Symbol.asyncIterator]();

    await expect(consumer.next()).resolves.toMatchObject({ value: 1, done: false });
    expect(await settlesWithinMicrotask(blocked)).toBe(false);
    await expect(consumer.next()).resolves.toMatchObject({ value: 2, done: false });
    await expect(blocked).resolves.toBeUndefined();

    const second = channel[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow("AsyncChannel is single-consumer");
    channel.close();
    await consumer.return?.();
  });

  test("terminal release stops backpressure without closing buffered delivery", async () => {
    const channel = new AsyncChannel<number>(1, 1);
    await channel.push(1);
    const blocked = channel.push(2);

    channel.releaseBackpressure();
    await expect(blocked).resolves.toBeUndefined();
    await expect(channel.push(3)).resolves.toBeUndefined();
    channel.close();

    const received: number[] = [];
    for await (const item of channel) received.push(item);
    expect(received).toEqual([1, 2, 3]);
  });
});
