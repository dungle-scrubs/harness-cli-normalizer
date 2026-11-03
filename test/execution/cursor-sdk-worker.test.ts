/**
 * Worker-logic tests (issue #440) with the SDK object injected directly:
 * receipts, native busy rejection, cancellation receipts, the forwarding
 * rules (deltas once, complete onStep messages, only tool_call / usage /
 * task / request stream records), model resolution against the catalog,
 * and disposal. These drive createCursorSdkWorker without any process.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  type CursorSdkAgentHandle,
  type CursorSdkModule,
  type CursorSdkRunHandle,
  createCursorSdkWorker,
} from "../../src/execution/cursor-sdk-worker.js";
import type { CursorSdkModelCatalog } from "../../src/interpretation/cursor-sdk.js";

const agentId = "agent-da354f73-06a8-4bb8-8c6f-e88da9f95eb1";

/** The captured account catalog (48 entries, SDK 1.0.38), read as data so
 * explicit-effort resolution is exercised against the real public entry
 * shapes, never a transcribed copy. */
const FULL_CATALOG = JSON.parse(
  readFileSync(
    new URL("../fixtures/cursor-sdk-1.0.38/models.full.snapshot.json", import.meta.url),
    "utf8",
  ),
) as readonly unknown[];

interface ScriptedSend {
  readonly busy?: boolean;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly status?: "finished" | "error" | "cancelled";
  readonly holdOpen?: boolean;
  /** true: run.cancel() rejects the way an SDK without cancel support
   * does - disposal must survive it. */
  readonly cancelFails?: boolean;
  readonly error?: { readonly message?: string; readonly code?: string };
  readonly onSend?: (run: ScriptedRun, emit: (line: string) => void) => void;
}

interface ScriptedRun extends CursorSdkRunHandle {
  emit(line: string): void;
  cancelled(): boolean;
}

/** What Cursor.models.list does in the scripted SDK: a catalog (default
 * grok-4.7), or a failure it throws. */
interface ScriptedModels {
  readonly catalog?: readonly unknown[];
  readonly error?: { readonly name: string; readonly message: string };
}

const makeWorker = (
  sends: readonly ScriptedSend[],
  writeGate?: (line: string) => Promise<void> | undefined,
  models?: ScriptedModels,
  /** Held until resolved before Agent.create returns: scripts the open
   * that is still settling while prompts, aborts and disposal arrive. */
  createGate?: Promise<void>,
) => {
  const written: string[] = [];
  const seen: Record<string, unknown>[] = [];
  let sendIndex = 0;
  const agents: ScriptedRun[] = [];
  const sdk: CursorSdkModule = {
    Agent: {
      create: async (options) => {
        await (createGate ?? Promise.resolve());
        seen.push({ phase: "create", options });
        return makeAgent();
      },
      resume: async (id, options) => {
        seen.push({ phase: "resume", id, options });
        return makeAgent();
      },
    },
    Cursor: {
      models: {
        list: async () => {
          if (models?.error !== undefined) {
            const error = new Error(models.error.message);
            error.name = models.error.name;
            throw error;
          }
          return (models?.catalog ?? [
            {
              id: "grok-4.7",
              parameters: [
                {
                  id: "reasoning_effort",
                  values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
                },
              ],
              variants: [
                {
                  params: [{ id: "reasoning_effort", value: "high" }],
                  displayName: "Grok 4.7 High",
                },
              ],
            },
          ]) as CursorSdkModelCatalog;
        },
      },
      configure: () => {},
    },
  };
  const makeAgent = (): CursorSdkAgentHandle => ({
    agentId,
    send: (message, callbacks) => {
      const entry = sends[sendIndex++] ?? {};
      seen.push({ phase: "send", message, index: sendIndex - 1 });
      if (entry.busy === true) {
        const error = new Error(entry.errorMessage ?? `Agent ${agentId} already has active run`);
        error.name = entry.errorName ?? "UnknownAgentError";
        return Promise.reject(error);
      }
      let cancelled = false;
      // Initialized to a no-op so flow analysis never narrows it to null
      // (the wait() closure assigns the real resolver).
      let releaseWait: (value: { status: "finished" | "error" | "cancelled" }) => void = () => {};
      const completion = new Promise<{ status: "finished" | "error" | "cancelled" }>((resolve) => {
        releaseWait = resolve;
      });
      const run: ScriptedRun = {
        emit: (line) => written.push(line),
        cancelled: () => cancelled,
        stream: async function* () {
          // The scripted stream records are the worker's to forward.
          for (const event of entry.onSend ? [] : []) yield event;
        },
        wait: () => completion,
        cancel: async () => {
          cancelled = true;
          if (entry.cancelFails === true) {
            throw new Error("cancel refused by the SDK");
          }
          written.push("__cancelled__");
          releaseWait({
            status: entry.holdOpen === true ? "cancelled" : (entry.status ?? "finished"),
          });
        },
      };
      agents.push(run);
      void Promise.resolve().then(() => entry.onSend?.(run, (line) => written.push(line)));
      // Emit one delta and one complete step the way the SDK does: after
      // the send promise settles (a macrotask, not a microtask, so the
      // worker's receipt lands first like the real SDK's). A failing write
      // sink rejects the worker's callback; that rejection is the sink's
      // business, so the driver never reports it as this fake's own
      // unhandled rejection.
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));

        await callbacks?.onDelta?.({ update: { type: "text-delta", text: "H" } });
        await callbacks?.onStep?.({
          step: { type: "assistantMessage", message: { text: "HCN_CURSOR_SDK_OK" } },
        });
        if (entry.holdOpen !== true) {
          releaseWait({
            status: entry.status ?? "finished",
            ...(entry.error !== undefined ? { error: entry.error } : {}),
          });
        }
      })().catch(() => {});
      return Promise.resolve(run);
    },
    close: () => {},
    [Symbol.asyncDispose]: async () => {
      seen.push({ phase: "dispose" });
    },
  });
  const worker = createCursorSdkWorker({
    sdk,
    write: (line) => {
      written.push(line);
      return writeGate?.(line);
    },
    cwd: "/tmp",
  });
  return { worker, written, seen };
};

