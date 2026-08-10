/**
 * A minimal single-consumer async channel: push from producers, iterate
 * from exactly one consumer, close to end iteration. The building block
 * for session turn routing (the runner's EventQueue adds backpressure on
 * top of the same shape).
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private head = 0;
  private closed = false;
  private wake: (() => void) | null = null;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length > this.head) {
        const item = this.items[this.head++];
        if (this.head === this.items.length) {
          this.items = [];
          this.head = 0;
        }
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
