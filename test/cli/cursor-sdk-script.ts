/**
 * The tiny test-only helper for the Cursor parity tests: derive a valid
 * SDK callback/stream script from raw Cursor CLI fixture text. The
 * derivation reads the fixture's own fields (timestamp/model_call_id
 * discriminator, tool args/results, usage counters) - never the legacy
 * oracle's output - and fabricates no native event: the CLI's
 * system/task_notification bookkeeping has no SDK stream/callback
 * equivalent and is skipped (SDK 1.0.38 raises task records, not
 * notifications; its SDKTaskMessage comes from the run summary).
 */
type Line = Record<string, unknown>;
type ScriptEntry = Record<string, unknown>;

const assistantTextOf = (record: Line): string => {
  const message = record.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => block as { type?: string; text?: unknown })
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
};

/** The native SDK tool name for a legacy `<name>ToolCall` protocol key
 * (readToolCall -> read): the two protocols name tools differently and the
 * comparison asserts each side's literal native spelling. */
const sdkToolNameOf = (toolCallKey: string): string =>
  `${toolCallKey[0]?.toLowerCase() ?? ""}${toolCallKey.replace(/ToolCall$/, "").slice(1)}`;

/** The tool_call entry of a legacy record: its one `<name>ToolCall` key. */
const toolCallEntryOf = (record: Line): { key: string; call: Record<string, unknown> } | null => {
  const toolCall = record.tool_call as Record<string, unknown> | undefined;
  if (toolCall === undefined) return null;
  for (const [key, value] of Object.entries(toolCall)) {
    if (key.endsWith("ToolCall")) {
      return { key, call: (value ?? {}) as Record<string, unknown> };
    }
  }
  return null;
};

/** The SDK-native result wrapper derived from a legacy tool result, using
 * the field mapping the SDK's own converter applies (read success keeps
 * content/totalLines/fileSize; a rejected call becomes the SDK's
 * status:error wrapper - the reason text survives as error.message, the
 * rejection category does not). */
const sdkResultOf = (legacyResult: unknown): Record<string, unknown> | undefined => {
  if (typeof legacyResult !== "object" || legacyResult === null) return undefined;
  const result = legacyResult as Record<string, unknown>;
  const success = result.success as Record<string, unknown> | undefined;
  if (success !== undefined) {
    const value: Record<string, unknown> = {};
    for (const field of ["content", "totalLines", "fileSize"]) {
      if (typeof success[field] === "number" || typeof success[field] === "string") {
        value[field] = success[field];
      }
    }
    return { status: "success", value };
  }
  const rejected = result.rejected as { reason?: unknown } | undefined;
  if (rejected !== undefined) {
    return {
      status: "error",
      error: {
        message: typeof rejected.reason === "string" ? rejected.reason : "Command rejected",
      },
    };
  }
  if (result.error != null) {
    return { status: "error", error: { message: String(result.error) } };
  }
  return undefined;
};

/**
 * Derive a valid SDK callback/stream script from the raw CLI fixture text.
 * The discriminator is the fixture's own field evidence: assistant records
 * with timestamp_ms and no model_call_id are token fragments (SDK
 * text-delta), all other assistant records are complete messages (SDK
 * onStep); tool_call started/completed map onto the SDK's stream tool_call
 * records (with the completed delta that natively precedes each one);
 * the success result record maps onto the SDK's usage record, whose
 * totalTokens the SDK computes itself. Thinking deltas ride as
 * thinking-delta callbacks and the user echo as the user-message-appended
 * delta - the worker ignores both, exactly as it ignores the legacy
 * records. The CLI's system bookkeeping (init, task_notification) has no
 * SDK stream/callback equivalent and is skipped, never fabricated.
 */
export const deriveSdkScript = (lines: readonly Line[]): ScriptEntry[] => {
  const events: ScriptEntry[] = [];
  for (const record of lines) {
    const type = record.type;
    if (type === "assistant") {
      const text = assistantTextOf(record);
      if (text === "") continue;
      if (typeof record.timestamp_ms === "number" && typeof record.model_call_id !== "string") {
        events.push({ delta: { type: "text-delta", text } });
      } else {
        events.push({ step: { type: "assistantMessage", message: { text } } });
      }
      continue;
    }
    if (type === "tool_call") {
      const entry = toolCallEntryOf(record);
      if (entry === null || typeof record.call_id !== "string") continue;
      const name = sdkToolNameOf(entry.key);
      const args = entry.call.args as Record<string, unknown> | undefined;
      if (record.subtype === "started") {
        events.push({
          stream: {
            type: "tool_call",
            call_id: record.call_id,
            name,
            status: "running",
            ...(args === undefined ? {} : { args }),
          },
        });
        continue;
      }
      if (record.subtype === "completed") {
        const result = sdkResultOf(entry.call.result);
        // The completed onDelta update natively precedes its stream record.
        events.push({
          delta: {
            type: "tool-call-completed",
            callId: record.call_id,
            toolCall: {
              type: name,
              ...(args === undefined ? {} : { args }),
              ...(result === undefined ? {} : { result }),
            },
          },
        });
        events.push({
          stream: {
            type: "tool_call",
            call_id: record.call_id,
            name,
            status: "completed",
            ...(args === undefined ? {} : { args }),
            ...(result === undefined ? {} : { result }),
          },
        });
      }
      continue;
    }
    if (type === "thinking" && record.subtype === "delta" && typeof record.text === "string") {
      events.push({ delta: { type: "thinking-delta", text: record.text } });
      continue;
    }
    if (type === "user") {
      const text = assistantTextOf(record);
      if (text !== "") {
        events.push({ delta: { type: "user-message-appended", userMessage: { text } } });
      }
      continue;
    }
    if (type === "result" && record.subtype === "success") {
      const usage = record.usage as Record<string, number> | undefined;
      if (usage === undefined) continue;
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      events.push({
        stream: {
          type: "usage",
          usage: {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            // The SDK computes the total itself (input+output+cacheRead+cacheWrite).
            totalTokens: input + output + cacheRead + cacheWrite,
          },
        },
      });
    }
  }
  return events;
};
