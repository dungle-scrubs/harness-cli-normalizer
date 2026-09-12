import type { ReadTranscriptRequest } from "../../interpretation/transcript/envelopes.js";
import {
  assessments,
  emptyTranscript,
  failure,
} from "../../interpretation/transcript/envelopes.js";

export type { ReadTranscriptRequest } from "../../interpretation/transcript/envelopes.js";
export { emptyTranscript, failure } from "../../interpretation/transcript/envelopes.js";

import { createHash } from "node:crypto";
import { join } from "node:path";
import { encodeJson, TranscriptError } from "../../interpretation/transcript/json.js";
import { position } from "../../interpretation/transcript/native.js";
import type { TranscriptReader } from "../../interpretation/transcript/readers.js";
import { recordFromSource } from "../../interpretation/transcript/readers.js";
import type { CapabilityMap } from "../../knowledge/transcript/schema.js";
import type {
  Check,
  Consistency,
  Continuation,
  Issue,
  Mutable,
  Phase,
  RecordEnvelope,
} from "../../knowledge/transcript/wire.js";
import type { Clock } from "../deps.js";
import type { TranscriptFile, TranscriptFiles } from "./files.js";
import { captureSources } from "./sources.js";

export interface ReadTranscriptDeps {
  readonly reader: TranscriptReader;
  readonly clock: Clock;
  readonly files: TranscriptFiles;
  readonly signal?: AbortSignal;
  readonly write: (line: string) => Promise<void>;
}
function errorIssue(error: unknown): Issue {
  if (error instanceof TranscriptError) return error.issue;
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  return code === "ENOENT" ? "source-not-found" : "source-inaccessible";
}
export async function readTranscript(
  request: ReadTranscriptRequest,
  deps: ReadTranscriptDeps,
): Promise<number> {
  const { result, source } = emptyTranscript(request);
  const reader = deps.reader;
  const continuation: Mutable<Continuation> = {
    input: request.since ? "not-checked" : "absent",
    output: "unavailable",
  };
  result.continuation = continuation;
  const consistencyIds = [
    ...reader.consistencyRuleIds,
    ...(request.since ? (reader.continuation?.ruleIds ?? []) : []),
  ];
  const checks: Mutable<Check>[] = consistencyIds.map((ruleId) => ({
    description: "Required native source check.",
    outcome: "unknown",
    ruleId,
  }));
  const consistency: Mutable<Consistency> = {
    assumptions: [
      "The selected native format uses the documented append-only writer protocol. File checks do not authenticate an unknown writer build or cover arbitrary in-place writers.",
    ],
    boundaries: [],
    checks,
    method: "unknown",
    ruleIds: consistencyIds,
  };
  result.consistency = consistency;
  source.methodId = reader.method.id;
  const selection = request.selection;
  if (selection.kind === "id")
    source.selection = {
      kind: "id",
      storeRoots: reader.lookup.directories.map((directory) =>
        join(request.nativeStoreRoot ?? "", directory),
      ),
      value: selection.nativeId,
      workspace: request.workspace,
    };
  const opened: TranscriptFile[] = [];
  let phase: Phase = "resolve";
  let records: RecordEnvelope[] = [];
  let issue: Issue | null = null;
  const checkAbort = (): void => {
    if (deps.signal?.aborted)
      throw new TranscriptError("interrupted", "The caller interrupted the native read.");
  };
  try {
    checkAbort();
    const { requested, sources } = await captureSources(request, {
      reader,
      files: deps.files,
      opened,
      checkAbort,
    });
    const id = requested.nativeId;
    const entryCount = sources.reduce((count, item) => count + item.history.entries.length, 0);
    const bytes = requested.bytes;
    const completeBytes = requested.completeBytes;
    const boundariesAt = (count: number): number[] => {
      let remaining = count;
      return sources.map((item) => {
        const consumed = Math.min(remaining, item.history.entries.length);
        remaining -= consumed;
        return item.history.entries[consumed]?.offset ?? item.completeBytes;
      });
    };
    const offsetAt = (count: number): number =>
      boundariesAt(count).reduce((total, boundary) => total + boundary, 0);
    const hashes = sources.map(() => ({ hash: createHash("sha256"), through: 0 }));
    const digestThrough = (count: number): string => {
      const boundaries = boundariesAt(count);
      const fingerprints = sources.map((item, index) => {
        const state = hashes[index];
        const boundary = boundaries[index];
        if (!state || boundary === undefined) throw new Error("Missing source hash state");
        state.hash.update(item.bytes.subarray(state.through, boundary));
        state.through = boundary;
        return { nativeId: item.nativeId, boundary, digest: state.hash.copy().digest("hex") };
      });
      if (fingerprints.length === 1) return fingerprints[0]?.digest ?? "";
      return createHash("sha256").update(encodeJson(fingerprints)).digest("hex");
    };
    const coverage = assessments("complete", reader.evidence);
    const capabilities: CapabilityMap = entryCount
      ? reader.method.capabilities
      : {
          ...reader.method.capabilities,
          "active-branch": {
            evidence: [],
            prerequisiteRuleIds: [],
            reason: "No saved native selection is established in this empty view.",
            status: "unknown",
          },
        };
    const compatibility = {
      evidence: [reader.evidence],
      reason:
        "Validated native identity, framing and source-prefix rules within the documented format applicability; no writer build is inferred from the format label.",
      ruleIds: reader.rules.map((rule) => rule.id),
      state: "verified",
    };
    const ruleIds = reader.rules.map((rule) => rule.id);
    Object.assign(source, {
      appliedRuleIds: ruleIds,
      capabilities,
      compatibility,
      conversation: { nativeId: id },
      historicalLoss: reader.historicalLoss,
      coverage,
      methodId: reader.method.id,
      nativeHeaders: sources.map((item, index) => ({
        original: item.history.header,
        sourceKey: `source-${index}`,
      })),
      sources: sources.map((item, index) => ({
        formatId: reader.evidence.appliesTo.formatId,
        formatVersion: reader.evidence.appliesTo.formatVersions[0] ?? null,
        key: `source-${index}`,
        kind: "file",
        location: item.path,
        nativeId: item.nativeId,
        writerBuild: { buildId: null, version: reader.writerVersion },
      })),
      verification: [reader.evidence],
    });
    Object.assign(result, {
      appliedRuleIds: ruleIds,
      capabilities,
      compatibility,
      consistency,
      coverage,
      historicalLoss: reader.historicalLoss,
    });
    let start = 0;
    if (request.since) {
      try {
        if (!reader.continuation)
          throw new TranscriptError("fresh-read-required", "No compatible continuation reader.");
        const bookmark = reader.continuation.decode(request.since);
        const boundary = offsetAt(bookmark.entries);
        if (
          bookmark.conversationId !== id ||
          bookmark.entries > entryCount ||
          bookmark.offset !== boundary ||
          bookmark.digest !== digestThrough(bookmark.entries)
        )
          throw new TranscriptError(
            "fresh-read-required",
            "The prior native prefix cannot be verified.",
          );
        start = bookmark.entries;
        continuation.input = "verified";
        const check = checks.find((item) => reader.continuation?.ruleIds.includes(item.ruleId));
        if (check) check.outcome = "passed";
      } catch (error) {
        continuation.input = "invalid";
        const check = checks.find((item) => reader.continuation?.ruleIds.includes(item.ruleId));
        if (check) check.outcome = "failed";
        throw error;
      }
    }
    phase = "read";
    const end = Math.min(entryCount, start + (request.limit ?? entryCount));
    let skip = start;
    let take = end - start;
    const selected = sources.flatMap((item, sourceIndex) => {
      const localStart = Math.min(skip, item.history.entries.length);
      skip -= localStart;
      const localEnd = Math.min(item.history.entries.length, localStart + take);
      take -= localEnd - localStart;
      return item.history.entries
        .slice(localStart, localEnd)
        .map((entry) => ({ entry, sourceIndex }));
    });
    const progressBytes = offsetAt(end);
    phase = "verify";
    for (const check of checks) check.outcome = "passed";
    records = selected.map(({ entry, sourceIndex }) =>
      recordFromSource(reader.normalize(entry, id), `source-${sourceIndex}`),
    );
    consistency.method = "validated-prefix";
    let remaining = end;
    consistency.boundaries = sources.map((item, index) => {
      const count = Math.min(remaining, item.history.entries.length);
      remaining -= count;
      const last = item.history.entries.at(-1);
      const progressed = item.history.entries[count - 1];
      const sourceKey = `source-${index}`;
      return {
        observedEntries: String(item.history.entries.length),
        observedThrough: last ? { ...position(last.offset), sourceKey } : null,
        progressEntries: String(count),
        progressThrough: progressed ? { ...position(progressed.offset), sourceKey } : null,
        sourceKey,
      };
    });
    let bookmark =
      reader.method.capabilities.incremental.status === "available" && reader.continuation
        ? reader.continuation.encode({
            conversationId: id,
            digest: digestThrough(end),
            entries: end,
            offset: progressBytes,
          })
        : null;
    if (bookmark && bookmark.length > 65536) {
      bookmark = null;
      const reduced: CapabilityMap = {
        ...capabilities,
        incremental: {
          status: "unavailable",
          evidence: [reader.evidence],
          prerequisiteRuleIds: [],
          reason: "Required source identity cannot fit in the 65536-byte bookmark envelope.",
        },
      };
      source.capabilities = reduced;
      result.capabilities = reduced;
    }
    continuation.output =
      bookmark !== null ? (end > start ? "advanced" : "same-boundary") : "unavailable";
    Object.assign(result, {
      activeBranch: reader.branch(requested.history, id),
      bookmark,
      exitCode: 0,
      incompleteTail:
        completeBytes === bytes.length
          ? null
          : {
              position: { ...position(completeBytes), sourceKey: `source-${sources.length - 1}` },
              reason: "Final native framing unit is unfinished.",
            },
      more: end < entryCount,
      recordsReturned: records.length,
      status: "complete",
    });
  } catch (error) {
    issue = errorIssue(error);
    if (issue === "source-changed") {
      const check = checks.find((item) => reader.consistencyRuleIds.includes(item.ruleId));
      if (check) check.outcome = "failed";
      if (request.since) continuation.input = "invalid";
    }
    continuation.output = "unavailable";
    const requirement =
      issue === "fresh-read-required"
        ? "bookmark"
        : issue === "guarantee-unmet" || issue === "source-malformed"
          ? "format"
          : issue === "source-changed"
            ? "consistency"
            : "identity";
    Object.assign(result, {
      bookmark: null,
      exitCode: 1,
      failure: failure(
        issue,
        phase,
        requirement,
        "The selected native transcript could not be read under its declared rules.",
      ),
      status: "failed",
    });
  } finally {
    if (opened.length) {
      try {
        let timer: number | undefined;
        try {
          await Promise.race([
            Promise.allSettled(
              opened.map((file) => Promise.resolve().then(() => file.close())),
            ).then((results) => {
              if (results.some((result) => result.status === "rejected"))
                throw new TranscriptError("cleanup-failed", "Native reader cleanup failed.");
            }),
            new Promise<never>((_, reject) => {
              timer = deps.clock.setTimeout(
                () =>
                  reject(new TranscriptError("cleanup-failed", "Native reader cleanup timed out.")),
                reader.method.cleanupTimeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) deps.clock.clearTimeout(timer);
        }
      } catch {
        if (!issue) {
          issue = "cleanup-failed";
          continuation.output = "unavailable";
          Object.assign(result, {
            bookmark: null,
            exitCode: 1,
            failure: failure(
              issue,
              "cleanup",
              "cleanup",
              "The native reader could not close its resources.",
            ),
            status: "failed",
          });
        }
      }
    }
  }
  if (deps.signal?.aborted && issue !== "interrupted") {
    issue = "interrupted";
    continuation.output = "unavailable";
    Object.assign(result, {
      bookmark: null,
      exitCode: 1,
      failure: failure(issue, "cleanup", "cleanup", "The caller interrupted the read."),
      status: "failed",
    });
  }
  await deps.write(`${encodeJson(source)}\n`);
  for (const record of records) {
    if (issue !== "interrupted") checkAbort();
    await deps.write(`${encodeJson(record)}\n`);
  }
  if (issue !== "interrupted") checkAbort();
  await deps.write(`${encodeJson(result)}\n`);
  if (issue !== "interrupted") checkAbort();
  return result.exitCode;
}
