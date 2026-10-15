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
}

type Counts = Omit<UsageEvent, "kind" | "scope" | "inputIncludesCache" | "callId" | "model">;
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
const CODEX_SESSION_FIELDS: Fields = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  cacheReadTokens: "cachedInputTokens",
  cacheWriteTokens: "cacheWriteInputTokens",
  reasoningTokens: "reasoningOutputTokens",
  totalTokens: "totalTokens",
};

function usageEvent(
  value: unknown,
  fields: Fields,
  scope: UsageEvent["scope"],
  inputIncludesCache?: boolean,
  callId?: unknown,
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
      ...(inputIncludesCache === undefined ? {} : { inputIncludesCache }),
      ...(typeof callId === "string" ? { callId } : {}),
    },
  ];
}

export function usageEventsOf(harness: HarnessName, r: Record<string, unknown>): UsageEvent[] {
  switch (harness) {
    case "pi": {
      if (r.type === "compaction_end")
        return usageEvent(readPath(r, "result.usage"), PI_FIELDS, "compaction", false);
      if (r.type !== "message_end") return [];
      const message = asRecord(r.message);
      if (message?.role === "assistant")
        return usageEvent(message.usage, PI_FIELDS, "message", false);
      // Read the echoed tool message's optional usage once, not again
      // from its execution-end result.
      if (message?.role === "toolResult")
        return usageEvent(message.usage, PI_FIELDS, "tool", false, message.toolCallId);
      return [];
    }
    case "claude":
      if (r.type !== "result") return [];
      // Result tokens cover this turn, but total_cost_usd includes restored
      // session spend and subagents. Keep the scopes separate.
      return [
        ...usageEvent(r.usage, SNAKE_FIELDS, "turn", false),
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
            false,
          ).map((event) => ({ ...event, model })),
        ),
      ];
    case "codex":
      // Codex exec emits ThreadTokenUsage.total at turn completion, including restored turns.
      if (r.type === "turn.completed") return usageEvent(r.usage, CODEX_FIELDS, "session", true);
      if (r.method === "thread/tokenUsage/updated")
        return usageEvent(
          readPath(r, "params.tokenUsage.total"),
          CODEX_SESSION_FIELDS,
          "session",
          true,
        );
      return [];
    case "cursor":
      return r.type === "result" ? usageEvent(r.usage, CURSOR_FIELDS, "turn", false) : [];
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
  }
}
