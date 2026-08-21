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
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "budget"; readonly detail: string };

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
  } else if (r.type === "result" && r.is_error === true) {
    // A result line marked is_error is a failed turn (max-turns, execution
    // error) - surface it so a streamTurn consumer sees the failure, not a
    // clean turn. (openSession handles result boundaries itself.)
    const sub = typeof r.subtype === "string" ? r.subtype : "result error";
    events.push({ kind: "error", message: `turn failed: ${sub}` });
  }
  return events;
};

// codex item types that are NOT tool activity - everything else on
// item.started is a tool of some kind (command_execution, file_change,
// mcp_tool_call, web_search, ...), surfaced generically by item.type.
const CODEX_NON_TOOL = new Set(["agent_message", "error", "reasoning", "todo_list"]);

const codex = (r: Record<string, unknown>): ContentEvent[] => {
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
      if (message.stopReason === "error") {
        return [
          { kind: "error", message: "pi turn ended with stopReason error (provider/auth failure)" },
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
