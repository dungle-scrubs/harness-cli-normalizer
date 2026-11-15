/**
 * The Cursor SDK worker (issue #440): the one owned child process that
 * executes the vendor SDK, so the agent loop can always be killed by the
 * parent's supervising policies. The parent (hcn run / hcn session) speaks
 * the private NDJSON wire whose pure shapes live in
 * interpretation/cursor-sdk.ts: open/prompt/abort lines in, receipts,
 * forwarded SDK observations and one terminal turn-end record out.
 *
 * The worker stays deliberately thin. It resolves the hcn model slug
 * against the native catalog (pure interpretation), maps the access
 * restriction the parent already computed onto AgentOptions, forwards the
 * SDK observations the shared decoder consumes (token deltas once, one
 * complete assistant message per onStep - the stream's own assistant
 * records are token fragments, not messages - and tool_call / usage /
 * task records), and settles every run from Run.wait's own status, never
 * from assistant text. Everything the SDK logs goes to stderr: stdout is
 * the wire, and the console guard below is installed before the SDK is
 * imported so its own output cannot corrupt a record.
 *
 * Every teardown source - stdin EOF, SIGTERM, SIGINT, a stdout error, a
 * failed wire write - runs one idempotent finish/dispose path in main:
 * the owned run is cancelled natively and waited, the SDK agent disposed,
 * the exit code set; nothing is force-killed, and the outer supervisor's
 * grace and SIGKILL bound a finish that cannot complete.
 *
 * The SDK import is lazy and confined to main(); tests inject the sdk
 * object through createCursorSdkWorker instead. State is the SDK's own
 * native store: after a run settles, the conversation is resumable by
 * the next process (verified 1.0.38, Agent.resume recall in a fresh
 * process). When node:sqlite is unavailable the worker configures the
 * SDK's documented JSONL store under the SDK's default state root before
 * any agent call - still the SDK's store, never an hcn one.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  type CursorSdkModelCatalog,
  type CursorSdkRunStatus,
  cursorSdkErrorKindOf,
  encodeCursorSdkAbortReceipt,
  encodeCursorSdkEvent,
  encodeCursorSdkOpened,
  encodeCursorSdkOpenFailed,
  encodeCursorSdkReceipt,
  encodeCursorSdkSendCancelled,
  encodeCursorSdkSendFailed,
  encodeCursorSdkTurnEnd,
  resolveCursorSdkModel,
} from "../interpretation/cursor-sdk.js";

/** The structural SDK surface the worker uses - the real module satisfies
 * it, tests can fake it whole. */
export interface CursorSdkModule {
  readonly Agent: {
    readonly create: (options: Record<string, unknown>) => Promise<CursorSdkAgentHandle>;
    readonly resume: (
      agentId: string,
      options: Record<string, unknown>,
    ) => Promise<CursorSdkAgentHandle>;
  };
  readonly Cursor: {
    readonly models: { readonly list: () => Promise<CursorSdkModelCatalog> };
    readonly configure: (options: Record<string, unknown>) => void;
  };
  readonly JsonlLocalAgentStore?: new (directory: string) => unknown;
  readonly getDefaultSdkStateRoot?: () => string;
}

export interface CursorSdkRunHandle {
  readonly stream?: () => AsyncIterable<Record<string, unknown>>;
  readonly wait: () => Promise<{
    readonly status: CursorSdkRunStatus;
    readonly error?: { readonly message?: string; readonly code?: string };
  }>;
  readonly cancel: () => Promise<void>;
}

export interface CursorSdkAgentHandle {
  readonly agentId: string;
  readonly send: (
    message: string,
    options?: {
      readonly onDelta?: (args: {
        readonly update: Record<string, unknown>;
      }) => void | Promise<void>;
      readonly onStep?: (args: { readonly step: Record<string, unknown> }) => void | Promise<void>;
    },
  ) => Promise<CursorSdkRunHandle>;
  readonly close?: () => void;
  readonly [Symbol.asyncDispose]?: () => Promise<void>;
}

/** One parsed open line. */
export interface CursorSdkOpenRequest {
  readonly id: string;
  readonly resume?: string;
  readonly model?: string;
  /** The caller's explicit effort word, when one was given: resolved
   * against the catalog with the model, so a tier the CLI grammar folds
   * onto the bare slug still pins its native parameter. */
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly sandbox?: boolean;
}

