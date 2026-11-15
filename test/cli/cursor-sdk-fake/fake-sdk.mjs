// The scripted fake of the @cursor/sdk surface (issue #440 tests). The
// real worker imports "@cursor/sdk"; the test loader swaps that specifier
// for this module. Behavior comes from a JSON script whose path rides
// HCN_TEST_CURSOR_SDK_SCRIPT, and every AgentOptions the fake received is
// appended (one JSON line each) to HCN_TEST_CURSOR_SDK_RECORD so tests
// assert exactly what the worker passed the SDK.
//
// Script shape:
// {
//   "agentId": "agent-<uuid>",           // announced for create/resume
//   "openError": null | { "name": "AuthenticationError", "message": "..." },
//   "resumeError": null | { "name": "AgentNotFoundError", "message": "..." },
//   "catalog": [ ...ModelListItem... ],  // default: the grok-4.7 capture
//   "catalogError": null | { "name": "AuthenticationError", "message": "..." },
//                                        // models.list throws instead of listing
//   "sends": [                           // consumed in order, one per send
//     {
//       "busy": false,                   // true: the send promise rejects natively
//       "events": [                      // replayed to the worker's callbacks
//         { "step": { "type": "assistantMessage", "message": { "text": "..." } } },
//         { "delta": { "type": "text-delta", "text": "H" } },
//         { "stream": { "type": "tool_call", "call_id": "c1", "name": "read", "status": "running", "args": {} } }
//       ],
//       "status": "finished",            // Run.wait settlement
//       "error": null | { "message": "...", "code": "..." },
//       "holdOpen": false,               // true: wait() never settles until cancel()
//       "cancelFails": false            // true: cancel() rejects instead of cancelling
//     }
//   ]
// }
import { appendFileSync, readFileSync } from "node:fs";

const scriptPath = process.env.HCN_TEST_CURSOR_SDK_SCRIPT;
const recordPath = process.env.HCN_TEST_CURSOR_SDK_RECORD;

const defaultCatalog = [
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      {
        id: "context",
        displayName: "Context",
        values: [
          { value: "256k", displayName: "256K" },
          { value: "500k", displayName: "500K" },
        ],
      },
      {
        id: "reasoning_effort",
        displayName: "Effort",
        values: [
          { value: "low", displayName: "Low" },
          { value: "medium", displayName: "Medium" },
          { value: "high", displayName: "High" },
          { value: "xhigh", displayName: "Extra High" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    ],
    variants: [
      {
        params: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "high" },
          { id: "fast", value: "false" },
        ],
        displayName: "Grok 4.7 High",
      },
      {
        params: [
          { id: "context", value: "500k" },
          { id: "reasoning_effort", value: "high" },
          { id: "fast", value: "true" },
        ],
        displayName: "Grok 4.7 High Fast",
        isDefault: true,
        isMaxMode: true,
      },
    ],
  },
];

const readScript = () => {
  if (scriptPath === undefined || scriptPath === "") return {};
  try {
    return JSON.parse(readFileSync(scriptPath, "utf8"));
  } catch {
    return {};
  }
};

const record = (line) => {
  if (recordPath === undefined || recordPath === "") return;
  try {
    appendFileSync(recordPath, `${JSON.stringify(line)}\n`);
  } catch {
    // A recording failure never changes fake behavior.
  }
};

const script = readScript();
const agentId = script.agentId ?? "agent-00000000-0000-4000-8000-000000000001";
let sendIndex = 0;

const errorOf = (entry) => {
  if (entry === null || entry === undefined) return null;
  const error = new Error(entry.message ?? "fake SDK error");
  error.name = entry.name ?? "Error";
  return error;
};

const settleDelay = (entry) => (entry?.delayMs === undefined ? 0 : entry.delayMs);

