/** Successful native turn delimiters, not assistant-message heuristics.
 * These are the same wire shapes the content/session readers consume. */
import type { HarnessName } from "../knowledge/descriptor.js";
import { asRecord, readPath as at } from "./shape.js";

export const successfulTurnEnd = (harness: HarnessName, raw: unknown): boolean => {
  const r = asRecord(raw);
  if (r === null) return false;
  switch (harness) {
    case "claude":
      return r.type === "result" && r.subtype === "success" && r.is_error !== true;
    case "cursor":
      // The SDK worker envelope's terminal record (issue #440): a finished
      // Run.wait status is the native success delimiter.
      if (r.hcn === "turn-end") return r.status === "finished";
      return r.type === "result" && r.subtype === "success" && r.is_error !== true;
    case "pi":
      return r.type === "agent_settled" && r.aborted !== true;
    case "codex":
      return r.type === "turn.completed";
    case "muse": {
      const payload = asRecord(r.payload);
      return payload?.kind === "run_terminal" && payload.terminal === "completed";
    }
    case "antigravity":
      return r.event === "result" && asRecord(r.result)?.status === "SUCCESS";
    case "popeye":
      return r.kind === "done" && r.cause === "clean";
    case "opencode":
      // The turn's own delimiter: the final `step_finish`, whose reason
      // is `stop` (a mid-turn step finishes with `tool-calls`).
      return r.type === "step_finish" && at(r, "part.reason") === "stop";
  }
};
