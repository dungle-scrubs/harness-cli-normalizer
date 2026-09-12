// Selected-version evidence only. Every input is synthetic; no native store is read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const binary = process.argv[2];
assert.ok(binary && isAbsolute(binary), "Pass the absolute path to the versioned vendor binary.");
const hash = createHash("sha256");
for await (const chunk of createReadStream(binary)) hash.update(chunk);
const sha256 = hash.digest("hex");
assert.equal(sha256, "7dfd75e1e2dd7c763e60b7e379f4146b8b2b10478a2830c8cdbb35ae9961881e");
const root = await mkdtemp(join(tmpdir(), "hcn-muse-export-synthetic-"));
const sessionId = "11111111-1111-4111-8111-111111111111";
const envelope = (sequence, payload_type, payload) => ({
  schema_version: 1,
  id: `22222222-2222-4222-8222-${String(sequence).padStart(12, "0")}`,
  stream: { kind: "session", id: sessionId },
  sequence,
  recorded_at: 1771088000123456 + sequence,
  record_type: "event",
  durability: "durable",
  causation_id: null,
  payload_type,
  payload_schema_version: 1,
  payload,
});
const rows = [
  envelope(1, "runtime.session", {
    kind: "run",
    run_id: "33333333-3333-4333-8333-333333333333",
    event: { kind: "started", prompt: "SYNTHETIC USER" },
  }),
  envelope(2, "synthetic.unknown", { kind: "future", text: "SYNTHETIC UNKNOWN" }),
];
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const cases = [
  {
    name: "valid",
    input: jsonl(rows),
    sessionCount: 1,
    diagnostics: { unknown_payload_kinds: 1 },
    verify: (exported) =>
      assert.deepEqual(
        exported.events.map((event) => event.envelope),
        rows,
      ),
  },
  {
    name: "corrupt",
    input: `${jsonl(rows)}{corrupt}\n`,
    sessionCount: 1,
    diagnostics: { unknown_payload_kinds: 1, unparseable_lines: 1 },
  },
  {
    name: "duplicate",
    input: jsonl([...rows, rows[1]]),
    sessionCount: 1,
    diagnostics: { unknown_payload_kinds: 1, duplicate_records: 1 },
  },
  {
    name: "no_identity",
    input: '{"synthetic":"no identity"}\n',
    sessionCount: 0,
    diagnostics: { unparseable_lines: 1 },
  },
  {
    name: "truncated",
    input: `${jsonl(rows)}{"incomplete":`,
    sessionCount: 1,
    diagnostics: { unknown_payload_kinds: 1, unparseable_lines: 1 },
  },
  {
    name: "sequence_gap",
    input: jsonl([rows[0], { ...rows[1], sequence: 3 }]),
    sessionCount: 1,
    diagnostics: { unknown_payload_kinds: 1 },
  },
  {
    name: "mixed_identity",
    input: jsonl([
      rows[0],
      { ...rows[1], stream: { kind: "session", id: "44444444-4444-4444-8444-444444444444" } },
    ]),
    sessionCount: 2,
    diagnostics: { unknown_payload_kinds: 1 },
  },
  {
    name: "exact_numbers",
    sessionCount: 1,
    diagnostics: { unknown_payload_kinds: 1 },
    input: jsonl([
      envelope(1, "synthetic.unknown", { integer: "INTEGER_TOKEN", decimal: "DECIMAL_TOKEN" }),
    ])
      .replace('"INTEGER_TOKEN"', "9007199254740993")
      .replace('"DECIMAL_TOKEN"', "1.234567890123456789"),
    verify: (_exported, outputText) => {
      const integer = /"integer":\s*([^,\s}]+)/.exec(outputText)?.[1];
      const decimal = /"decimal":\s*([^,\s}]+)/.exec(outputText)?.[1];
      assert.equal(integer, "9007199254740993");
      assert.equal(decimal, "1.2345678901234567");
      return { integer, decimal };
    },
  },
];
function invoke(args) {
  const run = spawnSync(binary, args, {
    cwd: root,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      PATH: "/usr/bin:/bin",
    },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, args[0]);
  return run.stdout;
}
try {
  const versionOutput = invoke(["--version"]);
  const exportHelp = invoke(["export", "--help"]);
  const results = [];
  for (const scenario of cases) {
    const { name, input } = scenario;
    const source = join(root, `${name}.jsonl`);
    const output = join(root, `${name}.export.json`);
    await writeFile(source, input);
    invoke(["export", "--session", source, "--out", output]);
    assert.equal(await readFile(source, "utf8"), input, `${name}: source changed`);
    const outputText = await readFile(output, "utf8");
    const exported = JSON.parse(outputText);
    assert.equal(exported.exporter_version.semver, "1.1.1");
    assert.equal(exported.exporter_version.sha, "b934305d21");
    assert.equal(exported.export_schema_version, 1);
    assert.equal(exported.sessions.length, scenario.sessionCount, name);
    assert.deepEqual(
      exported.diagnostics,
      {
        unparseable_lines: 0,
        unknown_payload_kinds: 0,
        gaps: 0,
        omitted_live_only: 0,
        duplicate_records: 0,
        ...scenario.diagnostics,
      },
      name,
    );
    results.push({
      name,
      exitCode: 0,
      sourceUnchanged: true,
      sessionCount: exported.sessions.length,
      diagnostics: exported.diagnostics,
      ...scenario.verify?.(exported, outputText),
    });
  }
  console.log(
    JSON.stringify(
      { binarySha256: sha256, reader: "1.1.1 / b934305d21", versionOutput, exportHelp, results },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
