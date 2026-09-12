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
  MUSE_TRANSCRIPT,
  MUSE_TRANSCRIPT_EVIDENCE,
  MUSE_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/muse.js";
import {
  PI_TRANSCRIPT,
  PI_TRANSCRIPT_EVIDENCE,
  PI_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/pi.js";
import type { Evidence } from "../../knowledge/transcript/schema.js";
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
import type { Bookmark } from "./bookmark.js";
import { decodeBookmark, encodeBookmark } from "./bookmark.js";
import { claudeBranch, normalizeClaude, parseClaudeHistory } from "./claude.js";
import {
  codexBase,
  codexNativeId,
  normalizeCodex,
  parseCodexHistory,
  validateCodexBase,
} from "./codex.js";
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
  };
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
  readonly writerVersion: string | null;
  branch(history: NativeHistory, id: string): BranchObservation;
  nativeId(history: NativeHistory): string;
  normalize(entry: NativeEntry, id: string): RecordEnvelope;
  parse(bytes: string | Uint8Array): NativeHistory;
}
function rulesFor(knowledge: TranscriptKnowledge, method: Method): readonly Rule[] {
  return knowledge.rules.filter((rule) => method.ruleIds.includes(rule.id));
}
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
    const rules = rulesFor(MUSE_TRANSCRIPT, method);
    return {
      consistency: TRANSCRIPT_SNAPSHOT.consistency,
      method,
      branch: () => ({ evidence: [], selection: null, state: "unknown", view: "unknown" }),
      lookup: {
        directories: [""],
        recursive: true,
        matches: (name, id) => name.endsWith(`/${id}/session.jsonl`),
      },
      historicalLoss: { state: "unknown", details: [], evidence: [MUSE_TRANSCRIPT_EVIDENCE] },
      evidence: MUSE_TRANSCRIPT_EVIDENCE,
      rules,
      consistencyRuleIds: rules
        .filter((rule) => rule.purpose === "consistency")
        .map((rule) => rule.id),
      continuation: {
        ruleIds: rules.filter((rule) => rule.purpose === "continuation").map((rule) => rule.id),
        decode: (token) => decodeBookmark(token, method.id),
        encode: (value) => encodeBookmark({ ...value, methodId: method.id, bookmarkVersion: 1 }),
      },
      nativeId: (history) => string(object(history.identityRecord.stream)?.id) ?? "",
      normalize: normalizeMuse,
      parse: parseMuseHistory,
      writerVersion: null,
    };
  }
  if (method.id === CLAUDE_TRANSCRIPT_METHOD.id) {
    const rules = rulesFor(CLAUDE_TRANSCRIPT, method);
    return {
      consistency: TRANSCRIPT_SNAPSHOT.consistency,
      method,
      branch: claudeBranch,
      lookup: {
        directories: [""],
        recursive: true,
        matches: (name, id) => name.split("/").at(-1) === `${id}.jsonl`,
      },
      historicalLoss: { state: "unknown", details: [], evidence: [CLAUDE_TRANSCRIPT_EVIDENCE] },
      evidence: CLAUDE_TRANSCRIPT_EVIDENCE,
      rules,
      consistencyRuleIds: rules
        .filter((rule) => rule.purpose === "consistency")
        .map((rule) => rule.id),
      continuation: {
        ruleIds: rules.filter((rule) => rule.purpose === "continuation").map((rule) => rule.id),
        decode: (token) => decodeBookmark(token, method.id),
        encode: (value) => encodeBookmark({ ...value, methodId: method.id, bookmarkVersion: 1 }),
      },
      nativeId: (history) => string(history.identityRecord.sessionId) ?? "",
      normalize: normalizeClaude,
      parse: parseClaudeHistory,
      writerVersion: null,
    };
  }
  if (method.id === PI_TRANSCRIPT_METHOD.id) {
    const rules = rulesFor(PI_TRANSCRIPT, method);
    return {
      consistency: "append-only",
      method,
      branch: piBranch,
      lookup: {
        directories: [""],
        recursive: false,
        matches: (name, id) => name.endsWith(`_${id}.jsonl`),
      },
      historicalLoss: { state: "unknown", details: [], evidence: [] },
      evidence: PI_TRANSCRIPT_EVIDENCE,
      rules,
      consistencyRuleIds: rules
        .filter((rule) => rule.purpose === "consistency")
        .map((rule) => rule.id),
      continuation: {
        ruleIds: rules.filter((rule) => rule.purpose === "continuation").map((rule) => rule.id),
        decode: (token) => decodeBookmark(token, method.id),
        encode: (value) => encodeBookmark({ ...value, methodId: method.id, bookmarkVersion: 1 }),
      },
      nativeId: (history) => string(history.identityRecord.id) ?? "",
      normalize: normalizePi,
      parse: parsePiHistory,
      writerVersion: null,
    };
  }
  if (method.id === CODEX_TRANSCRIPT_METHOD.id) {
    const rules = rulesFor(CODEX_TRANSCRIPT, method);
    return {
      consistency: "append-only",
      ancestry: { base: codexBase, validate: validateCodexBase },
      method,
      branch: () => ({ evidence: [], selection: null, state: "unknown", view: "unknown" }),
      lookup: {
        directories: ["sessions", "archived_sessions"],
        recursive: true,
        matches: (name, id) =>
          /^rollout-/.test(name.split("/").at(-1) ?? "") &&
          (name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`)),
      },
      historicalLoss: CODEX_HISTORICAL_LOSS,
      evidence: CODEX_TRANSCRIPT_EVIDENCE,
      rules,
      consistencyRuleIds: rules
        .filter((rule) => rule.purpose === "consistency")
        .map((rule) => rule.id),
      continuation: {
        ruleIds: rules.filter((rule) => rule.purpose === "continuation").map((rule) => rule.id),
        decode: (token) => decodeBookmark(token, method.id),
        encode: (value) => encodeBookmark({ ...value, methodId: method.id, bookmarkVersion: 1 }),
      },
      nativeId: codexNativeId,
      normalize: normalizeCodex,
      parse: parseCodexHistory,
      writerVersion: CODEX_TRANSCRIPT_EVIDENCE.appliesTo.writerBuilds[0]?.version ?? null,
    };
  }
  return null;
}
