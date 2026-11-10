import type { HarnessName } from "../knowledge/descriptor.js";
import { asRecord, readPath } from "./shape.js";

/** Native accounting observations, not hcn estimates or billing data.
 * Message/tool/compaction counts are per completed operation. Turn counts
 * cover the main loop; session counts are cumulative snapshots, not deltas.
 * Cache counts can overlap input; reasoning counts are a subset of output.
 * Missing fields stay missing, including an unknown cache relationship. */
export interface UsageEvent {
  readonly kind: "usage";
  readonly scope: "message" | "turn" | "session" | "compaction" | "tool";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly inputIncludesCache?: boolean;
  readonly callId?: string;
  readonly model?: string;
  /** The distinct models the harness attested for the counted work, in
   * first-seen order (issue #456, review round 4, J2). Claude's
   * turn-scoped event carries the turn's main-loop models whenever at
   * least one was attested; `model` above singles one out only when the
   * list holds exactly one. */
  readonly models?: readonly string[];
}

type Counts = Omit<
  UsageEvent,
  "kind" | "scope" | "inputIncludesCache" | "callId" | "model" | "models"
>;
type Fields = Readonly<Partial<Record<keyof Counts, string>>>;
const PI_FIELDS: Fields = {
  inputTokens: "input",
  outputTokens: "output",
  cacheReadTokens: "cacheRead",
  cacheWriteTokens: "cacheWrite",
  reasoningTokens: "reasoning",
  totalTokens: "totalTokens",
  costUsd: "cost.total",
};
const SNAKE_FIELDS: Fields = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens",
};
const CODEX_FIELDS: Fields = {
  ...SNAKE_FIELDS,
  cacheReadTokens: "cached_input_tokens",
  cacheWriteTokens: "cache_write_input_tokens",
  reasoningTokens: "reasoning_output_tokens",
};
const CURSOR_FIELDS: Fields = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  cacheReadTokens: "cacheReadTokens",
  cacheWriteTokens: "cacheWriteTokens",
};
/** The OpenCode CLI reports one step's counts on its `step_finish` part
 * (`part.tokens`), with the step's cost beside them (`part.cost`). The
 * counts are that step's own, not a running total, so a turn's spend is
 * the sum over its steps - which the caller does, hcn reports none. */
const OPENCODE_FIELDS: Fields = {
  inputTokens: "part.tokens.input",
  outputTokens: "part.tokens.output",
  reasoningTokens: "part.tokens.reasoning",
  totalTokens: "part.tokens.total",
  cacheReadTokens: "part.tokens.cache.read",
  cacheWriteTokens: "part.tokens.cache.write",
  costUsd: "part.cost",
};
const CODEX_SESSION_FIELDS: Fields = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  cacheReadTokens: "cachedInputTokens",
  cacheWriteTokens: "cacheWriteInputTokens",
  reasoningTokens: "reasoningOutputTokens",
  totalTokens: "totalTokens",
};

/** The optional identity fields one usage observation can carry:
 * whether input already includes cache counts, the tool call a `tool`
 * scope belongs to, and the model the harness attested for the
 * counted work. */
interface UsageEventFields {
  readonly inputIncludesCache?: boolean;
  readonly callId?: unknown;
  readonly model?: unknown;
  readonly models?: readonly string[];
}

function usageEvent(
  value: unknown,
  fields: Fields,
  scope: UsageEvent["scope"],
  options: UsageEventFields = {},
): UsageEvent[] {
  const record = asRecord(value);
  if (record === null) return [];
  const counts: Record<string, number> = {};
  for (const [key, path] of Object.entries(fields)) {
    const count = readPath(record, path);
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
    if (key !== "costUsd" && !Number.isSafeInteger(count)) continue;
    counts[key] = count;
  }
  if (Object.keys(counts).length === 0) return [];
  return [
    {
      kind: "usage",
      scope,
      ...counts,
      ...(options.inputIncludesCache === undefined
        ? {}
        : { inputIncludesCache: options.inputIncludesCache }),
      ...(typeof options.callId === "string" ? { callId: options.callId } : {}),
      ...(typeof options.model === "string" && options.model !== ""
        ? { model: options.model }
        : {}),
      ...(options.models !== undefined && options.models.length > 0
        ? { models: options.models }
        : {}),
    },
  ];
}