const lines = (written: readonly string[]): Record<string, unknown>[] =>
  written
    .filter((line) => line !== "__cancelled__")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("cursor-sdk worker", () => {
  test("a blocked output sink backpressures SDK callbacks before the next message", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { worker, written } = makeWorker([{ status: "finished" }], (line) =>
      line.includes('"text-delta"') ? blocked : undefined,
    );
    await worker.open({ id: "hcn-identity" });
    worker.prompt("hcn-send:1", "hi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines(written).some((record) => record.delta !== undefined)).toBe(true);
    expect(lines(written).some((record) => record.hcn === "turn-end")).toBe(false);
    expect(
      lines(written).some((record) => (record.event as { type?: string })?.type === "assistant"),
    ).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines(written).at(-1)).toMatchObject({ hcn: "turn-end", status: "finished" });
    await worker.dispose();
  });
  test("open announces the agent; the prompt receipts, forwards deltas once and one complete message, then the terminal record", async () => {
    const { worker, written } = makeWorker([{ status: "finished" }]);
    await worker.open({ id: "hcn-identity" });
    await worker.prompt("hcn-send:1", "hi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const records = lines(written);
    expect(records[0]).toMatchObject({ hcn: "opened", agentId });
    expect(records[1]).toMatchObject({ hcn: "receipt", id: "hcn-send:1", disposition: "started" });
    expect(records.filter((record) => record.hcn === "event")).toEqual([
      { hcn: "event", delta: { type: "text-delta", text: "H" } },
      {
        hcn: "event",
        event: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "HCN_CURSOR_SDK_OK" }] },
        },
      },
    ]);
    expect(records.at(-1)).toMatchObject({ hcn: "turn-end", status: "finished" });
    await worker.dispose();
  });

  test("closing an active worker cancels its run before disposing the SDK agent", async () => {
    const { worker, written, seen } = makeWorker([{ holdOpen: true }]);
    await worker.open({ id: "hcn-identity" });
    worker.prompt("hcn-send:1", "essay");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker.dispose();
    expect(written).toContain("__cancelled__");
    expect(lines(written)).toContainEqual({ hcn: "turn-end", status: "cancelled" });
    expect(seen.at(-1)).toEqual({ phase: "dispose" });
  });

  test("a rejecting native cancel still attempts the agent's disposal; the run cleanup failure is reported, not propagated", async () => {
    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      const { worker, seen } = makeWorker([{ holdOpen: true, cancelFails: true }]);
      await worker.open({ id: "hcn-identity" });
      worker.prompt("hcn-send:1", "essay");
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The held-open run's wait() can never settle once cancel refused, so
      // a disposal that kept waiting it would hang this test rather than
      // pass; the agent's own cleanup must still be attempted.
      await worker.dispose();
      expect(seen.some((entry) => entry.phase === "dispose")).toBe(true);
      expect(stderrChunks.join("")).toContain("run cleanup failed: cancel refused by the SDK");
    } finally {
      spy.mockRestore();
    }
  });

  test("an agent cleanup failure never throws out of dispose and is reported as its own failure", async () => {
    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      const sdk: CursorSdkModule = {
        Agent: {
          create: async () => ({
            agentId,
            send: async () => {
              throw new Error("unreachable");
            },
            [Symbol.asyncDispose]: async () => {
              throw new Error("asyncDispose refused");
            },
          }),
          resume: async () => {
            throw new Error("unreachable");
          },
        },
        Cursor: { models: { list: async () => [] }, configure: () => {} },
      };
      const worker = createCursorSdkWorker({
        sdk,
        write: () => {},
        cwd: "/tmp",
      });
      await worker.open({ id: "hcn-identity" });
      await expect(worker.dispose()).resolves.toBeUndefined();
      expect(stderrChunks.join("")).toContain("agent cleanup failed: asyncDispose refused");
    } finally {
      spy.mockRestore();
    }
  });

  test("an error run carries the native error fields on the terminal record", async () => {
    const { worker, written } = makeWorker([
      { status: "error", error: { message: "usage capped", code: "PRO_USER_USAGE_LIMIT" } },
    ]);
    await worker.open({ id: "hcn-identity" });
    await worker.prompt("hcn-send:1", "hi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines(written).at(-1)).toEqual({
      hcn: "turn-end",
      status: "error",
      message: "usage capped",
      code: "PRO_USER_USAGE_LIMIT",
      errorKind: "native",
    });
    await worker.dispose();
  });

  test("a busy send forwards the native rejection and no terminal record follows", async () => {
    const { worker, written } = makeWorker([{ status: "finished" }, { busy: true }]);
    await worker.open({ id: "hcn-identity" });
    await worker.prompt("hcn-send:1", "first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.prompt("hcn-send:2", "second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const records = lines(written);
    expect(records).toContainEqual({
      hcn: "send-failed",
      id: "hcn-send:2",
      message: `Agent ${agentId} already has active run`,
      errorKind: "native",
    });
    expect(records.filter((record) => record.hcn === "turn-end")).toHaveLength(1);
    await worker.dispose();
  });

  test("abort cancels the active run; idle abort declines truthfully with no settlement", async () => {
    const { worker, written } = makeWorker([{ holdOpen: true }]);
    await worker.open({ id: "hcn-identity" });
    await worker.prompt("hcn-send:1", "essay");
    await new Promise((resolve) => setTimeout(resolve, 10));
    worker.abort("hcn-interrupt:1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const records = lines(written);
    expect(written).toContain("__cancelled__");
    expect(records).toContainEqual({ hcn: "abort-receipt", id: "hcn-interrupt:1", accepted: true });
    expect(records).toContainEqual({ hcn: "turn-end", status: "cancelled" });
    // Idle after the cancelled turn: no run, no settling send, no queued
    // prompt - nothing to cancel, so the abort is declined, not accepted,
    // and nothing new settles afterwards.
    const before = records.length;
    worker.abort("hcn-interrupt:2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines(written).slice(before)).toEqual([
      { hcn: "abort-receipt", id: "hcn-interrupt:2", accepted: false, idle: true },
    ]);
    await worker.dispose();
  });

  test("an abort before any open (no target at all) is declined", async () => {
    const { worker, written } = makeWorker([{ status: "finished" }]);
    worker.abort("hcn-interrupt:1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines(written)).toEqual([
      { hcn: "abort-receipt", id: "hcn-interrupt:1", accepted: false, idle: true },
    ]);
    await worker.dispose();
  });

  test("an abort while the open is still settling refuses the queued prompt; the open then releases without ever sending", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { worker, written, seen } = makeWorker(
      [{ status: "finished" }],
      undefined,
      undefined,
      createGate,
    );
    void worker.open({ id: "hcn-identity" });
    // The parent writes open+prompt in one write; the worker defers the
    // prompt behind the settling open. An abort lands in that window.
    worker.prompt("hcn-send:1", "hi");
    worker.abort("hcn-interrupt:1");
    const atAbort = lines(written);
    expect(atAbort).toContainEqual({ hcn: "abort-receipt", id: "hcn-interrupt:1", accepted: true });
    expect(atAbort).toContainEqual({ hcn: "send-cancelled", id: "hcn-send:1" });
    expect(atAbort.some((record) => record.hcn === "send-failed")).toBe(false);
    expect(atAbort.some((record) => record.hcn === "receipt")).toBe(false);
    expect(atAbort.some((record) => record.hcn === "turn-end")).toBe(false);
    // The open releases after the abort: the agent exists, but the queued
    // work must never reach Agent.send, and no terminal record is
    // invented for a run that never started.
    releaseCreate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const records = lines(written);
    expect(records.some((record) => record.hcn === "opened")).toBe(true);
    expect(seen.some((entry) => entry.phase === "send")).toBe(false);
    expect(records.some((record) => record.hcn === "receipt")).toBe(false);
    expect(records.some((record) => record.hcn === "turn-end")).toBe(false);
    await worker.dispose();
  });

  test("disposal while the open is still pending never drains the queued prompt", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { worker, written, seen } = makeWorker(
      [{ status: "finished" }],
      undefined,
      undefined,
      createGate,
    );
    void worker.open({ id: "hcn-identity" });
    worker.prompt("hcn-send:1", "hi");
    // stdin EOF mid-open: disposal starts before the agent exists, then
    // the open releases into an already-disposed worker.
    const disposing = worker.dispose();
    releaseCreate();
    await disposing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.some((entry) => entry.phase === "send")).toBe(false);
    const records = lines(written);
    expect(records.some((record) => record.hcn === "opened")).toBe(false);
    expect(records.some((record) => record.hcn === "receipt")).toBe(false);
    expect(records.some((record) => record.hcn === "turn-end")).toBe(false);
  });

  test("a second open while the first is still settling is refused, not raced", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { worker, written, seen } = makeWorker([], undefined, undefined, createGate);
    void worker.open({ id: "hcn-identity" });
    void worker.open({ id: "hcn-identity:2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines(written)).toContainEqual({
      hcn: "open-failed",
      id: "hcn-identity:2",
      message: "cursor SDK worker already opened an agent",
      errorKind: "config",
    });
    releaseCreate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Exactly one agent was ever created.
    expect(seen.filter((entry) => entry.phase === "create")).toHaveLength(1);
    await worker.dispose();
  });

  test("a failing write sink surfaces no unhandled rejection and the worker still settles and disposes", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const { worker } = makeWorker([{ holdOpen: true }], () =>
        Promise.reject(new Error("write refused (EPIPE)")),
      );
      // Every record write fails - opened, receipt, the abort receipt and
      // both turn-end attempts - yet each failure is observed at the
      // seam, never as an unhandled rejection, and disposal completes.
      await worker.open({ id: "hcn-identity" });
      worker.prompt("hcn-send:1", "hi");
      await new Promise((resolve) => setTimeout(resolve, 10));
      worker.abort("hcn-interrupt:1");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await worker.dispose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("open failure names the SDK error; later prompts answer send-failed, not a run", async () => {
    const written: string[] = [];
    const sdk: CursorSdkModule = {
      Agent: {
        create: async () => {
          const error = new Error("Invalid API key");
          error.name = "AuthenticationError";
          throw error;
        },
        resume: async () => {
          throw new Error("unreachable");
        },
      },
      Cursor: { models: { list: async () => [] }, configure: () => {} },
    };
    const worker = createCursorSdkWorker({
      sdk,
      write: (line) => {
        written.push(line);
      },
      cwd: "/tmp",
    });
    await worker.open({ id: "hcn-identity" });
    worker.prompt("hcn-send:1", "hi");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lines(written)).toEqual([
      { hcn: "open-failed", id: "hcn-identity", message: "Invalid API key", errorKind: "auth" },
      {
        hcn: "send-failed",
        id: "hcn-send:1",
        message: "cursor SDK agent failed to open; no run started",
        errorKind: "config",
      },
    ]);
    await worker.dispose();
  });

  test("the open request resolves the model slug against the catalog and maps the restriction", async () => {
    const { worker, seen } = makeWorker([]);
    await worker.open({
      id: "hcn-identity",
      model: "grok-4.7-high",
      tools: ["read"],
      disallowedTools: ["task", "mcp"],
      sandbox: false,
    });
    expect(seen[0]).toMatchObject({
      phase: "create",
      options: {
        model: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] },
        tools: ["read"],
        disallowedTools: ["task", "mcp"],
        local: {
          cwd: "/tmp",
          settingSources: ["project", "user"],
          sandboxOptions: { enabled: false },
        },
      },
    });
    await worker.dispose();
  });

  test("explicit effort pins the native parameter when the slug is the bare catalog id; Agent.create and Agent.resume share it", async () => {
    // The real public gpt-5.3-codex entry: native default reasoning high,
    // fast true; the CLI's medium tier is the bare slug itself.
    const codex = FULL_CATALOG.filter((entry) => (entry as { id?: string }).id === "gpt-5.3-codex");
    const create = makeWorker([], undefined, { catalog: codex });
    await create.worker.open({ id: "hcn-identity", model: "gpt-5.3-codex", effort: "medium" });
    expect(create.seen[0]).toMatchObject({
      phase: "create",
      options: {
        model: {
          id: "gpt-5.3-codex",
          params: [
            { id: "reasoning", value: "medium" },
            { id: "fast", value: "false" },
          ],
        },
      },
    });
    await create.worker.dispose();
    const resume = makeWorker([], undefined, { catalog: codex });
    await resume.worker.open({
      id: "hcn-identity",
      resume: agentId,
      model: "gpt-5.3-codex",
      effort: "medium",
    });
    expect(resume.seen[0]).toMatchObject({
      phase: "resume",
      id: agentId,
      options: {
        model: {
          id: "gpt-5.3-codex",
          params: [
            { id: "reasoning", value: "medium" },
            { id: "fast", value: "false" },
          ],
        },
      },
    });
    await resume.worker.dispose();
  });

  test("a failed catalog lookup with explicit effort surfaces the ORIGINAL error, not a config complaint", async () => {
    // models.list died as the documented AuthenticationError ("Invalid
    // API key"): with an explicit effort that needs the catalog, the
    // original error is rethrown, so the open fails auth - never masked
    // as configuration.
    const refused = makeWorker([], undefined, {
      error: { name: "AuthenticationError", message: "Invalid API key" },
    });
    await refused.worker.open({ id: "hcn-identity", model: "gpt-5.3-codex", effort: "medium" });
    expect(lines(refused.written)).toEqual([
      {
        hcn: "open-failed",
        id: "hcn-identity",
        message: "Invalid API key",
        errorKind: "auth",
      },
    ]);
    await refused.worker.dispose();
    // Without an explicit effort the existing contract stands: the
    // catalog failure degrades to pass-through and Agent.create answers
    // with its own native error.
    const passthrough = makeWorker([], undefined, {
      error: { name: "AuthenticationError", message: "Invalid API key" },
    });
    await passthrough.worker.open({ id: "hcn-identity", model: "gpt-5.3-codex" });
    expect(passthrough.seen[0]).toMatchObject({
      phase: "create",
      options: { model: { id: "gpt-5.3-codex" } },
    });
    expect(lines(passthrough.written)[0]).toMatchObject({ hcn: "opened", agentId });
    await passthrough.worker.dispose();
  });

  test("a legitimately empty catalog or unmatchable effort with explicit effort is a config open failure", async () => {
    const empty = makeWorker([], undefined, { catalog: [] });
    await empty.worker.open({ id: "hcn-identity", model: "gpt-5.3-codex", effort: "medium" });
    const emptyRecord = lines(empty.written)[0] as {
      hcn?: string;
      message?: string;
      errorKind?: string;
    };
    expect(emptyRecord.hcn).toBe("open-failed");
    expect(emptyRecord.errorKind).toBe("config");
    expect(emptyRecord.message).toContain("medium");
    await empty.worker.dispose();
    const unmatchable = makeWorker([], undefined, {
      catalog: FULL_CATALOG.filter((entry) => (entry as { id?: string }).id === "grok-4.7"),
    });
    await unmatchable.worker.open({ id: "hcn-identity", model: "grok-4.7", effort: "max" });
    const unmatchableRecord = lines(unmatchable.written)[0] as {
      hcn?: string;
      message?: string;
      errorKind?: string;
    };
    expect(unmatchableRecord.hcn).toBe("open-failed");
    expect(unmatchableRecord.errorKind).toBe("config");
    expect(unmatchableRecord.message).toContain('"max"');
    await unmatchable.worker.dispose();
  });

  test("dispose settles the SDK agent exactly once", async () => {
    const { worker, seen } = makeWorker([]);
    await worker.open({ id: "hcn-identity" });
    await worker.dispose();
    await worker.dispose();
    expect(seen.filter((entry) => entry.phase === "dispose")).toHaveLength(1);
  });
});
