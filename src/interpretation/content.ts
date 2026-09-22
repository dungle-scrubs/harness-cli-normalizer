/**
 * Content decoding: extract assistant text, token deltas, tool calls, and
 * progress from ONE parsed harness record. Each harness has an entirely
 * different event vocabulary, so this dispatches by harness name to a pure
 * per-harness reader. Identity and wall detection stay descriptor-driven
 * elsewhere; this owns the message/token/tool/progress classes only.
 *
 * (Kept as functions rather than descriptor data because the shapes are
 * structurally too varied - array-of-blocks text, nested delta events,
 * payload-discriminated records - for the flat match/field spec that
 * identity decoding uses.)
 */
import type {
  CompactionState,
  CompactionTrigger,
  HarnessName,
  LimitCode,
} from "../knowledge/descriptor.js";
import { asRecord, readPath as at } from "./shape.js";

export type ContentEvent =
  | { readonly kind: "token"; readonly text: string }
  | { readonly kind: "message"; readonly role: string; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input?: unknown }
  | { readonly kind: "progress"; readonly label: string }
  /** ADR 0009: the harness compacted its own context. Passes through
   * `decode.ts` unchanged, so this shape matches the HarnessEvent arm. */
  | {
      readonly kind: "compaction";
      readonly state: CompactionState;
      readonly trigger?: CompactionTrigger;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly durationMs?: number;
      readonly detail?: string;
    }
  /** `terminal: true` marks an error that ended the turn (a failed result
   * record); the runner turns it into a task failure. Other errors are
   * informational and the turn goes on. `provisional: true` qualifies a
   * terminal error: the harness may still supersede it with a successful
   * assistant message in the same run (pi retries a stopReason-error
   * attempt in-process), so the decoder holds the verdict and settles it
   * at stream/turn end (see `settleProvisionalError`). */
  | {
      readonly kind: "error";
      readonly message: string;
      readonly terminal?: boolean;
      readonly provisional?: boolean;
      /** A refused tool call or rejected question:
       * the native tool name and the harness's reason, which may be
       * empty. Machine consumers branch on presence, never on prose. */
      readonly denial?: { readonly tool: string; readonly reason: string };
    }
  | { readonly kind: "budget"; readonly detail: string }
  /** A structured limit record on the stream (claude's rate_limit_event);
   * the runner turns it into a limit-class failure. `resetsAt` is epoch
   * milliseconds when the harness reported one. */
  | {
      readonly kind: "limit";
      readonly code: LimitCode;
      readonly detail: string;
      readonly resetsAt?: number;
    };

/** Text of an array of `{type:"text", text}` content blocks. */
const textOfBlocks = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((b) => asRecord(b))
        .filter((b): b is Record<string, unknown> => b !== null && b.type === "text")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("")
    : "";

const numberOr = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** claude reports `auto` and `manual`; anything else is left unset rather
 * than guessed, because a wrong trigger is worse than a missing one. */
const claudeTrigger = (value: unknown): CompactionTrigger | undefined =>
  value === "auto" || value === "manual" ? value : undefined;

/** ADR 0009. claude emits up to four records around one compaction, and this
 * decoder reads one record at a time with no state between them, so exactly
 * one record produces the end event. The boundary is that record, because it
 * is the only one carrying numbers. Returning `null` means "not a compaction
 * record", which falls through to the generic progress arm. */
const claudeCompaction = (r: Record<string, unknown>): ContentEvent[] | null => {
  if (r.subtype === "compact_boundary") {
    const meta = asRecord(r.compact_metadata) ?? {};
    const trigger = claudeTrigger(meta.trigger);
    return [
      {
        kind: "compaction",
        state: "compacted",
        ...(trigger !== undefined ? { trigger } : {}),
        // The live stream is snake_case; the saved transcript is camelCase
        // for the same data, and transcript/claude.ts reads that one.
        ...(numberOr(meta.pre_tokens) !== undefined
          ? { tokensBefore: numberOr(meta.pre_tokens) }
          : {}),
        ...(numberOr(meta.post_tokens) !== undefined
          ? { tokensAfter: numberOr(meta.post_tokens) }
          : {}),
        ...(numberOr(meta.duration_ms) !== undefined
          ? { durationMs: numberOr(meta.duration_ms) }
          : {}),
      },
    ];
  }
  if (r.subtype !== "status") return null;
  if (r.status === "compacting") return [{ kind: "compaction", state: "started" }];
  if (r.compact_result === "failed") {
    const detail = typeof r.compact_error === "string" ? r.compact_error : "";
    return [{ kind: "compaction", state: "failed", ...(detail !== "" ? { detail } : {}) }];
  }
  // The success status is deliberately silent: the boundary record that
  // follows carries the end, and emitting both would give two ends for one
  // compaction, so a caller counting boundaries would double-count.
  if (r.compact_result === "success") return [];
  return null;
};

