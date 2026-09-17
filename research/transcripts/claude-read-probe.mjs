// Synthetic, passive read probe. No query, resume, or model call.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const root = path.resolve("research/transcripts/claude-synthetic-state");
const sdkPath = "/private/tmp/hcn-transcript-claude-packages/sdk/package/sdk.mjs";
const sessionId = "11111111-1111-4111-8111-111111111111";
const missingId = "22222222-2222-4222-8222-222222222222";
const project = path.join(root, "projects", "synthetic-project");
fs.mkdirSync(project, { recursive: true });
const file = path.join(project, `${sessionId}.jsonl`);
const entry = (type, uuid, parentUuid, content, extra = {}) => ({
  type,
  uuid,
  parentUuid,
  sessionId,
  timestamp: "2026-09-11T00:00:00.000Z",
  message: { role: type, content },
  originalExtra: "preserve-me",
  ...extra,
});
const rows = [
  entry("user", "u0", null, "Synthetic starting message"),
  entry("assistant", "a-old", "u0", "Abandoned branch answer"),
  entry("assistant", "a1", "u0", [
    { type: "tool_use", id: "tool-1", name: "custom_tool", input: { synthetic: true } },
  ]),
  entry("user", "tr1", "a1", [
    { type: "tool_result", tool_use_id: "tool-1", content: "Synthetic tool result" },
  ]),
  entry("system", "s1", "tr1", "Synthetic notice", { subtype: "synthetic_notice" }),
  entry("attachment", "attachment1", "s1", "Synthetic attachment record"),
  entry("assistant", "a2", "attachment1", "Current branch answer"),
  { type: "custom_record", uuid: "custom1", value: "synthetic extension data" },
];
fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{broken\n`);

const blocked = [];
const originals = [];
const writeSyntheticFile = fs.writeFileSync.bind(fs);
const forbid = (object, names, category) => {
  for (const name of names) {
    if (typeof object[name] !== "function") continue;
    originals.push([object, name, object[name]]);
    object[name] = () => {
      blocked.push(`${category}.${name}`);
      throw new Error(`Probe blocks ${category}.${name}`);
    };
  }
};
forbid(
  childProcess,
  ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
  "process",
);
forbid(http, ["request", "get"], "network");
forbid(https, ["request", "get"], "network");
forbid(net, ["connect", "createConnection"], "network");
forbid(tls, ["connect"], "network");
forbid(
  fs,
  [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "unlink",
    "unlinkSync",
    "rename",
    "renameSync",
    "truncate",
    "truncateSync",
    "createWriteStream",
  ],
  "write",
);
forbid(fsp, ["writeFile", "appendFile", "unlink", "rename", "truncate"], "write");
globalThis.fetch = async () => {
  blocked.push("network.fetch");
  throw new Error("Probe blocks fetch");
};
syncBuiltinESMExports();

const fingerprint = () => ({
  sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  size: fs.statSync(file).size,
  mtimeMs: fs.statSync(file).mtimeMs,
});
const before = fingerprint();
const { getSessionMessages } = await import(sdkPath);
const defaultRead = await getSessionMessages(sessionId);
const systemRead = await getSessionMessages(sessionId, { includeSystemMessages: true });
const page = await getSessionMessages(sessionId, { offset: 1, limit: 2 });
const missing = await getSessionMessages(missingId);
const invalid = await getSessionMessages("invalid-id");
const after = fingerprint();
assert.deepEqual(before, after);
assert.deepEqual(blocked, []);
assert.deepEqual(
  defaultRead.map((row) => row.uuid),
  ["u0", "a1", "tr1", "a2"],
);
assert.deepEqual(
  systemRead.map((row) => row.uuid),
  ["u0", "a1", "tr1", "s1", "a2"],
);
assert.deepEqual(
  page.map((row) => row.uuid),
  ["a1", "tr1"],
);
assert.equal(
  defaultRead.some((row) => "parentUuid" in row || "originalExtra" in row),
  false,
);
assert.deepEqual(missing, []);
assert.deepEqual(invalid, []);
const compactedIds = [];
for (const paddingSize of [64, 6 * 1024 * 1024]) {
  const compactedRows = [
    entry("user", "before-u", null, "Synthetic pre-compaction question"),
    entry("assistant", "before-a", "before-u", "Synthetic pre-compaction answer"),
    { type: "attribution-snapshot", padding: "x".repeat(paddingSize) },
    {
      type: "system",
      subtype: "compact_boundary",
      ...entry("system", "boundary", "before-a", "Synthetic compaction boundary"),
    },
    entry("user", "summary", "boundary", "Synthetic summary"),
    entry("assistant", "after-a", "summary", "Synthetic post-compaction answer"),
  ];
  writeSyntheticFile(file, `${compactedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const compactBefore = fingerprint();
  const messages = await getSessionMessages(sessionId, { includeSystemMessages: true });
  assert.deepEqual(fingerprint(), compactBefore);
  compactedIds.push({
    paddingSize,
    sourceBytes: compactBefore.size,
    ids: messages.map((row) => row.uuid),
  });
}
assert.deepEqual(compactedIds[0].ids, ["before-u", "before-a", "boundary", "summary", "after-a"]);
assert.deepEqual(compactedIds[1].ids, ["boundary", "summary", "after-a"]);
assert.deepEqual(blocked, []);
for (const [object, name, original] of originals) object[name] = original;
syncBuiltinESMExports();
const report = {
  sdkVersion: "0.3.233",
  claudeCodeVersion: "2.1.233",
  syntheticInputRecords: rows.length,
  malformedLines: 1,
  defaultRead,
  systemReadIds: systemRead.map((row) => row.uuid),
  pageIds: page.map((row) => row.uuid),
  missing,
  invalid,
  blocked,
  before,
  after,
  compactedIds,
  limits: ["Not a live writer probe", "JS guards do not prove native code cannot open a socket"],
};
fs.writeFileSync(
  "research/transcripts/claude-read-probe-result.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    passed: true,
    defaultIds: defaultRead.map((row) => row.uuid),
    compactedIds,
    blocked,
    unchanged: true,
  }),
);
