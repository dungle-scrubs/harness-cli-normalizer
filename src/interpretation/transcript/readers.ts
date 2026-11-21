import {
  ANTIGRAVITY_TRANSCRIPT,
  ANTIGRAVITY_TRANSCRIPT_EVIDENCE,
  ANTIGRAVITY_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/antigravity.js";
import {
  CLAUDE_TRANSCRIPT,
  CLAUDE_TRANSCRIPT_EVIDENCE,
  CLAUDE_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/claude.js";
import {
  CODEX_HISTORICAL_LOSS,
  CODEX_TRANSCRIPT,
  CODEX_TRANSCRIPT_EVIDENCE,
  CODEX_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/codex.js";
import {
  CURSOR_TRANSCRIPT,
  CURSOR_TRANSCRIPT_EVIDENCE,
  CURSOR_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/cursor.js";
import {
  MUSE_TRANSCRIPT,
  MUSE_TRANSCRIPT_EVIDENCE,
  MUSE_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/muse.js";
import {
  PI_TRANSCRIPT,
  PI_TRANSCRIPT_EVIDENCE,
  PI_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/pi.js";
import type { Build, Evidence } from "../../knowledge/transcript/schema.js";
import { TRANSCRIPT_SNAPSHOT } from "../../knowledge/transcript/snapshot.js";
import type {
  BranchObservation,
  HistoricalLoss,
  Method,
  RecordEnvelope,
  Relation,
  Rule,
  TranscriptKnowledge,
} from "../../knowledge/transcript/wire.js";
import {
  antigravityConversationId,
  antigravityLogPath,
  normalizeAntigravity,
  parseAntigravityHistory,
} from "./antigravity.js";
import type { Bookmark } from "./bookmark.js";
import { decodeBookmark, encodeBookmark } from "./bookmark.js";
import { claudeBranch, normalizeClaude, parseClaudeHistory } from "./claude.js";
import {
  codexBase,
  codexNativeId,
  codexWriterBuild,
  normalizeCodex,
  parseCodexHistory,
  validateCodexBase,
} from "./codex.js";
import { frameCursorStore, normalizeCursor, parseCursorHistory } from "./cursor.js";
import { object, string } from "./json.js";
import { normalizeMuse, parseMuseHistory } from "./muse.js";
import type { NativeBase, NativeEntry, NativeHistory } from "./native.js";
import { normalizePi, parsePiHistory, piBranch } from "./pi.js";

export interface TranscriptReader {
  readonly consistency: "append-only" | "snapshot";
  readonly ancestry?: {
    base(history: NativeHistory): NativeBase | null;
    validate(history: NativeHistory, base: NativeBase): void;
  };
  readonly lookup: {
    readonly directories: readonly string[];
    readonly recursive: boolean;
    matches(name: string, id: string): boolean;
    /** The one path an ID can name, relative to the store root; null when the ID cannot name any. */
    locate?(id: string): string | null;
  };
  /** Projects a native container onto LF-framed JSON entries; absent for JSONL sources. */
  readonly frame?: (bytes: Uint8Array) => Uint8Array;
  /** Sibling path suffixes that must be absent or empty around the capture. */
  readonly quiescentSiblings?: readonly string[];
  readonly method: Method;
  readonly historicalLoss: HistoricalLoss;
  readonly evidence: Evidence;
  readonly rules: readonly Rule[];
  readonly consistencyRuleIds: readonly string[];
  readonly continuation: {
    readonly ruleIds: readonly string[];
    decode(token: string): Bookmark;
    encode(value: Omit<Bookmark, "methodId" | "bookmarkVersion">): string;
  } | null;
  /** The writer build one source's own header names, where the format carries
   * one; absent where it does not. */
  readonly writerBuild?: (history: NativeHistory) => Build;
  branch(history: NativeHistory, id: string): BranchObservation;
  nativeId(history: NativeHistory, path: string): string;
  normalize(entry: NativeEntry, id: string): RecordEnvelope;
  parse(bytes: string | Uint8Array): NativeHistory;
}
function methodRules(
  knowledge: TranscriptKnowledge,
  method: Method,
): Pick<TranscriptReader, "method" | "rules" | "consistencyRuleIds" | "continuation"> {
  const rules = knowledge.rules.filter((rule) => method.ruleIds.includes(rule.id));
  return {
    method,
    rules,
    consistencyRuleIds: rules
      .filter((rule) => rule.purpose === "consistency")
      .map((rule) => rule.id),
    continuation: {
      ruleIds: rules.filter((rule) => rule.purpose === "continuation").map((rule) => rule.id),
      decode: (token) => decodeBookmark(token, method.id),
      encode: (value) => encodeBookmark({ ...value, methodId: method.id, bookmarkVersion: 1 }),
    },
  };
}
const noBranch = (): BranchObservation => ({
  evidence: [],
  selection: null,
  state: "unknown",
  view: "unknown",
});
export function recordFromSource(record: RecordEnvelope, sourceKey: string): RecordEnvelope {
  const relocate = (relation: Relation): Relation => ({
    ...relation,
    targets: relation.targets.map((target) => ({
      ...target,
      scope: { ...target.scope, sourceKey: target.scope.sourceKey === null ? null : sourceKey },
      position: target.position ? { ...target.position, sourceKey } : null,
    })),
  });
  const relations = record.normalized.relationships;
  return {
    ...record,
    sourceKey,
    position: record.position ? { ...record.position, sourceKey } : null,
    normalized: {
      ...record.normalized,
      relationships: {
        "branch-origin": relocate(relations["branch-origin"]),
        "first-kept-entry": relocate(relations["first-kept-entry"]),
        "parent-conversation": relocate(relations["parent-conversation"]),
        "parent-entry": relocate(relations["parent-entry"]),
        "tool-call": relocate(relations["tool-call"]),
      },
    },
  };
}
export function readerForMethod(method: Method): TranscriptReader | null {
  if (method.id === MUSE_TRANSCRIPT_METHOD.id) {
    return {
      ...methodRules(MUSE_TRANSCRIPT, method),
      consistency: TRANSCRIPT_SNAPSHOT.consistency,
      branch: noBranch,
      lookup: {
        directories: [""],
        recursive: true,
        matches: (name, id) => name.endsWith(`/${id}/session.jsonl`),
      },
      historicalLoss: { state: "unknown", details: [], evidence: [MUSE_TRANSCRIPT_EVIDENCE] },
      evidence: MUSE_TRANSCRIPT_EVIDENCE,
      nativeId: (history) => string(object(history.identityRecord.stream)?.id) ?? "",
      normalize: normalizeMuse,
      parse: parseMuseHistory,
    };
  }
  if (method.id === CLAUDE_TRANSCRIPT_METHOD.id) {
    return {
      ...methodRules(CLAUDE_TRANSCRIPT, method),
      consistency: TRANSCRIPT_SNAPSHOT.consistency,
      branch: claudeBranch,
      lookup: {
        directories: [""],
        recursive: true,
        matches: (name, id) => name.split("/").at(-1) === `${id}.jsonl`,
      },
      historicalLoss: { state: "unknown", details: [], evidence: [CLAUDE_TRANSCRIPT_EVIDENCE] },
      evidence: CLAUDE_TRANSCRIPT_EVIDENCE,
      nativeId: (history) => string(history.identityRecord.sessionId) ?? "",
      normalize: normalizeClaude,
      parse: parseClaudeHistory,
    };
  }
  if (method.id === PI_TRANSCRIPT_METHOD.id) {
    return {
      ...methodRules(PI_TRANSCRIPT, method),
      consistency: "append-only",
      branch: piBranch,
      lookup: {
        directories: [""],
        recursive: false,
        matches: (name, id) => name.endsWith(`_${id}.jsonl`),
      },
      historicalLoss: { state: "unknown", details: [], evidence: [] },
      evidence: PI_TRANSCRIPT_EVIDENCE,
      nativeId: (history) => string(history.identityRecord.id) ?? "",
      normalize: normalizePi,
      parse: parsePiHistory,
    };
  }
  if (method.id === CODEX_TRANSCRIPT_METHOD.id) {
    return {
      ...methodRules(CODEX_TRANSCRIPT, method),
      consistency: "append-only",
      ancestry: { base: codexBase, validate: validateCodexBase },
      branch: noBranch,
      lookup: {
        directories: ["sessions", "archived_sessions"],
        recursive: true,
        matches: (name, id) =>
          /^rollout-/.test(name.split("/").at(-1) ?? "") &&
          (name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`)),
      },
      historicalLoss: CODEX_HISTORICAL_LOSS,
      evidence: CODEX_TRANSCRIPT_EVIDENCE,
      nativeId: codexNativeId,
      normalize: normalizeCodex,
      parse: parseCodexHistory,
      writerBuild: codexWriterBuild,
    };
  }
  if (method.id === CURSOR_TRANSCRIPT_METHOD.id) {
    return {
      ...methodRules(CURSOR_TRANSCRIPT, method),
      consistency: TRANSCRIPT_SNAPSHOT.consistency,
      branch: noBranch,
      frame: frameCursorStore,
      quiescentSiblings: ["-wal", "-journal"],
      lookup: {
        directories: ["chats"],
        recursive: true,
        matches: (name, id) => name.endsWith(`/${id}/store.db`),
      },
      historicalLoss: { state: "unknown", details: [], evidence: [CURSOR_TRANSCRIPT_EVIDENCE] },
      evidence: CURSOR_TRANSCRIPT_EVIDENCE,
      nativeId: (history) => string(history.identityRecord.agentId) ?? "",
      normalize: normalizeCursor,
      parse: parseCursorHistory,
    };
  }
  if (method.id === ANTIGRAVITY_TRANSCRIPT_METHOD.id) {
    return {
      ...methodRules(ANTIGRAVITY_TRANSCRIPT, method),
      consistency: TRANSCRIPT_SNAPSHOT.consistency,
      branch: noBranch,
      lookup: {
        directories: [""],
        recursive: false,
        matches: () => false,
        locate: antigravityLogPath,
      },
      historicalLoss: {
        state: "unknown",
        details: [],
        evidence: [ANTIGRAVITY_TRANSCRIPT_EVIDENCE],
      },
      evidence: ANTIGRAVITY_TRANSCRIPT_EVIDENCE,
      nativeId: (_history, path) => antigravityConversationId(path),
      normalize: normalizeAntigravity,
      parse: parseAntigravityHistory,
    };
  }
  return null;
}
