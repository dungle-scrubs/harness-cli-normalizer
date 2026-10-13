#!/usr/bin/env node
// Synthetic consumer checks. Never reads the caller's native history stores.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "hcn-skill-transcript-"));
const hcnBin = process.env.HCN_BIN ?? "hcn";
function wire(args, expected = 0) {
  const result = spawnSync(hcnBin, args, {
    encoding: "utf8",
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: directory,
      CODEX_HOME: directory,
      PI_CODING_AGENT_DIR: directory,
    },
    maxBuffer: 12 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `hcn ${args.slice(0, 3).join(" ")} exit`);
  return result.stdout;
}
function run(args, expected = 0) {
  return wire(args, expected)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const guarantees = ["history", "branches", "original-records", "embedded-content"];
try {
  const help = wire(["transcript", "--help"]);
  // Both surfaces are additive; an older installed binary lacks them.
  const writerBuildReported = help.includes("reports the cli_version its own header names");
  const listsSessions = help.includes("hcn transcript ls");
  assert.ok(
    help.includes("legacy and paginated rollouts with ID/file lookup, batches and bookmarks"),
  );
  assert.ok(help.includes("compressed files are unsupported"));
  for (const harness of ["claude", "codex", "pi", "muse"]) {
    const [doc] = run(["inspect", harness, "--transcript"]);
    assert.equal(doc.kind, "transcript-capabilities");
    assert.deepEqual(Object.keys(doc.capabilities), [
      ...guarantees,
      "active-branch",
      "incremental",
      "paging",
      "record-identity",
    ]);
    for (const value of Object.values(doc.capabilities)) {
      assert.ok(["available", "limited", "unavailable", "unknown"].includes(value.status));
      assert.equal(typeof value.reason, "string");
      assert.ok(Array.isArray(value.evidence));
    }
    for (const name of guarantees) assert.equal(doc.capabilities[name].status, "available");
    assert.equal(doc.methods[0].passivity.status, "available");
    assert.ok(doc.methods[0].cleanupTimeoutMs > 0);
    if (harness === "claude" || harness === "muse") {
      assert.deepEqual(doc.methods[0].selectors, ["id", "file"]);
      assert.equal(doc.methods[0].id, harness + "-file-v1");
      assert.equal(doc.verifiedAgainst, JSON.parse(wire(["inspect", harness])).verifiedAgainst);
      const historyEvidence = doc.capabilities.history.evidence;
      assert.ok(
        historyEvidence.some((evidence) => evidence.reference.includes("transcript-evidence.md")),
      );
      assert.ok(
        historyEvidence.every((evidence) => ["documented", "observed"].includes(evidence.standing)),
      );
      if (harness === "muse" && historyEvidence[0].standing === "observed") {
        assert.match(
          historyEvidence[0].reference,
          /^test\/fixtures\/muse-[^/]+\/VERIFICATION\.md$/,
        );
      }
      assert.ok(
        doc.rules.some(
          (rule) =>
            rule.purpose === "consistency" &&
            rule.description.includes("no ordinary-copy fallback"),
        ),
      );
      const [source, result] = run(
        ["transcript", "read", harness, "--file", join(directory, "missing.jsonl")],
        1,
      );
      assert.deepEqual(source.sources, []);
      assert.equal(result.failure.issue, "source-not-found");
      assert.equal(result.bookmark, null);
    }
  }
  const source = join(directory, "synthetic.jsonl");
  const original =
    '{"type":"session","version":3,"id":"synthetic","cwd":"/synthetic"}\n{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"synthetic question"}}\n{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"synthetic answer"}]}}\n';
  writeFileSync(source, original);
  const batch = run(["transcript", "read", "pi", "--file", source, "--limit", "1"]);
  assert.deepEqual(
    batch.map((row) => row.kind),
    ["source", "record", "result"],
  );
  assert.equal(batch[1].nativeId, "a");
  assert.equal(batch.at(-1).more, true);
  assert.equal(batch.at(-1).status, "complete");
  const next = run([
    "transcript",
    "read",
    "pi",
    "--file",
    source,
    "--since",
    batch.at(-1).bookmark,
  ]);
  assert.equal(next[1].nativeId, "b");
  assert.equal(next.at(-1).continuation.input, "verified");
  assert.equal(next.at(-1).more, false);
  assert.equal(readFileSync(source, "utf8"), original);
  for (const name of guarantees) assert.equal(next.at(-1).coverage[name].state, "complete");
  assert.deepEqual(next.at(-1).limits, []);
  assert.equal(next.at(-1).activeBranch.view, "saved");
  assert.equal(next.at(-1).capabilities["active-branch"].status, "limited");
  assert.equal(next[1].normalized.relationships["parent-entry"].targets[0].nativeId, "a");
  assert.equal(
    next[1].normalized.relationships["parent-entry"].targets[0].scope.conversationId,
    "synthetic",
  );
  assert.deepEqual(
    next.at(-1).consistency.ruleIds,
    next.at(-1).consistency.checks.map((check) => check.ruleId),
  );
  assert.ok(next.at(-1).consistency.checks.every((check) => check.outcome === "passed"));
  const readArgs = ["transcript", "read", "pi", "--file", source];
  const tool = {
    type: "message",
    id: "c",
    parentId: "b",
    message: {
      role: "toolResult",
      toolCallId: "native-call",
      toolName: "synthetic",
      content: [{ type: "text", text: "x".repeat(2200000) }],
    },
    unknown: "LARGE",
  };
  const toolWire = JSON.stringify(tool).replace('"LARGE"', "9007199254740993");
  writeFileSync(source, original + toolWire + "\n");
  const complete = wire(readArgs);
  assert.ok(complete.includes('"unknown":9007199254740993'));
  const toolRecord = JSON.parse(complete.trim().split("\n").at(-2));
  assert.equal(toolRecord.normalized.parts[0].text.length, 2200000);
  assert.equal(toolRecord.normalized.relationships["tool-call"].targets[0].kind, "tool-call");
  assert.equal(toolRecord.normalized.relationships["tool-call"].targets[0].nativeId, "native-call");
  writeFileSync(source, original + '{"type":"custom"}');
  const tail = run(readArgs).at(-1);
  assert.equal(tail.status, "complete");
  assert.ok(tail.incompleteTail);
  assert.equal(tail.more, false);
  writeFileSync(source, original + "malformed\n");
  const corrupt = run(readArgs, 1).at(-1);
  assert.equal(corrupt.failure.issue, "source-malformed");
  assert.equal(corrupt.bookmark, null);
  writeFileSync(source, original.replace("synthetic question", "changed question"));
  const invalidated = run([...readArgs, "--since", batch.at(-1).bookmark], 1).at(-1);
  assert.equal(invalidated.failure.issue, "fresh-read-required");
  assert.equal(invalidated.continuation.input, "invalid");
  assert.equal(run([...readArgs, "--limit", "0"], 2).at(-1).failure.issue, "invalid-option-value");
  assert.equal(
    run([...readArgs, "--accept-limits", "all"], 2).at(-1).failure.issue,
    "invalid-option-value",
  );
  assert.equal(
    run(["transcript", "read", "pi", "--file", join(directory, "missing.jsonl")], 1).at(-1).failure
      .issue,
    "source-not-found",
  );
  const codex =
    '{"type":"session_meta","payload":{"id":"synthetic-codex","cli_version":"0.147.0","history_mode":"legacy"}}\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"synthetic result"}}\n';
  writeFileSync(source, codex);
  const codexArgs = ["transcript", "read", "codex", "--file", source];
  const exported = run(codexArgs);
  assert.equal(exported[1].nativeId, null);
  if (writerBuildReported)
    assert.deepEqual(exported[0].sources[0].writerBuild, { buildId: null, version: "0.147.0" });
  assert.equal(exported[1].normalized.parts[0].text, "synthetic result");
  assert.equal(exported.at(-1).historicalLoss.state, "known-loss");
  assert.equal(exported.at(-1).coverage.history.state, "complete");
  assert.equal(typeof exported.at(-1).bookmark, "string");
  const codexBatch = run([...codexArgs, "--limit", "1"]);
  assert.equal(
    run([...codexArgs, "--since", codexBatch.at(-1).bookmark]).at(-1).recordsReturned,
    0,
  );
  if (writerBuildReported) {
    // A build the format evidence was not read against still reads; the
    // rollout's own cli_version is reported rather than required.
    writeFileSync(source, codex.replace("0.147.0", "99.0.0"));
    const newer = run(codexArgs);
    assert.deepEqual(newer[0].sources[0].writerBuild, { buildId: null, version: "99.0.0" });
    assert.equal(newer.at(-1).status, "complete");
    writeFileSync(source, codex);
  }
  writeFileSync(source, codex.replace('"legacy"', '"paginated"'));
  assert.equal(run(codexArgs, 1).at(-1).failure.issue, "guarantee-unmet");
  const store = join(directory, "sessions");
  mkdirSync(store);
  const parentId = "11111111-2222-4333-8444-555555555555";
  const childId = "11111111-2222-4333-8444-666666666666";
  const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const parent = lines([
    {
      type: "session_meta",
      ordinal: 0,
      payload: { id: parentId, cli_version: "0.147.0", history_mode: "paginated" },
    },
    { type: "event_msg", ordinal: 1, payload: { type: "synthetic", text: "inherited" } },
  ]);
  const parentFile = join(store, "rollout-2026-09-11T00-00-00-" + parentId + ".jsonl");
  writeFileSync(
    parentFile,
    parent + lines([{ type: "event_msg", ordinal: 2, payload: { text: "parent-only" } }]),
  );
  writeFileSync(
    join(store, "rollout-2026-09-12T00-00-00-" + childId + ".jsonl"),
    lines([
      {
        type: "session_meta",
        ordinal: 2,
        payload: {
          id: childId,
          cli_version: "0.147.0",
          history_mode: "paginated",
          history_base: {
            thread_id: parentId,
            end_byte_offset: Buffer.byteLength(parent),
            end_ordinal_exclusive: 2,
          },
        },
      },
      { type: "event_msg", ordinal: 3, payload: { text: "child" } },
    ]),
  );
  const inheritedArgs = ["transcript", "read", "codex", "--id", childId];
  const inherited = run([...inheritedArgs, "--limit", "1"]);
  assert.equal(inherited[0].sources.length, 2);
  assert.equal(inherited[1].original.payload.text, "inherited");
  assert.equal(inherited.at(-1).more, true);
  const child = run([...inheritedArgs, "--since", inherited.at(-1).bookmark]);
  assert.equal(child[1].original.payload.text, "child");
  assert.equal(child[1].sourceKey, "source-1");
  assert.equal(child[1].position.sourceKey, "source-1");
  writeFileSync(parentFile, parent.replace("inherited", "rewritten"));
  assert.equal(
    run([...inheritedArgs, "--since", inherited.at(-1).bookmark], 1).at(-1).failure.issue,
    "fresh-read-required",
  );
  const archived = join(directory, "archived_sessions", "2026", "09", "12");
  mkdirSync(archived, { recursive: true });
  const archiveId = "11111111-2222-4333-8444-777777777777";
  const archiveName = "rollout-2026-09-12T00-00-00-" + archiveId + ".jsonl";
  const archiveHeader = lines([
    { type: "session_meta", payload: { id: archiveId, cli_version: "0.147.0" } },
  ]);
  writeFileSync(join(archived, archiveName), archiveHeader);
  const archiveArgs = ["transcript", "read", "codex", "--id", archiveId];
  assert.equal(run(archiveArgs)[0].conversation.nativeId, archiveId);
  writeFileSync(join(store, archiveName), archiveHeader);
  assert.equal(run(archiveArgs, 1).at(-1).failure.issue, "source-ambiguous");
  const compressed = join(directory, "synthetic.jsonl.zst");
  writeFileSync(compressed, "synthetic unsupported compression");
  assert.equal(
    run(["transcript", "read", "codex", "--file", compressed], 1).at(-1).failure.issue,
    "guarantee-unmet",
  );
  writeFileSync(
    source,
    lines([
      {
        type: "session_meta",
        ordinal: 0,
        payload: {
          id: "synthetic",
          cli_version: "0.147.0",
          history_mode: "paginated",
          subagent_history_start_ordinal: 5,
        },
      },
    ]),
  );
  assert.equal(run(codexArgs, 1).at(-1).failure.issue, "guarantee-unmet");
  writeFileSync(
    source,
    lines([
      {
        type: "session_meta",
        ordinal: 2,
        payload: {
          id: childId,
          cli_version: "0.147.0",
          history_mode: "paginated",
          history_base: {
            thread_id: parentId,
            end_byte_offset: Buffer.byteLength(parent) - 1,
            end_ordinal_exclusive: 2,
          },
        },
      },
    ]),
  );
  assert.equal(run(codexArgs, 1).at(-1).failure.issue, "guarantee-unmet");
  for (const harness of ["claude", "muse"]) {
    const native =
      harness === "claude"
        ? {
            type: "user",
            uuid: "entry",
            sessionId: "synthetic-claude",
            parentUuid: null,
            message: { role: "user", content: "synthetic question" },
          }
        : {
            schema_version: 1,
            id: "entry",
            stream: { kind: "session", id: "synthetic-muse" },
            sequence: 1,
            recorded_at: 1771088000000000,
            record_type: "event",
            durability: "durable",
            causation_id: null,
            payload_type: "runtime.session",
            payload_schema_version: 1,
            payload: { kind: "run", event: { kind: "started", prompt: "synthetic question" } },
          };
    const input = lines([native]);
    writeFileSync(source, input);
    const args = ["transcript", "read", harness, "--file", source];
    const result = run(args);
    assert.equal(result[0].conversation.nativeId, "synthetic-" + harness);
    assert.deepEqual(result[1].original, native);
    assert.equal(result[1].normalized.parts[0].text, "synthetic question");
    assert.equal(result.at(-1).consistency.method, "native-snapshot");
    assert.equal(result.at(-1).status, "complete");
    assert.equal(run([...args, "--since", result.at(-1).bookmark]).at(-1).recordsReturned, 0);
    assert.equal(readFileSync(source, "utf8"), input);
    writeFileSync(source, input.replace("synthetic question", "rewritten question"));
    assert.equal(
      run([...args, "--since", result.at(-1).bookmark], 1).at(-1).failure.issue,
      "fresh-read-required",
    );
  }
  if (listsSessions) {
    // Listing reads the isolated store this check built, never the caller's.
    const piId = "11111111-2222-4333-8444-aaaaaaaaaaaa";
    const piStore = join(directory, "sessions", "--synthetic-workspace--");
    mkdirSync(piStore, { recursive: true });
    const piFile = join(piStore, `2026-09-20T00-00-00-000Z_${piId}.jsonl`);
    // The v3 header carries the session's own start time; the row reports it
    // as `startedAt`, normalized, and never substitutes the filesystem mtime.
    const piStarted = "2026-09-20T00:00:00.000Z";
    writeFileSync(
      piFile,
      lines([{ type: "session", version: 3, id: piId, cwd: "/synthetic", timestamp: piStarted }]),
    );
    const listed = run(["transcript", "ls", "--all-workspaces", "--harness", "codex,pi"]);
    const [listSource, listResult] = [listed[0], listed.at(-1)];
    assert.equal(listSource.kind, "session-list-source");
    assert.equal(listResult.kind, "session-list-result");
    assert.equal(listResult.status, "complete");
    const rows = listed.slice(1, -1);
    assert.ok(rows.every((row) => row.kind === "session"));
    assert.equal(listResult.rowsReturned, rows.length);
    const times = rows.map((row) => row.lastWriteAt);
    assert.deepEqual(times, [...times].sort().reverse(), "rows are newest write first");
    assert.deepEqual(
      listResult.harnesses.map((entry) => entry.state),
      ["codex", "pi"].map(() => "listed"),
    );
    const pi = rows.find((row) => row.harness === "pi");
    assert.deepEqual(
      { id: pi.id, file: pi.file, cwd: pi.cwd, mode: pi.mode, readable: pi.readable },
      { id: piId, file: piFile, cwd: "/synthetic", mode: "unknown", readable: true },
    );
    // Fields added after the first listing build. The help does not name row
    // fields, so the gate is the row itself: assert them where they appear.
    if ("startedAt" in pi) {
      assert.equal(pi.startedAt, piStarted);
      assert.ok(Number.isInteger(pi.sizeBytes) && pi.sizeBytes > 0, "a row reports its own size");
      assert.equal(pi.blocked, null, "a quiet source names no blocker");
    }
    assert.ok(
      rows.some((row) => row.harness === "codex"),
      "the isolated Codex store contributes rows",
    );
    const capped = run([
      "transcript",
      "ls",
      "--all-workspaces",
      "--harness",
      "codex,pi",
      "--limit",
      "1",
    ]);
    assert.equal(capped.length, 3);
    assert.equal(capped.at(-1).more, true);
    // A per-harness `matched` (`rows` before 0.8.0) counts what that harness
    // contributed before `--limit`; `rowsReturned` counts what was printed.
    assert.equal(capped.at(-1).rowsReturned, 1);
    assert.ok(
      capped.at(-1).harnesses.reduce((total, item) => total + (item.matched ?? item.rows), 0) >= 1,
      "per-harness rows are counted before --limit",
    );
    if (help.includes("--since-time")) {
      // The row's own write time is in the window, so the window keeps it.
      const within = run([
        "transcript",
        "ls",
        "--all-workspaces",
        "--harness",
        "pi",
        "--since-time",
        "1970-01-01T00:00:00Z",
      ]);
      assert.deepEqual(
        within.slice(1, -1).map((row) => row.id),
        [piId],
      );
      assert.equal(within[0].scope.sinceTime, "1970-01-01T00:00:00.000Z");
      // A window in the future admits nothing and still lists the harness.
      const beyond = run([
        "transcript",
        "ls",
        "--all-workspaces",
        "--harness",
        "pi",
        "--since-time",
        "2999-01-01T00:00:00Z",
      ]);
      assert.equal(beyond.at(-1).rowsReturned, 0);
      assert.equal(beyond.at(-1).harnesses[0].state, "listed");
      // An offset is refused rather than read as UTC.
      assert.equal(
        run(
          ["transcript", "ls", "--all-workspaces", "--since-time", "2026-09-20T12:00:00+02:00"],
          2,
        ).at(-1).failure.issue,
        "invalid-option-value",
      );
    }
    // A workspace scope keeps the sessions that name it and drops the rest.
    const scoped = run(["transcript", "ls", "--cwd", "/synthetic", "--harness", "codex,pi"]);
    assert.deepEqual(
      scoped.slice(1, -1).map((row) => row.id),
      [piId],
    );
    assert.equal(
      run(["transcript", "ls", "--cwd", "/synthetic", "--all-workspaces"], 2).at(-1).status,
      "refused",
    );
    rmSync(piStore, { recursive: true, force: true });
  } else console.log("skip: installed hcn has no transcript ls");
  if (help.includes("Cursor chat stores")) {
    for (const harness of ["cursor", "antigravity"]) {
      const [doc] = run(["inspect", harness, "--transcript"]);
      for (const name of guarantees) assert.equal(doc.capabilities[name].status, "available");
      assert.deepEqual(doc.methods[0].selectors, ["id", "file"]);
      assert.ok(doc.capabilities.history.evidence[0].reference.includes("transcript-evidence.md"));
    }
    const conversation = "11111111-2222-4333-8444-888888888888";
    const logs = join(
      directory,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversation,
      ".system_generated",
      "logs",
    );
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript_full.jsonl");
    const step = (index, fields) => ({
      step_index: index,
      source: "MODEL",
      status: "DONE",
      created_at: "2026-09-19T00:00:00Z",
      ...fields,
    });
    writeFileSync(
      log,
      lines([
        step(0, { source: "USER_EXPLICIT", type: "USER_INPUT", content: "synthetic question" }),
      ]),
    );
    const steps = run(["transcript", "read", "antigravity", "--id", conversation]);
    assert.equal(steps[0].conversation.nativeId, conversation);
    assert.equal(steps[1].normalized.parts[0].text, "synthetic question");
    appendFileSync(
      log,
      lines([step(1, { type: "PLANNER_RESPONSE", content: "synthetic answer" })]),
    );
    const more = run([
      "transcript",
      "read",
      "antigravity",
      "--id",
      conversation,
      "--since",
      steps.at(-1).bookmark,
    ]);
    assert.equal(more.at(-1).continuation.input, "verified");
    assert.equal(more.at(-1).recordsReturned, 1);
    writeFileSync(log, lines([step(1, { type: "USER_INPUT" })]));
    assert.equal(
      run(["transcript", "read", "antigravity", "--id", conversation], 1).at(-1).failure.issue,
      "guarantee-unmet",
    );
    const { DatabaseSync } = await import("node:sqlite");
    const agent = "11111111-2222-4333-8444-999999999999";
    const chat = join(directory, ".cursor", "chats", "0".repeat(32), agent);
    mkdirSync(chat, { recursive: true });
    const storePath = join(chat, "store.db");
    const blob = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const digest = (data) => createHash("sha256").update(data).digest("hex");
    const message = blob({ role: "user", content: [{ type: "text", text: "synthetic question" }] });
    const root = Buffer.from([0x0a, 0x20, ...Buffer.from(digest(message), "hex")]);
    const db = new DatabaseSync(storePath);
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    for (const data of [message, root])
      db.prepare("INSERT INTO blobs VALUES (?, ?)").run(digest(data), data);
    db.prepare("INSERT INTO meta VALUES (?, ?)").run(
      "0",
      blob({
        agentId: agent,
        latestRootBlobId: digest(root),
        blobEncryptionKey: "synthetic-key",
      }).toString("hex"),
    );
    db.close();
    const chatRead = wire(["transcript", "read", "cursor", "--id", agent]);
    assert.ok(!chatRead.includes("synthetic-key"));
    const chatRows = chatRead
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(chatRows[0].conversation.nativeId, agent);
    assert.equal(chatRows[1].nativeId, digest(message));
    assert.equal(chatRows[1].normalized.parts[0].text, "synthetic question");
    writeFileSync(storePath + "-wal", "synthetic frames");
    const live = run(["transcript", "read", "cursor", "--id", agent], 1).at(-1);
    assert.equal(live.failure.issue, "guarantee-unmet");
    assert.equal(live.failure.requirement, "consistency");
  } else console.log("skip: installed hcn has no Cursor or Antigravity transcript reader");
  console.log("ok: synthetic transcript claims");
} catch (error) {
  console.error(`MISS: transcript claims: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