const claude = (r: Record<string, unknown>): ContentEvent[] => {
  const events: ContentEvent[] = [];
  if (r.type === "assistant") {
    const content = at(r, "message.content");
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = asRecord(raw);
        if (block?.type === "tool_use" && typeof block.name === "string") {
          events.push({ kind: "tool", name: block.name, input: block.input });
        }
      }
    }
    const text = textOfBlocks(content);
    if (text !== "") events.push({ kind: "message", role: "assistant", text });
  } else if (r.type === "stream_event") {
    const delta = at(r, "event.delta");
    const d = asRecord(delta);
    if (d?.type === "text_delta" && typeof d.text === "string") {
      events.push({ kind: "token", text: d.text });
    }
  } else if (r.type === "system" && r.subtype !== "init" && typeof r.subtype === "string") {
    // Compaction records are lossless and replace the progress label they
    // used to carry (ADR 0009); everything else stays droppable progress.
    // Non-init system lines (hook_started etc.) surface as droppable
    // progress, as the pre-refactor decoder did. The init line is the
    // identity announcement, handled upstream.
    const compaction = claudeCompaction(r);
    if (compaction !== null) events.push(...compaction);
    else events.push({ kind: "progress", label: r.subtype });
  } else if (r.type === "result" && r.is_error === true) {
    // A result line marked is_error is a failed turn (max-turns, execution
    // error, auth wall) - surface it so a streamTurn consumer sees the
    // failure, not a clean turn. (openSession handles result boundaries
    // itself.) The harness's own text rides along: without it the
    // classifier sees only the subtype (often "success") and degrades an
    // auth wall to a work-verdict task instead of retryable auth.
    const sub = typeof r.subtype === "string" ? r.subtype : "result error";
    // Bounded like the native stderr tail (failureFromNative slices to
    // 512): a result text can carry a full final answer.
    const detail =
      typeof r.result === "string" && r.result.length > 0 ? ` (${r.result.slice(0, 512)})` : "";
    events.push({ kind: "error", message: `turn failed: ${sub}${detail}`, terminal: true });
  } else if (r.type === "rate_limit_event") {
    // Only "rejected" is a limit; "allowed_warning" still serves the request.
    // overageStatus is a separate billing signal, not a rate limit.
    // resetsAt arrives in seconds; the event carries milliseconds. No wall
    // clock is read.
    const info = asRecord(r.rate_limit_info);
    const status = info?.status;
    if (status === "rejected") {
      const raw = info?.resetsAt;
      const milliseconds = typeof raw === "number" ? raw * 1000 : Number.NaN;
      const resetsAt = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
      events.push({
        kind: "limit",
        code: "rate-limit",
        detail: `rate_limit_event status=${String(status)}`,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    }
  }
  return events;
};

// codex item types that are NOT tool activity - everything else on
// item.started is a tool of some kind (command_execution, file_change,
// mcp_tool_call, web_search, ...), surfaced generically by item.type.
const CODEX_NON_TOOL = new Set(["agent_message", "error", "reasoning", "todo_list"]);

const codex = (r: Record<string, unknown>): ContentEvent[] => {
  if (r.type === "turn.failed" || r.type === "error") {
    const error = r.type === "error" ? r : asRecord(r.error);
    return [
      {
        kind: "error",
        message: typeof error?.message === "string" ? error.message : "Codex turn failed",
        terminal: true,
      },
    ];
  }
  const item = asRecord(r.item);
  if (item === null) return [];
  // Tool activity is emitted once on start so it is not double-counted
  // against the completion record. Any non-message/reasoning item is a tool;
  // name it by its item.type, carry the most useful field as input.
  if (
    r.type === "item.started" &&
    typeof item.type === "string" &&
    !CODEX_NON_TOOL.has(item.type)
  ) {
    const name = item.type === "command_execution" ? "shell" : item.type;
    const input = item.command ?? item.changes ?? item.query ?? item.invocation ?? undefined;
    return [{ kind: "tool", name, input }];
  }
  if (r.type !== "item.completed") return [];
  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{ kind: "message", role: "assistant", text: item.text }];
  }
  if (item.type === "error" && typeof item.message === "string") {
    // Codex uses item errors for notices too. The item completing does not
    // establish turn failure; retain the diagnostic without inventing one.
    return [{ kind: "error", message: item.message }];
  }
  return [];
};

