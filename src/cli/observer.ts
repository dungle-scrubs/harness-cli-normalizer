/**
 * The run lifecycle observer (ADR 0011): when `HCN_OBSERVER` names an
 * absolute path, `hcn run` streams lifecycle records to that command as
 * `hcn-observer/1` NDJSON on its stdin - one `started` line, one line per
 * run event, and the terminal outcome. hcn has no knowledge of envelopes,
 * outboxes, authorities or gates; the observer command owns whatever
 * happens next, and the reflection intake ships one such observer.
 *
 * Delivery is fire-and-forget by contract: the observer never blocks the
 * run, never logs, never retries, and never changes an exit code. A
 * missing, unusable or failing observer leaves the run byte for byte as
 * if the variable were unset. Enablement is decided from the variable's
 * string value alone - no filesystem work happens on this path; a failed
 * spawn surfaces as an asynchronous error that ends observation silently.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { SpawnOptions } from "../execution/deps.js";
import type { HarnessEvent } from "../execution/events.js";
import { DROPPABLE_KINDS } from "../execution/events.js";
import { getVersion } from "./version.js";

export const OBSERVER_ENV = "HCN_OBSERVER";
export const INVOCATION_ID_ENV = "HCN_INVOCATION_ID";

/** Backstop for a reader that stops draining: past this much queued and
 * unwritten, the pipe is destroyed and observation ends silently. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** A single record whose serialized form exceeds this is replaced by a
 * short `skipped` record, so one huge event cannot monopolize the pipe. */
const MAX_RECORD_CHARS = 1024 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

/** The observer command from the environment, or null when no observer is
 * enabled. Decided from the string alone: the variable must be non-empty
 * and absolute. No filesystem work happens here - a path that does not
 * name a spawnable file fails later, asynchronously, and silently. */
export const observerCommand = (env: Env): string | null => {
  const value = env[OBSERVER_ENV];
  if (value === undefined || value === "") return null;
  const absolute = resolve(value);
  return absolute === value ? absolute : null;
};

export interface RunObserver {
  readonly enabled: boolean;
  /** Adds `HCN_INVOCATION_ID` over the caller's env on the launch spawn;
   * returns the options untouched when no observer is enabled. Call on
   * the first harness spawn only - later spawns (the approval helper)
   * carry none of this. */
  harnessEnv(opts: SpawnOptions, invocationId: string): SpawnOptions;
  /** Spawns the observer command and writes the `started` record. Call
   * in a `finally` so a harness spawn that throws is still covered.
   * Never throws. */
  launched(invocationId: string, at: string): void;
  /** Streams one run event, unless it is droppable or observation has
   * ended. A `done` event ends the stream. Fire-and-forget; never
   * throws. */
  event(event: HarnessEvent): void;
  /** Ends the stream. Idempotent; never throws. */
  end(): void;
}

const disabled = (): RunObserver => ({
  enabled: false,
  harnessEnv: (opts) => opts,
  launched: () => {},
  event: () => {},
  end: () => {},
});

/** The run observer for one `hcn run` invocation. Inert unless
 * `HCN_OBSERVER` enables it. */
export const createRunObserver = (harness: string, cwd: string | undefined): RunObserver => {
  const command = observerCommand(process.env);
  if (command === null) return disabled();

  let invocationId: string | null = null;
  let child: ChildProcess | null = null;
  let failed = false;
  let ended = false;

  const fail = (): void => {
    failed = true;
    try {
      child?.stdin?.destroy();
    } catch {}
  };

  /** Checks the pending-bytes cap BEFORE serializing, then serializes the
   * record. A record over 1 MiB serialized characters is replaced by a
   * short `skipped` record, so one huge event cannot monopolize the pipe
   * and the consumer learns where coverage ends. */
  const write = (makeRecord: () => Record<string, unknown>): void => {
    if (failed || ended || child === null) return;
    const stdin = child.stdin;
    if (stdin === null || (stdin.writableLength ?? 0) > MAX_PENDING_BYTES) {
      fail();
      return;
    }
    const text = JSON.stringify(makeRecord());
    if (text.length > MAX_RECORD_CHARS) {
      stdin.write(
        `${JSON.stringify({ record: "skipped", at: new Date().toISOString(), reason: "oversize" })}\n`,
      );
      return;
    }
    stdin.write(`${text}\n`);
  };

  const endStream = (): void => {
    if (ended) return;
    ended = true;
    try {
      child?.stdin?.end();
    } catch {}
  };

  return {
    enabled: true,
    harnessEnv: (opts, id) => ({
      ...opts,
      env: { ...(opts.env ?? {}), [INVOCATION_ID_ENV]: id },
    }),
    launched: (id, at) => {
      invocationId = id;
      try {
        child = spawn(command, [], {
          // Its own session: terminal SIGINT and pane SIGHUP do not reach
          // it. stdio pipes only stdin - a caller reading hcn's stdout to
          // EOF never waits on the observer.
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
          // hcn's own environment, unchanged: this is how a parent's
          // REFLECT_INTAKE_WORK_PARENT reaches the adapter.
          env: process.env,
        });
      } catch {
        child = null;
        return;
      }
      child.unref();
      // The stdin handle unref'd too: hcn's exit must never wait on the
      // observer pipe. The node types omit unref on the stdin Writable.
      (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
      // No-op handlers: an asynchronous spawn or write failure (ENOENT,
      // EACCES, EPIPE) ends observation silently instead of crashing the
      // run.
      child.on("error", () => fail());
      child.stdin?.on("error", () => fail());
      if (child.pid === undefined) {
        fail();
        return;
      }
      write(() => ({
        record: "started",
        schema: "hcn-observer/1",
        invocationId,
        at,
        command: "run",
        harness,
        cwd: resolve(cwd ?? process.cwd()),
        hcnVersion: getVersion(),
      }));
    },
    event: (event) => {
      if (ended || failed || DROPPABLE_KINDS.has(event.kind)) return;
      write(() => ({ at: new Date().toISOString(), event, record: "event" }));
      if (event.kind === "done") endStream();
    },
    end: () => endStream(),
  };
};
