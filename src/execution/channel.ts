/**
 * A single-consumer async channel with producer backpressure: push from
 * producers (await the returned promise - past the high water mark it
 * blocks until the consumer drains below low water, so OS pipe
 * backpressure can reach a child process), iterate from EXACTLY ONE
 * consumer, close to end iteration. A second concurrent iterator would
 * overwrite the consumer wake and strand the first - it throws instead.
 * push after close is a silent no-op by contract (the closer decided the
 * stream is over; racing producers must not crash).
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private head = 0;
  private closed = false;
  private wake: (() => void) | null = null;
  private producerWaiters: Array<() => void> = [];
  private consuming = false;
  private backpressureEnabled = true;

  constructor(
    private readonly highWater = 1024,
    private readonly lowWater = 256,
  ) {}

  private get size(): number {
    return this.items.length - this.head;
  }

  push(item: T): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.items.push(item);
    this.wake?.();
    if (this.backpressureEnabled && this.size > this.highWater) {
      return new Promise((resolve) => this.producerWaiters.push(resolve));
    }
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.releaseProducers();
  }

  /** Stop blocking producers without closing delivery. This is a terminal
   * process state: the child has exited and output reads are being disposed,
   * so only already-buffered pipe data can still be added. */
  releaseBackpressure(): void {
    this.backpressureEnabled = false;
    this.releaseProducers();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private releaseProducers(): void {
    const waiters = this.producerWaiters;
    this.producerWaiters = [];
    for (const release of waiters) release();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consuming) {
      throw new Error("AsyncChannel is single-consumer; a second iterator would strand the first");
    }
    this.consuming = true;
    while (true) {
      if (this.size > 0) {
        const item = this.items[this.head++];
        if (this.head === this.items.length) {
          this.items = [];
          this.head = 0;
        }
        if (this.size < this.lowWater) this.releaseProducers();
        if (item !== undefined) yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