const pi = (r: Record<string, unknown>): ContentEvent[] => {
  // One clean tool event per invocation (the toolcall_start/delta/end and
  // tool_execution_update stream is noise; tool_execution_start fires once).
  if (r.type === "tool_execution_start" && typeof r.toolName === "string") {
    return [{ kind: "tool", name: r.toolName, input: r.args }];
  }
  if (r.type === "message_update") {
    const ev = asRecord(r.assistantMessageEvent);
    if (ev?.type === "text_delta" && typeof ev.delta === "string") {
      return [{ kind: "token", text: ev.delta }];
    }
    return [];
  }
  if (r.type === "message_end") {
    const message = asRecord(r.message);
    if (message?.role === "assistant") {
      // A turn that ends with stopReason "error" is a provider/auth/token
      // failure pi does NOT print to stderr and exits 0 for (verified with
      // an expired minimax token: empty content, stopReason error, clean
      // exit). Without this the failure is invisible - a silent empty turn.
      // It is also PROVISIONAL: pi retries inside one run (verified live on
      // pi 0.85.1, test/fixtures/harnesses/pi-terminated-recovered.ndjson:
      // resuming a session created under a different model/provider aborts
      // the first continuation once - errorMessage "terminated", pi's own
      // fetch-abort wording - then the next assistant message_end completes
      // the turn). The decoder therefore holds the terminal claim until no
      // successful assistant message can supersede it; the error-then-
      // nothing shape (minimax) still settles into a loud failure.
      if (message.stopReason === "error") {
        const msg =
          typeof message.errorMessage === "string"
            ? `pi turn ended with stopReason error: ${message.errorMessage}`
            : "pi turn ended with stopReason error (provider/auth failure)";
        return [
          {
            kind: "error",
            message: msg,
            terminal: true,
            provisional: true,
          },
        ];
      }
      const text = textOfBlocks(message.content);
      if (text !== "") return [{ kind: "message", role: "assistant", text }];
    }
  }
  return [];
};

const muse = (r: Record<string, unknown>): ContentEvent[] => {
  const payload = asRecord(r.payload);
  if (payload === null) return [];
  // Tool activity: muse emits a tool_result naming the tool in
  // correlation_facts.tool_name, with the command inside the result text.
  if (payload.kind === "tool_result") {
    const facts = asRecord(payload.correlation_facts);
    const name = typeof facts?.tool_name === "string" ? facts.tool_name : "tool";
    // Shell tools carry a JSON result with a `command`; file tools carry
    // plain prose. Surface the command when present, else leave input off
    // (the tool name is the signal that matters).
    let command: unknown;
    if (typeof payload.text === "string") {
      try {
        command = (JSON.parse(payload.text) as Record<string, unknown>).command;
      } catch {
        command = undefined;
      }
    }
    return [{ kind: "tool", name, input: command }];
  }
  if (payload.kind === "run_output_delta" && typeof payload.text === "string") {
    return [{ kind: "token", text: payload.text }];
  }
  if (payload.kind === "run_terminal") {
    if (
      payload.terminal === "completed" &&
      typeof payload.text === "string" &&
      payload.text !== ""
    ) {
      return [{ kind: "message", role: "assistant", text: payload.text }];
    }
    if (payload.terminal === "failed") {
      const reason = typeof payload.reason === "string" ? payload.reason : "run failed";
      // The muse reader is the muse-specific seam; no descriptor field
      // carries budget phrasings yet, so the pattern lives here.
      if (/did not reach a terminal state within \d+ step/i.test(reason)) {
        return [{ kind: "budget", detail: reason }];
      }
      return [{ kind: "error", message: `muse run failed: ${reason}`, terminal: true }];
    }
  }
  return [];
};

const compactDetail = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, 512);
  try {
    return JSON.stringify(value).slice(0, 512);
  } catch {
    return String(value).slice(0, 512);
  }
};

/** Antigravity stream-json contract. Permission errors are decoded
 * only from structured tool_info.error fields. General model prose is not
 * evidence that a native permission rule denied a call. */
