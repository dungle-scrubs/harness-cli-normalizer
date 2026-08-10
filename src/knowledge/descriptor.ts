/**
 * Descriptor types: the shape of what is KNOWN about a harness CLI, as pure
 * data. Interpretation functions consume these; nothing here executes.
 */

export type HarnessName = "claude" | "codex" | "pi" | "muse";

export interface HarnessDescriptor {
  readonly name: HarnessName;
  readonly bin: string;
  /** Headless one-turn launch shape. `promptStyle: "positional"` means the
   * prompt travels as a bare argv entry (ordering constraints apply). */
  readonly launch: {
    readonly baseFlags: readonly string[];
    readonly promptStyle: "positional";
    readonly toolsFlag: string | null;
  };
}

export const descriptors: Partial<Record<HarnessName, HarnessDescriptor>> = {};