export interface CursorSdkWorker {
  open(request: CursorSdkOpenRequest): Promise<void>;
  prompt(id: string, message: string): void;
  abort(id: string): void;
  dispose(): Promise<void>;
  /** Whether the agent failed to open - the startup-failure exit code. */
  failed(): boolean;
}

/** Best-effort stderr write: diagnostics must never take the worker
 * down, not even when stderr itself is a dead pipe (the parent
 * vanished). The stream's asynchronous EPIPE is absorbed by the
 * harmless error listener main attaches before anything can write; a
 * synchronous throw from write is swallowed here. A stderr failure is
 * never written back to stderr - that is the crash loop this guard
 * exists to break. */
const writeStderrBestEffort = (text: string): void => {
  try {
    process.stderr.write(text);
  } catch {
    // A dead sink stays dead; cleanup continues.
  }
};

const stderrLine = (text: string): void => {
  writeStderrBestEffort(`${text}\n`);
};

const isErrorWithMessage = (value: unknown): value is { message?: unknown; name?: unknown } =>
  typeof value === "object" && value !== null;

const messageOf = (error: unknown): string =>
  isErrorWithMessage(error) && typeof error.message === "string" && error.message !== ""
    ? error.message
    : String(error);

const errorNameOf = (error: unknown): string =>
  isErrorWithMessage(error) && typeof error.name === "string" ? error.name : "Error";

/** The SDK observation types the worker forwards; everything else the
 * stream emits is either a token fragment of an assistant message (the
 * parent already saw its text as deltas and its content again as the
 * complete onStep message - forwarding both would double-report), a
 * thinking/system/user/status bookkeeping record, or noise the shared
 * decoder has no arm for. */
const FORWARD_STREAM_TYPES = new Set(["tool_call", "usage", "task", "request"]);