const antigravity = (r: Record<string, unknown>): ContentEvent[] => {
  if (r.event === "step_update") {
    const step = asRecord(r.step_update);
    if (step === null) return [];
    if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
      return [{ kind: "token", text: step.text_delta }];
    }
    if (step.step_type !== "tool" || (step.state !== "DONE" && step.state !== "ERROR")) return [];

    const info = asRecord(step.tool_info);
    const name =
      typeof info?.name === "string"
        ? info.name
        : typeof step.tool_name === "string"
          ? step.tool_name
          : "tool";
    const tool: ContentEvent = {
      kind: "tool",
      name,
      ...(info !== null && Object.hasOwn(info, "parameters") ? { input: info.parameters } : {}),
    };
    const nativeError = info?.error;
    if (nativeError === undefined || nativeError === null) return [tool];

    const error = asRecord(nativeError);
    const type = typeof error?.type === "string" ? error.type : "";
    const reason = typeof error?.message === "string" ? error.message : compactDetail(nativeError);
    const isDenial = /permission|denied|rejected|not[_ -]?allowed/i.test(`${type} ${reason}`);
    return [
      tool,
      {
        kind: "error",
        message: `antigravity tool ${name} failed: ${reason}`,
        ...(isDenial ? { denial: { tool: name, reason } } : {}),
      },
    ];
  }

  if (r.event !== "result") return [];
  const result = asRecord(r.result);
  if (result === null) {
    return [{ kind: "error", message: "antigravity result was malformed", terminal: true }];
  }
  const status = typeof result.status === "string" ? result.status : "INVALID";
  if (status !== "SUCCESS") {
    const detail = Object.hasOwn(result, "error")
      ? compactDetail(result.error)
      : "no native error detail";
    return [
      {
        kind: "error",
        message: `antigravity turn ended with status ${status}: ${detail}`,
        terminal: true,
      },
    ];
  }
  return typeof result.response === "string" && result.response !== ""
    ? [{ kind: "message", role: "assistant", text: result.response }]
    : [];
};

/** Opaque per-reader decoder state (cursor only in v1): pending tool
 * call ids, tombstoned ids evicted from pending that must never re-emit
 * a tool event, completed ids that must not re-emit on a duplicate
 * completion, and query args by toolCallId for completions that arrive
 * with no preceding start. Owned by interpretation, threaded by execution
 * without inspection; reset per turn. Each collection is bounded
 * (drop-oldest) so a pathological turn cannot grow memory without bound.
 * Completions land in their own set precisely so settling normal calls
 * never pushes an evicted id out of the tombstones. */
export interface CursorReaderState {
  readonly pending: readonly string[];
  readonly tombstones: readonly string[];
  readonly completed: readonly string[];
  readonly queryArgs: readonly { readonly toolCallId: string; readonly args: unknown }[];
}

export const freshCursorReaderState = (): CursorReaderState => ({
  pending: [],
  tombstones: [],
  completed: [],
  queryArgs: [],
});

/** Per-harness reader state: cursor state for cursor, null otherwise.
 * Execution holds it without inspection (ADR 0005). */
export type ReaderState = CursorReaderState | null;

const STATE_FACTORIES: Record<HarnessName, () => ReaderState> = {
  claude: () => null,
  codex: () => null,
  pi: () => null,
  muse: () => null,
  cursor: freshCursorReaderState,
  antigravity: () => null,
};

export const freshReaderState = (harness: HarnessName): ReaderState => STATE_FACTORIES[harness]();

const assistantText = (r: Record<string, unknown>): string => {
  const message = asRecord(r.message);
  if (message === null) return "";
  return textOfBlocks(message.content);
};

/** One collection bound for every cursor reader map: drop-oldest past it. */
const CURSOR_STATE_BOUND = 128;

const boundedAdd = (ids: readonly string[], id: string): readonly string[] =>
  [...ids.filter((known) => known !== id), id].slice(-CURSOR_STATE_BOUND);

const boundedForget = (ids: readonly string[], id: string): readonly string[] =>
  ids.filter((known) => known !== id);

/** The native *ToolCall entry of a tool_call record, if it names one. */
const toolCallEntry = (
  r: Record<string, unknown>,
): { readonly name: string; readonly call: Record<string, unknown> } | null => {
  const toolCall = asRecord(r.tool_call);
  if (toolCall === null) return null;
  for (const [key, value] of Object.entries(toolCall)) {
    if (key.endsWith("ToolCall")) {
      const call = asRecord(value);
      if (call !== null) return { name: key, call };
    }
  }
  return null;
};