const makeRun = (entry) => {
  const events = entry?.events ?? [];
  let cancelled = false;
  let waitSettled = false;
  let terminalResult;
  let cancelRequested = null;
  const waiters = [];
  // One replay timeline, shared by the callbacks and the stream: script
  // entries are walked in order, callbacks fire where they sit, and each
  // stream observation is queued for run.stream() to yield at its
  // original position - the way the real SDK interleaves them. Each
  // queued record holds the replay until the consumer has taken it, so
  // cross-source order on the wire is the script's order, exactly as the
  // SDK's awaited sendUpdate sequence produces.
  const streamQueue = [];
  const streamWaiters = [];
  let replayDone = false;
  const settle = (result) => {
    if (waitSettled) return;
    waitSettled = true;
    terminalResult = result;
    for (const waiter of waiters.splice(0)) waiter(result);
  };
  const run = {
    id: `run-${sendIndex}`,
    agentId,
    async *stream() {
      let index = 0;
      for (;;) {
        if (index < streamQueue.length) {
          const entry = streamQueue[index];
          yield entry.record;
          index += 1;
          entry.delivered();
          continue;
        }
        if (replayDone) return;
        await new Promise((resolve) => streamWaiters.push(resolve));
      }
    },
    async wait() {
      if (waitSettled) return terminalResult;
      if (entry?.holdOpen === true) {
        return await new Promise((resolve) => {
          waiters.push(resolve);
          cancelRequested = () => settle({ status: "cancelled" });
        });
      }
      return await new Promise((resolve) => {
        waiters.push(() => resolve(terminalResult));
      });
    },
    async cancel() {
      record({ phase: "cancel", runId: run.id });
      if (entry?.cancelFails === true) {
        // The SDK models cancel as an operation a run may not support
        // (UnsupportedRunOperationError); this is that rejection, so the
        // worker's disposal can be proven against a cancel that refuses.
        if (entry.finishOnCancelRejection === true) settle({ status: "finished" });
        throw new Error("cancel refused by the SDK");
      }
      cancelled = true;
      cancelRequested?.();
      if (entry?.holdOpen === true) settle({ status: "cancelled" });
    },
  };
  const replay = async (callbacks) => {
    await new Promise((resolve) => setTimeout(resolve, entry.replayDelayMs ?? 0));
    for (const replayEntry of events) {
      if (replayEntry.delta !== undefined) {
        if (callbacks?.onDelta !== undefined) {
          await callbacks.onDelta({ update: replayEntry.delta });
        }
      } else if (replayEntry.step !== undefined) {
        if (callbacks?.onStep !== undefined) {
          await callbacks.onStep({ step: replayEntry.step });
        }
      } else if (replayEntry.stream !== undefined) {
        await new Promise((resolve) => {
          streamQueue.push({ record: replayEntry.stream, delivered: resolve });
          for (const waiter of streamWaiters.splice(0)) waiter();
        });
      }
    }
    replayDone = true;
    for (const waiter of streamWaiters.splice(0)) waiter();
    if (entry?.holdOpen !== true) {
      const status = cancelled ? "cancelled" : (entry?.status ?? "finished");
      const result = { id: run.id, status };
      if (status === "error" && entry?.error !== undefined) result.error = entry.error;
      await new Promise((resolve) => setTimeout(resolve, settleDelay(entry)));
      settle(result);
    }
  };
  return { run, replay };
};

const makeAgent = (openedAs) => {
  const sendEntry = () => script.sends?.[sendIndex] ?? {};
  return {
    agentId,
    async send(message, callbacks) {
      const entry = sendEntry();
      record({
        phase: "send",
        openedAs,
        message,
        sendIndex,
        busy: entry.busy === true,
      });
      sendIndex += 1;
      if (entry.busy === true) {
        const error = new Error(entry.message ?? `Agent ${agentId} already has active run`);
        error.name = entry.errorName ?? "UnknownAgentError";
        throw error;
      }
      const run = makeRun(entry);
      // Replay the scripted timeline asynchronously, after the run handle
      // resolves, the way the real SDK streams during the run: callbacks
      // and stream observations at their original script positions.
      void run.replay(callbacks);
      return run.run;
    },
    close() {},
    async [Symbol.asyncDispose]() {
      // Recorded so process-level lifecycle tests can prove the worker
      // ran the agent's native disposal before exiting on a signal or a
      // failed write - the fake's only behavioral addition for that lane.
      record({ phase: "dispose" });
    },
  };
};

export const Agent = {
  async create(options) {
    record({ phase: "create", options });
    if (script.openDelayMs) await new Promise((resolve) => setTimeout(resolve, script.openDelayMs));
    const error = errorOf(script.openError);
    if (error !== null) throw error;
    return makeAgent("create", options);
  },
  async resume(agentIdArg, options) {
    record({ phase: "resume", agentId: agentIdArg, options });
    const error = errorOf(script.resumeError);
    if (error !== null) throw error;
    return makeAgent("resume", options);
  },
};

export const Cursor = {
  models: {
    async list() {
      const error = errorOf(script.catalogError);
      if (error !== null) throw error;
      return script.catalog ?? defaultCatalog;
    },
  },
  configure() {},
};

export class JsonlLocalAgentStore {
  constructor(directory) {
    this.directory = directory;
  }
}

export const getDefaultSdkStateRoot = () => "/tmp/hcn-cursor-sdk-fake-state-root";
