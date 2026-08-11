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
import type { HarnessName } from "../knowledge/descriptor.js";
import { asRecord } from "./shape.js";

export type ContentEvent =
  | { readonly kind: "token"; readonly text: string }
  | { readonly kind: "message"; readonly role: string; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input?: unknown }
  | { readonly kind: "progress"; readonly label: string }
  | { readonly kind: "error"; readonly message: string };

/** Text of an array of `{type:"text", text}` content blocks. */
const textOfBlocks = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((b) => asRecord(b))
        .filter((b): b is Record<string, unknown> => b !== null && b.type === "text")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("")
    : "";

const at = (record: Record<string, unknown>, path: string): unknown => {
  let cursor: unknown = record;
  for (const seg of path.split(".")) {
    const inner = asRecord(cursor);
    if (inner === null) return undefined;
    cursor = inner[seg];
  }
  return cursor;
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
    // Non-init system lines (hook_started etc.) surface as droppable
    // progress, as the pre-refactor decoder did. The init line is the
    // identity announcement, handled upstream.
    events.push({ kind: "progress", label: r.subtype });
  }
  return events;
};

const codex = (r: Record<string, unknown>): ContentEvent[] => {
  const item = asRecord(r.item);
  if (item === null) return [];
  // Tool activity: a command_execution invocation, emitted once on start so
  // it is not double-counted against the completion record.
  if (r.type === "item.started" && item.type === "command_execution") {
    return [{ kind: "tool", name: "shell", input: item.command }];
  }
  if (r.type !== "item.completed") return [];
  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{ kind: "message", role: "assistant", text: item.text }];
  }
  if (item.type === "error" && typeof item.message === "string") {
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
      return [{ kind: "error", message: `muse run failed: ${reason}` }];
    }
  }
  return [];
};

const READERS: Record<HarnessName, (r: Record<string, unknown>) => ContentEvent[]> = {
  claude,
  codex,
  pi,
  muse,
};

export const contentEventsOf = (harness: HarnessName, raw: unknown): ContentEvent[] => {
  const record = asRecord(raw);
  if (record === null) return [];
  return READERS[harness](record);
};