/** Query args recorded under one toolCallId, both observed paths: the id
 * sits beside args for ask/createPlan and inside args for web
 * fetch/search. A future query kind works without a code change. */
const queryRecordOf = (
  query: Record<string, unknown>,
): { readonly toolCallId: string; readonly args: unknown } | null => {
  for (const value of Object.values(query)) {
    const inner = asRecord(value);
    if (inner === null) continue;
    if (typeof inner.toolCallId === "string") {
      return { toolCallId: inner.toolCallId, args: asRecord(inner.args) ?? inner };
    }
    const args = asRecord(inner.args);
    if (args !== null && typeof args.toolCallId === "string") {
      return { toolCallId: args.toolCallId, args };
    }
  }
  return null;
};

/** Input for a completion with no preceding start: the recorded query
 * args matched by toolCallId, else the completion's own args, else none. */
const unknownInputOf = (
  state: CursorReaderState,
  r: Record<string, unknown>,
  entry: { readonly call: Record<string, unknown> },
): unknown => {
  const toolCall = asRecord(r.tool_call);
  const id =
    typeof toolCall?.toolCallId === "string"
      ? toolCall.toolCallId
      : typeof r.call_id === "string"
        ? r.call_id
        : null;
  const recorded = id === null ? undefined : state.queryArgs.find((q) => q.toolCallId === id)?.args;
  return recorded ?? asRecord(entry.call.args) ?? undefined;
};

const denialEvent = (tool: string, reason: string): ContentEvent => ({
  kind: "error",
  message:
    reason === "" ? `cursor denied ${tool} (no reason given)` : `cursor denied ${tool}: ${reason}`,
  denial: { tool, reason },
});

type ToolOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "rejected"; readonly reason: string };

const toolOutcome = (call: Record<string, unknown>): ToolOutcome | null => {
  const result = asRecord(call.result);
  if (result === null) return null;
  if (Object.hasOwn(result, "success")) return { kind: "success" };
  const rejected = asRecord(result.rejected);
  if (rejected === null) return null;
  const reason = typeof rejected.reason === "string" ? rejected.reason : "";
  return { kind: "rejected", reason };
};