/** `turnModels`: the distinct models the harness attested for this
 * turn's assistant messages, when the caller tracked them (issue #456,
 * review round 1 F10 - a Claude result record carries no model of its
 * own; round 3 H1 and round 4 J2 - the turn-scoped event carries the
 * list whenever at least one was attested and singles out `model` only
 * when exactly one was). Pi's assistant messages attest the model on
 * the same record, so its message-scoped events read it directly. */
export function usageEventsOf(
  harness: HarnessName,
  r: Record<string, unknown>,
  turnModels?: readonly string[],
): UsageEvent[] {
  switch (harness) {
    case "pi": {
      if (r.type === "compaction_end")
        return usageEvent(readPath(r, "result.usage"), PI_FIELDS, "compaction", {
          inputIncludesCache: false,
        });
      if (r.type !== "message_end") return [];
      const message = asRecord(r.message);
      if (message?.role === "assistant")
        return usageEvent(message.usage, PI_FIELDS, "message", {
          inputIncludesCache: false,
          model: message.model,
        });
      // Read the echoed tool message's optional usage once, not again
      // from its execution-end result.
      if (message?.role === "toolResult")
        return usageEvent(message.usage, PI_FIELDS, "tool", {
          inputIncludesCache: false,
          callId: message.toolCallId,
        });
      return [];
    }
    case "claude":
      if (r.type !== "result") return [];
      // Result tokens cover this turn, but total_cost_usd includes restored
      // session spend and subagents. Keep the scopes separate.
      return [
        ...usageEvent(r.usage, SNAKE_FIELDS, "turn", {
          inputIncludesCache: false,
          ...(turnModels !== undefined && turnModels.length === 1 ? { model: turnModels[0] } : {}),
          ...(turnModels !== undefined && turnModels.length > 0 ? { models: turnModels } : {}),
        }),
        ...usageEvent(r, { costUsd: "total_cost_usd" }, "session"),
        ...Object.entries(asRecord(r.modelUsage) ?? {}).flatMap(([model, usage]) =>
          usageEvent(
            usage,
            {
              inputTokens: "inputTokens",
              outputTokens: "outputTokens",
              cacheReadTokens: "cacheReadInputTokens",
              cacheWriteTokens: "cacheCreationInputTokens",
              costUsd: "costUSD",
            },
            "session",
            { inputIncludesCache: false },
          ).map((event) => ({ ...event, model })),
        ),
      ];
    case "codex":
      // Codex exec emits ThreadTokenUsage.total at turn completion, including restored turns.
      if (r.type === "turn.completed")
        return usageEvent(r.usage, CODEX_FIELDS, "session", { inputIncludesCache: true });
      if (r.method === "thread/tokenUsage/updated")
        return usageEvent(readPath(r, "params.tokenUsage.total"), CODEX_SESSION_FIELDS, "session", {
          inputIncludesCache: true,
        });
      return [];
    case "cursor":
      return r.type === "result"
        ? usageEvent(r.usage, CURSOR_FIELDS, "turn", { inputIncludesCache: false })
        : [];
    case "antigravity":
      return r.event === "result"
        ? usageEvent(
            readPath(r, "result.usage"),
            {
              ...SNAKE_FIELDS,
              cacheReadTokens: "cache_read_tokens",
              reasoningTokens: "thinking_tokens",
              totalTokens: "total_tokens",
            },
            "session",
          )
        : [];
    case "muse":
    case "popeye":
      return [];
    case "opencode":
      // One usage event per step, scoped to the message the step
      // produced: each step reports its own model call, input excluding
      // cache. Consecutive steps overlap by the prior context whenever the
      // provider cache misses (big-pickle re-billed ~16k input on step 2
      // in test/fixtures/opencode-1.19.5/tool-use.jsonl), so summing
      // input or total across a turn's steps overcounts; only cost sums.
      return r.type === "step_finish"
        ? usageEvent(r, OPENCODE_FIELDS, "message", { inputIncludesCache: false })
        : [];
  }
}