export const createCursorSdkWorker = (io: {
  readonly sdk: CursorSdkModule;
  readonly write: (line: string) => void | Promise<void>;
  readonly cwd: string;
  readonly settingSources?: readonly string[];
}): CursorSdkWorker => {
  let agent: CursorSdkAgentHandle | null = null;
  let openFailed = false;
  let disposed = false;
  // The run whose send resolved (receipt written); null while idle.
  let activeRun: CursorSdkRunHandle | null = null;
  // A send whose promise is still settling: the receipt or the failure is
  // owed, and an abort that arrives now cancels the run it becomes.
  const pendingSends = new Set<Promise<CursorSdkRunHandle>>();
  let cancelPendingSend = false;
  let catalogCache: Promise<CursorSdkModelCatalog> | null = null;
  // The failure the catalog call died on, when it did: an explicit effort
  // needs the catalog, and its resolution must rethrow THIS error (auth
  // stays auth, transport stays transport) instead of masking it as a
  // configuration complaint. A catalog that listed nothing (no failure)
  // remains the pass-through degradation it always was.
  let catalogFailure: unknown = null;
  // Prompts that arrived while the open request was still settling. The
  // parent's run path writes the open and prompt lines in one write, so
  // this is the normal path for a one-shot turn, not an edge case.
  let openInFlight: Promise<void> | null = null;
  const queuedPrompts: { readonly id: string; readonly message: string }[] = [];

  /** Fire-and-forget wire write. The write seam owns failure reporting
   * (in main, a failed write finishes the worker through the same
   * idempotent path as EOF and SIGTERM); this only keeps the floating
   * promise observed, so a rejection can never surface as an unhandled
   * rejection that bypasses disposal. Sites that need the failure for
   * their own flow await io.write directly and keep the rejection. */
  const emit = (line: string): void => {
    void Promise.resolve(io.write(line)).catch(() => {});
  };

  const catalog = (): Promise<CursorSdkModelCatalog> => {
    if (catalogCache === null) {
      catalogFailure = null;
      catalogCache = io.sdk.Cursor.models.list().catch((error: unknown) => {
        catalogFailure = error;
        return [];
      });
    }
    return catalogCache;
  };

  const agentOptions = async (request: CursorSdkOpenRequest): Promise<Record<string, unknown>> => {
    const listed = await catalog();
    if (request.effort !== undefined && listed.length === 0 && catalogFailure !== null) {
      throw catalogFailure;
    }
    const model = resolveCursorSdkModel(listed, request.model, request.effort);
    return {
      model,
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      ...(request.disallowedTools === undefined
        ? {}
        : { disallowedTools: request.disallowedTools }),
      local: {
        cwd: io.cwd,
        settingSources: io.settingSources ?? ["project", "user"],
        ...(request.sandbox === false ? { sandboxOptions: { enabled: false } } : {}),
      },
    };
  };

  const settleRun = (id: string, run: CursorSdkRunHandle): void => {
    // One run's stream is pumped while wait() settles in parallel: the
    // forwarded observations are early, the terminal record authoritative.
    const pump = async (): Promise<void> => {
      const stream = run.stream?.();
      if (stream === undefined) return;
      try {
        for await (const observation of stream) {
          if (disposed) return;
          if (typeof observation.type === "string" && FORWARD_STREAM_TYPES.has(observation.type)) {
            await io.write(encodeCursorSdkEvent({ event: observation }));
          }
        }
      } catch {
        // A failed stream is not a failed run: wait() below owns the
        // verdict, and the error (if any) rides its status.
      }
    };
    const pumped = pump();
    const settle = async (): Promise<void> => {
      try {
        const result = await run.wait();
        await pumped;
        if (activeRun === run) activeRun = null;
        await io.write(
          encodeCursorSdkTurnEnd({
            status: result.status,
            ...(result.error?.message !== undefined ? { message: result.error.message } : {}),
            ...(result.error?.code !== undefined ? { code: result.error.code } : {}),
            // Run.wait's error object carries no SDK class name; `native`
            // is the honest kind and the parent's matchers still classify
            // the message.
            ...(result.status === "error" ? { errorKind: "native" as const } : {}),
          }),
        );
      } catch (error) {
        if (activeRun === run) activeRun = null;
        emit(
          encodeCursorSdkTurnEnd({
            status: "error",
            message: messageOf(error),
            errorKind: cursorSdkErrorKindOf(errorNameOf(error)),
          }),
        );
      }
    };
    void settle().catch((error) => {
      stderrLine(`hcn cursor-sdk worker: run ${id} settlement failed: ${messageOf(error)}`);
    });
  };

  const runSend = (id: string, message: string): void => {
    if (disposed) return;
    if (agent === null) {
      emit(
        encodeCursorSdkSendFailed(id, "cursor SDK worker received a prompt before open", "config"),
      );
      return;
    }
    // Concurrent sends are the SDK's own policy: the native promise
    // rejects for an active run and the rejection is forwarded as the
    // send's failure, never queued or retried by hcn.
    const send = agent.send(message, {
      onDelta: async ({ update }) => {
        if (disposed) return;
        if (update.type !== "text-delta") return;
        try {
          await io.write(encodeCursorSdkEvent({ delta: update }));
        } catch {
          // The write seam already reported the failure and started the
          // shared idempotent finish. Letting the rejection propagate
          // into the SDK's callback internals would kill the process as
          // an uncontrolled exception mid-dispose - the one path that
          // must not exist.
        }
      },
      onStep: async ({ step }) => {
        if (disposed) return;
        if (step.type !== "assistantMessage") return;
        // Complete text, one message per step: the boundary the stream's
        // fragment records cannot provide (#438). Synthesized into the
        // SDK assistant shape so the shared reader has one vocabulary.
        const text = step.message;
        const textOf =
          typeof text === "object" &&
          text !== null &&
          typeof (text as { text?: unknown }).text === "string"
            ? (text as { text: string }).text
            : null;
        if (textOf === null || textOf === "") return;
        try {
          await io.write(
            encodeCursorSdkEvent({
              event: {
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: textOf }],
                },
              },
            }),
          );
        } catch {
          // Same containment as onDelta: the seam reported and finished.
        }
      },
    });
    pendingSends.add(send);
    send.then(
      (run) => {
        pendingSends.delete(send);
        activeRun = run;
        emit(encodeCursorSdkReceipt(id));
        if (cancelPendingSend) {
          // An abort arrived while this send was settling: the receipt
          // was already written; cancel now and let the cancelled turn
          // end be the settlement.
          cancelPendingSend = false;
          void run.cancel().catch(() => {});
        }
        settleRun(id, run);
      },
      (error) => {
        pendingSends.delete(send);
        emit(
          encodeCursorSdkSendFailed(id, messageOf(error), cursorSdkErrorKindOf(errorNameOf(error))),
        );
        // A send that never became a run cannot produce a turn end; if
        // its cancel was requested, that request has nothing left to
        // wait for.
        if (pendingSends.size === 0) cancelPendingSend = false;
      },
    );
  };
  return {
    open: (request) => {
      // openInFlight is part of the guard: an open that is still settling
      // must refuse a second open instead of racing a second Agent.create
      // against the first.
      if (agent !== null || openFailed || openInFlight !== null) {
        emit(
          encodeCursorSdkOpenFailed(
            request.id,
            "cursor SDK worker already opened an agent",
            "config",
          ),
        );
        return Promise.resolve();
      }
      const settle = async (): Promise<void> => {
        let opened: CursorSdkAgentHandle;
        try {
          const options = await agentOptions(request);
          opened =
            request.resume === undefined
              ? await io.sdk.Agent.create(options)
              : await io.sdk.Agent.resume(request.resume, options);
        } catch (error) {
          openFailed = true;
          emit(
            encodeCursorSdkOpenFailed(
              request.id,
              messageOf(error),
              cursorSdkErrorKindOf(errorNameOf(error)),
            ),
          );
          // Every queued prompt is owed its refusal; none can run now.
          for (const pending of queuedPrompts.splice(0)) {
            emit(
              encodeCursorSdkSendFailed(
                pending.id,
                "cursor SDK agent failed to open; no run started",
                "config",
              ),
            );
          }
          return;
        }
        agent = opened;
        // Disposed while the open was settling (stdin EOF, a signal, a
        // failed write): the wire is closing and nothing queued may run.
        // The drain below is the only path into Agent.send, so nothing
        // queued can ever be sent, and no announcement is owed on a
        // closing wire. The open promise itself still resolved, so
        // disposal below can close the agent it created.
        if (disposed) return;
        emit(encodeCursorSdkOpened(request.id, opened.agentId));
        for (const pending of queuedPrompts.splice(0)) {
          runSend(pending.id, pending.message);
        }
      };
      openInFlight = settle();
      return openInFlight;
    },
    prompt: (id, message) => {
      if (agent === null) {
        if (openFailed) {
          emit(
            encodeCursorSdkSendFailed(
              id,
              "cursor SDK agent failed to open; no run started",
              "config",
            ),
          );
          return;
        }
        if (openInFlight !== null) {
          queuedPrompts.push({ id, message });
          return;
        }
        emit(
          encodeCursorSdkSendFailed(
            id,
            "cursor SDK worker received a prompt before open",
            "config",
          ),
        );
        return;
      }
      runSend(id, message);
    },
    abort: (id) => {
      if (activeRun !== null) {
        const run = activeRun;
        void run.cancel().then(
          () => emit(encodeCursorSdkAbortReceipt(id, true)),
          () => emit(encodeCursorSdkAbortReceipt(id, false)),
        );
        return;
      }
      if (pendingSends.size > 0) {
        // The run is being created; cancel it the moment it exists. Its
        // turn-end record (cancelled) is the settlement.
        cancelPendingSend = true;
        emit(encodeCursorSdkAbortReceipt(id, true));
        return;
      }
      // Deferred inputs were cancelled before any SDK run existed. Their
      // control receipts settle the interruption without inventing a run
      // verdict or attributing the owner's cancellation to an SDK error.
      if (queuedPrompts.length > 0) {
        for (const pending of queuedPrompts.splice(0)) {
          emit(encodeCursorSdkSendCancelled(pending.id));
        }
        emit(encodeCursorSdkAbortReceipt(id, true));
        return;
      }
      // Idle: no run, no settling send, no queued prompt - there is
      // nothing to cancel, and accepting would claim a cancellation that
      // cannot happen. The truthful answer is a decline.
      emit(encodeCursorSdkAbortReceipt(id, false, true));
    },
    failed: () => openFailed,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await openInFlight;
        await Promise.allSettled([...pendingSends]);
      } catch (error) {
        stderrLine(`hcn cursor-sdk worker: dispose failed: ${messageOf(error)}`);
      }
      // The run's cleanup and the agent's cleanup are attempted
      // independently: a cancel or wait that rejects can never skip the
      // agent's own disposal, each failure is reported under its own
      // name, and neither ever throws out of shutdown. A cancel that
      // refused also skips the wait below - a run nobody cancelled may
      // never settle, and waiting it would stretch disposal into the
      // outer supervisor's SIGKILL instead of finishing it.
      const run = activeRun;
      if (run !== null) {
        try {
          await run.cancel();
          await run.wait();
        } catch (error) {
          stderrLine(`hcn cursor-sdk worker: run cleanup failed: ${messageOf(error)}`);
        }
      }
      try {
        const asyncDispose = agent?.[Symbol.asyncDispose];
        if (asyncDispose !== undefined) await asyncDispose.call(agent);
        else agent?.close?.();
      } catch (error) {
        stderrLine(`hcn cursor-sdk worker: agent cleanup failed: ${messageOf(error)}`);
      }
    },
  };
};