const cursorWithState = (
  r: Record<string, unknown>,
  state: CursorReaderState,
): { readonly events: ContentEvent[]; readonly state: CursorReaderState } => {
  if (r.type === "retry" || r.type === "connection") {
    const label = typeof r.subtype === "string" ? r.subtype : r.type;
    return { events: [{ kind: "progress", label }], state };
  }
  if (r.type === "system") {
    // The init line is the identity announcement, handled upstream. Named
    // liveness lines surface as droppable progress; any other system
    // subtype is ignored like any unknown shape.
    if (r.subtype === "task_notification" || r.subtype === "background_shell_timeout") {
      return { events: [{ kind: "progress", label: r.subtype }], state };
    }
    return { events: [], state };
  }
  if (r.type === "tool_call" && r.subtype === "started") {
    // One tool event per invocation, on start (the pi/codex precedent).
    // No canonical mapping in v1: the tools surface is null, so the
    // native *ToolCall key is data. Ids evicted from pending by the bound
    // tombstone, so a late completion for them cannot double-count.
    const entry = toolCallEntry(r);
    if (typeof r.call_id !== "string" || entry === null) return { events: [], state };
    const args = asRecord(entry.call.args);
    const pending = boundedAdd(state.pending, r.call_id);
    const evicted = state.pending.filter((id) => !pending.includes(id));
    return {
      events: [{ kind: "tool", name: entry.name, ...(args !== null ? { input: args } : {}) }],
      state: {
        ...state,
        pending,
        tombstones: [...state.tombstones, ...evicted].slice(-CURSOR_STATE_BOUND),
      },
    };
  }
  if (r.type === "tool_call" && r.subtype === "completed") {
    const entry = toolCallEntry(r);
    const outcome = entry === null ? null : toolOutcome(entry.call);
    if (typeof r.call_id !== "string" || entry === null || outcome === null) {
      return { events: [], state };
    }
    const settled: CursorReaderState = {
      ...state,
      pending: boundedForget(state.pending, r.call_id),
      completed: boundedAdd(state.completed, r.call_id),
    };
    const seen =
      state.pending.includes(r.call_id) ||
      state.tombstones.includes(r.call_id) ||
      state.completed.includes(r.call_id);
    if (outcome.kind === "success") {
      // Success output is the model's context, not an event. Unknown ids
      // emit the tool event once (a forward rule for kinds that omit
      // started); tombstoned and completed ids never re-emit.
      if (seen) {
        return { events: [], state: settled };
      }
      const input = unknownInputOf(state, r, entry);
      return {
        events: [{ kind: "tool", name: entry.name, ...(input !== undefined ? { input } : {}) }],
        state: settled,
      };
    }
    if (seen) {
      // The tool event already fired at started (or the id finished
      // before): the denial error rides alone, never a second tool event.
      return { events: [denialEvent(entry.name, outcome.reason)], state: settled };
    }
    // A denial can land with no preceding started (probe 15): emit the
    // tool event first so no denial runs without one.
    const input = unknownInputOf(state, r, entry);
    return {
      events: [
        { kind: "tool", name: entry.name, ...(input !== undefined ? { input } : {}) },
        denialEvent(entry.name, outcome.reason),
      ],
      state: settled,
    };
  }
  if (r.type === "interaction_query") {
    // Handshake internals: record the query args by toolCallId for the
    // unknown-call_id rule above and emit nothing. Response records carry
    // no args and leave the state untouched.
    const query = asRecord(r.query);
    const found = query === null ? null : queryRecordOf(query);
    if (found === null) return { events: [], state };
    return {
      events: [],
      state: {
        ...state,
        queryArgs: [
          ...state.queryArgs.filter((q) => q.toolCallId !== found.toolCallId),
          found,
        ].slice(-CURSOR_STATE_BOUND),
      },
    };
  }
  if (r.type === "result") {
    // Success ends the turn with no event of its own (the runner owns
    // turn end); usage counts are ignored in v1 (no window, no usedPct).
    // Any other subtype, or is_error, is a forward rule to a terminal
    // error through the task failure path.
    if (r.subtype === "success" && r.is_error !== true) return { events: [], state };
    const subtype = typeof r.subtype === "string" ? r.subtype : "result error";
    return {
      events: [{ kind: "error", message: `cursor turn failed: ${subtype}`, terminal: true }],
      state,
    };
  }
  if (r.type === "assistant") {
    const text = assistantText(r);
    if (text === "") return { events: [], state };
    // Partial deltas carry timestamp_ms without model_call_id (probes 11,
    // 43); full-text segments carry model_call_id, with or without a
    // timestamp (probes 13/15), and so does the end-of-turn flush, which
    // carries neither field (probes 11/11b). Timestamp presence alone is
    // NOT the discriminator: plain-stream tool segments carry
    // timestamp_ms and would otherwise decode as tokens.
    if (typeof r.timestamp_ms === "number" && typeof r.model_call_id !== "string") {
      return { events: [{ kind: "token", text }], state };
    }
    return { events: [{ kind: "message", role: "assistant", text }], state };
  }
  return { events: [], state };
};

type StatefulReader = (
  r: Record<string, unknown>,
  state: ReaderState,
) => { readonly events: ContentEvent[]; readonly state: ReaderState };

const stateless =
  (read: (r: Record<string, unknown>) => ContentEvent[]): StatefulReader =>
  (r, state) => ({ events: read(r), state });

const STATEFUL_READERS: Record<HarnessName, StatefulReader> = {
  claude: stateless(claude),
  codex: stateless(codex),
  pi: stateless(pi),
  muse: stateless(muse),
  cursor: (r, state) => cursorWithState(r, state ?? freshCursorReaderState()),
  antigravity: stateless(antigravity),
};

/** Stateful entry point: every harness returns { events, state }.
 * decode.ts is the one production call site; contentEventsOf below keeps
 * the array shape for stateless callers. */
export const contentEventsWithState = (
  harness: HarnessName,
  raw: unknown,
  state: ReaderState,
): { readonly events: ContentEvent[]; readonly state: ReaderState } => {
  const record = asRecord(raw);
  if (record === null) return { events: [], state };
  return STATEFUL_READERS[harness](record, state);
};

export const contentEventsOf = (harness: HarnessName, raw: unknown): ContentEvent[] =>
  contentEventsWithState(harness, raw, freshReaderState(harness)).events;