/** Route everything the SDK (or anything it loads) prints away from
 * stdout, which is the NDJSON wire. Installed before the SDK import so
 * even import-time output cannot corrupt a record. */
export const guardConsole = (target: { write(line: string): void }): void => {
  const original: Console = console;
  const redirected =
    (level: string) =>
    (first: unknown, ...rest: unknown[]) => {
      const parts = [first, ...rest].map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      );
      target.write(`hcn cursor-sdk worker: ${level}: ${parts.join(" ")}\n`);
    };
  // Member assignment through globalThis: the SDK (and anything it loads)
  // reads the same console object afterwards.
  (globalThis as { console: Console }).console = {
    ...original,
    log: redirected("log"),
    info: redirected("info"),
    warn: redirected("warn"),
    error: redirected("error"),
    debug: redirected("debug"),
  };
};

const main = async (): Promise<void> => {
  // A dead stderr must not crash the worker mid-cleanup: when the parent
  // vanishes both pipes die together, and a diagnostic written to a dead
  // stderr would otherwise surface as an uncaught EPIPE that bypasses
  // disposal - the exact path finish exists to close. Harmless by design:
  // nothing is reported back to the dead sink. Attached before anything
  // else in this process (guardConsole, the SDK import) can write to it.
  process.stderr.on("error", () => {});
  guardConsole({ write: writeStderrBestEffort });
  const sdk = (await import("@cursor/sdk")) as unknown as CursorSdkModule;
  // The SDK's default store needs node:sqlite; where the module is
  // unavailable the documented JSONL store takes over under the SDK's own
  // state root, so conversations stay durable and resumable.
  try {
    await import("node:sqlite");
  } catch {
    const stateRoot = sdk.getDefaultSdkStateRoot?.();
    if (sdk.JsonlLocalAgentStore !== undefined && stateRoot !== undefined) {
      sdk.Cursor.configure({
        local: { store: new sdk.JsonlLocalAgentStore(`${stateRoot}/agents-jsonl`) },
      });
    }
  }

  // One idempotent shutdown for every teardown source: stdin EOF,
  // SIGTERM, SIGINT, a stdout error and a failed wire write all run the
  // SAME path - stop reading, dispose (cancel and wait the owned run,
  // dispose the SDK agent), set the exit code. A second trigger while one
  // run is in flight is a no-op; a dispose that cannot finish stays
  // bounded by the outer supervisor's SIGKILL, which this worker never
  // preempts. The seam is resolved before any teardown can fire (writes
  // only begin once the worker below exists), so the write failure path
  // can always reach the real finish.
  const finishRef: { run: (() => Promise<void>) | null } = { run: null };

  /** Every wire write goes through here. A failed write (EPIPE, a
   * vanished reader) is reported on stderr and finishes the worker
   * through the shared idempotent path, and the rejection still reaches
   * callers that await it - the stream pump and the turn-end settlement
   * keep their own error flow. The failure is never swallowed, and it
   * can never surface as an unhandled rejection that bypasses disposal;
   * disposal itself never awaits a write, so a dead sink cannot deadlock
   * it on its own queue. */
  const write = (line: string): Promise<void> => {
    const attempt = new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
    attempt.catch((error) => {
      stderrLine(`hcn cursor-sdk worker: stdout write failed: ${messageOf(error)}`);
      void finishRef.run?.();
    });
    return attempt;
  };

  const worker = createCursorSdkWorker({
    sdk,
    write,
    cwd: process.cwd(),
  });

  const readline = createInterface({ input: process.stdin, terminal: false });
  let finishing: Promise<void> | null = null;
  const finish = (): Promise<void> => {
    if (finishing === null) {
      // The body is deferred one microtask so `finishing` is memoized
      // before the body runs: readline.close() emits its own 'close'
      // event synchronously, which reenters finish through the handler
      // below while the memo is still null, running the shutdown body
      // twice - absorbed today only by dispose's internal idempotency.
      // Deferring the body lets the memoization itself absorb the
      // reentry; a microtask changes nothing any caller can observe,
      // since every caller already treats finish as asynchronous.
      finishing = Promise.resolve()
        .then(async () => {
          readline.close();
          await worker.dispose();
          // An agent that never opened is a failed startup: exit nonzero the way
          // the native CLI died on its own startup walls, so the parent's exit
          // classification has the code.
          process.exitCode = worker.failed() ? 1 : 0;
        })
        .catch((error) => {
          stderrLine(`hcn cursor-sdk worker: finish failed: ${messageOf(error)}`);
        });
    }
    return finishing;
  };
  finishRef.run = finish;

  // Signals take the same finish path as EOF: the owned run is cancelled
  // natively and waited, the SDK agent disposed, the exit code set. No
  // forced exit, no takeover - the outer supervisor's grace and SIGKILL
  // bound a finish that cannot complete.
  process.on("SIGTERM", () => {
    void finish();
  });
  process.on("SIGINT", () => {
    void finish();
  });
  // A dead stdout (the reader vanished) is a transport failure of the
  // wire itself: the same idempotent finish owns the cleanup, never an
  // uncaught stream error that bypasses disposal.
  process.stdout.on("error", (error) => {
    stderrLine(`hcn cursor-sdk worker: stdout failed: ${messageOf(error)}`);
    void finish();
  });

  readline.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      stderrLine(`hcn cursor-sdk worker: ignoring a malformed line`);
      return;
    }
    const kind = parsed.hcn;
    if (kind === "open") {
      const request: CursorSdkOpenRequest = {
        id: typeof parsed.id === "string" ? parsed.id : "hcn-identity",
        ...(typeof parsed.resume === "string" ? { resume: parsed.resume } : {}),
        ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
        ...(typeof parsed.effort === "string" ? { effort: parsed.effort } : {}),
        ...(Array.isArray(parsed.tools) && parsed.tools.every((t) => typeof t === "string")
          ? { tools: parsed.tools as readonly string[] }
          : {}),
        ...(Array.isArray(parsed.disallowedTools) &&
        parsed.disallowedTools.every((t) => typeof t === "string")
          ? { disallowedTools: parsed.disallowedTools as readonly string[] }
          : {}),
        ...(parsed.sandbox === false ? { sandbox: false } : {}),
      };
      void worker.open(request).catch((error) => {
        stderrLine(`hcn cursor-sdk worker: open failed: ${messageOf(error)}`);
        write(
          encodeCursorSdkOpenFailed(
            request.id,
            messageOf(error),
            cursorSdkErrorKindOf(errorNameOf(error)),
          ),
        );
      });
      return;
    }
    if (kind === "prompt") {
      if (typeof parsed.id !== "string" || typeof parsed.message !== "string") {
        stderrLine("hcn cursor-sdk worker: prompt line missing id or message");
        return;
      }
      worker.prompt(parsed.id, parsed.message);
      return;
    }
    if (kind === "abort") {
      if (typeof parsed.id !== "string") return;
      worker.abort(parsed.id);
      return;
    }
    stderrLine(`hcn cursor-sdk worker: ignoring an unknown record ${JSON.stringify(kind)}`);
  });
  readline.on("close", () => {
    void finish();
  });
};

const invokedAsScript = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    const entry = pathToFileURL(process.argv[1]).href;
    return entry === import.meta.url || entry === import.meta.url.replace(/\.js$/, ".ts");
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  void main().catch((error) => {
    process.stderr.write(`hcn cursor-sdk worker: fatal: ${messageOf(error)}\n`);
    process.exit(1);
  });
}
