import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, expect, test } from "vitest";

beforeAll(() => {
  const built = spawnSync("node", [resolve("scripts/build-native.ts"), "--stage"], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(built.status, built.stderr).toBe(0);
});

test("transcript output to a closed pipe exits nonzero", () => {
  const run = spawnSync(
    "bash",
    [
      "-c",
      'set -o pipefail\nbun "$1" inspect pi --transcript | head -c 0',
      "synthetic",
      resolve("src/cli/index.ts"),
    ],
    { encoding: "utf8" },
  );
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(1);
});

function command(
  args: string[],
  agentDirectory?: string,
  codexHome?: string,
  roots?: { claudeConfig?: string; museData?: string },
): { code: number | null; out: string; err: string } {
  const home = mkdtempSync(join(tmpdir(), "hcn-transcript-test-"));
  try {
    const run = spawnSync("bun", [resolve("src/cli/index.ts"), ...args], {
      encoding: "utf8",
      env: {
        HOME: home,
        TMPDIR: home,
        PATH: process.env.PATH,
        ...(agentDirectory ? { PI_CODING_AGENT_DIR: agentDirectory } : {}),
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...(roots?.claudeConfig ? { CLAUDE_CONFIG_DIR: roots.claudeConfig } : {}),
        ...(roots?.museData ? { XDG_DATA_HOME: roots.museData } : {}),
      },
    });
    if (run.error) throw run.error;
    return { code: run.status, err: run.stderr, out: run.stdout };
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

test("Claude exports a caller-selected main transcript through a filesystem snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-claude-source-"));
  try {
    const path = join(directory, "synthetic.jsonl");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const original = `${JSON.stringify({
      type: "user",
      uuid: "22222222-2222-4222-8222-222222222222",
      parentUuid: null,
      sessionId,
      isSidechain: false,
      version: "2.1.233",
      cwd: directory,
      message: { role: "user", content: "synthetic question" },
    })}\n`;
    writeFileSync(path, original);
    const read = command(["transcript", "read", "claude", "--file", path]);
    expect(read.code, read.err).toBe(0);
    const [source, record, result] = read.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(source.conversation.nativeId).toBe(sessionId);
    expect(source.methodId).toBe("claude-file-v1");
    expect(source.nativeHeaders).toEqual([]);
    expect(record.normalized.parts[0].text).toBe("synthetic question");
    expect(result.status).toBe("complete");
    expect(result.consistency.method).toBe("native-snapshot");
    expect(typeof result.bookmark).toBe("string");
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Muse pages retained envelopes, accepts appended records and refuses a rewritten bookmark prefix", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-muse-source-"));
  try {
    const path = join(directory, "session.jsonl");
    const row = (sequence: number, text: string) => ({
      schema_version: 1,
      id: `record-${sequence}`,
      stream: { kind: "session", id: "synthetic-session" },
      sequence,
      recorded_at: 1771088000123456,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "runtime.session",
      payload_schema_version: 1,
      payload: {
        kind: "run",
        run_id: "synthetic-run",
        event: { kind: "assistant_message_committed", text },
      },
    });
    const content = [row(42, "first"), row(43, "second")];
    const save = () =>
      writeFileSync(path, `${content.map((item) => JSON.stringify(item)).join("\n")}\n`);
    save();
    const first = command(["transcript", "read", "muse", "--file", path, "--limit", "1"]);
    expect(first.code, first.err).toBe(0);
    const initial = first.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bookmark = initial.at(-1).bookmark;
    expect(initial[0].methodId).toBe("muse-file-v1");
    expect(initial[0].nativeHeaders).toEqual([]);
    expect(initial.at(-1).more).toBe(true);
    content.push(row(44, "third"));
    save();
    const next = command(["transcript", "read", "muse", "--file", path, "--since", bookmark]);
    expect(next.code, next.err).toBe(0);
    const continued = next.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      continued
        .filter((item) => item.kind === "record")
        .map((item) => item.normalized.parts[0].text),
    ).toEqual(["second", "third"]);
    expect(continued.at(-1).consistency.method).toBe("native-snapshot");
    content[0] = row(42, "rewritten first");
    save();
    const changed = command(["transcript", "read", "muse", "--file", path, "--since", bookmark]);
    expect(changed.code).toBe(1);
    const result = JSON.parse(changed.out.trim().split("\n").at(-1) ?? "{}");
    expect(result.failure.issue).toBe("fresh-read-required");
    expect(result.bookmark).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude and Muse resolve native IDs in their own stores and reject duplicate matches", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-native-id-"));
  const id = "11111111-1111-4111-8111-111111111111";
  try {
    const cases = [
      {
        harness: "claude",
        relative: `projects/workspace/${id}.jsonl`,
        duplicate: `projects/other/${id}.jsonl`,
        row: {
          type: "user",
          uuid: "native-entry",
          parentUuid: null,
          sessionId: id,
          isSidechain: false,
          version: "2.1.233",
          cwd: directory,
          message: { role: "user", content: "question" },
        },
      },
      {
        harness: "muse",
        relative: `muse/sessions/2026/09/12/${id}/session.jsonl`,
        duplicate: `muse/sessions/2026/09/11/${id}/session.jsonl`,
        row: {
          schema_version: 1,
          id: "native-entry",
          stream: { kind: "session", id },
          sequence: 1,
          recorded_at: 1771088000123456,
          record_type: "event",
          durability: "durable",
          causation_id: null,
          payload_type: "runtime.session",
          payload_schema_version: 1,
          payload: { kind: "run", event: { kind: "started", prompt: "question" } },
        },
      },
    ];
    for (const item of cases) {
      const roots = { claudeConfig: directory, museData: directory };
      const path = join(directory, item.relative);
      mkdirSync(resolve(path, ".."), { recursive: true });
      const original = `${JSON.stringify(item.row)}\n`;
      writeFileSync(path, original);
      const read = command(
        ["transcript", "read", item.harness, "--id", id],
        undefined,
        undefined,
        roots,
      );
      expect(read.code, read.out).toBe(0);
      const source = JSON.parse(read.out.split("\n")[0] ?? "{}");
      expect(source.conversation.nativeId).toBe(id);
      expect(source.sources[0].location).toBe(path);
      const duplicate = join(directory, item.duplicate);
      mkdirSync(resolve(duplicate, ".."), { recursive: true });
      writeFileSync(duplicate, original);
      const ambiguous = command(
        ["transcript", "read", item.harness, "--id", id],
        undefined,
        undefined,
        roots,
      );
      expect(ambiguous.code).toBe(1);
      expect(JSON.parse(ambiguous.out.trim().split("\n").at(-1) ?? "{}").failure.issue).toBe(
        "source-ambiguous",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transcript inspection reports Muse's file method without starting a native reader", () => {
  const result = command(["inspect", "muse", "--transcript"]);
  expect(result.code).toBe(0);
  const doc = JSON.parse(result.out);
  expect(doc.kind).toBe("transcript-capabilities");
  expect(doc.schemaVersion).toBe(1);
  expect(doc.harness).toBe("muse");
  expect(doc.methods.map((method: { id: string }) => method.id)).toEqual(["muse-file-v1"]);
  expect(doc.capabilities.history.status).toBe("available");
  expect(Object.keys(doc.capabilities)).toHaveLength(8);
  expect(doc.verifiedAgainst).toBe("1.1.1");
  expect(doc.capabilities.history.evidence[1].appliesTo.writerBuilds).toContainEqual({
    version: "1.1.1",
    buildId: "1.1.1-R2514.1",
  });
});

test("Muse reports a missing native source without creating a conversation or advancing a bookmark", () => {
  const read = command([
    "transcript",
    "read",
    "muse",
    "--file",
    "/synthetic/does-not-exist.jsonl",
    "--accept-limits",
    "history,branches,original-records,embedded-content",
  ]);
  expect(read.code).toBe(1);
  const [source, result] = read.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(source.sources).toEqual([]);
  expect(source.conversation).toBeNull();
  expect(result.failure.issue).toBe("source-not-found");
  expect(result.failure.hint).toBeNull();
  expect(result.bookmark).toBeNull();
});

test("Claude reports its snapshot method and a missing native ID despite coverage opt-ins", () => {
  const inspection = JSON.parse(command(["inspect", "claude", "--transcript"]).out);
  expect(inspection.verifiedAgainst).toBe("2.1.263");
  expect(inspection.methods.map((method: { id: string }) => method.id)).toEqual(["claude-file-v1"]);
  expect(inspection.methods[0].selectors).toEqual(["id", "file"]);
  expect(inspection.capabilities.history.status).toBe("available");
  expect(
    inspection.rules.find((rule: { id: string }) => rule.id === "claude-snapshot-v1").description,
  ).toContain("no ordinary-copy fallback");
  expect(inspection.capabilities.history.evidence[1].appliesTo.writerBuilds[0].version).toBe(
    "2.1.233",
  );
  const read = command([
    "transcript",
    "read",
    "claude",
    "--id",
    "11111111-1111-4111-8111-111111111111",
    "--accept-limits",
    "history,branches,original-records,embedded-content",
  ]);
  expect(read.code).toBe(1);
  const [source, result] = read.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(source.selection.storeRoots).toHaveLength(1);
  expect(source.selection.storeRoots[0]).toMatch(/\/\.claude\/projects$/);
  expect(source.sources).toEqual([]);
  expect(result.failure.issue).toBe("source-not-found");
  expect(result.failure.hint).toBeNull();
});

test("exports retained Pi branches and tool results without modifying history or losing native values", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-pi-source-"));
  const file = join(directory, "synthetic.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "synthetic-conversation",
    timestamp: "2026-09-11T00:00:00.000Z",
    cwd: directory,
  };
  const entries = [
    {
      type: "message",
      id: "a",
      parentId: null,
      timestamp: header.timestamp,
      message: { role: "user", content: "synthetic question" },
    },
    {
      type: "message",
      id: "b",
      parentId: "a",
      timestamp: header.timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-one", name: "synthetic", arguments: { sample: true } },
        ],
      },
    },
    {
      type: "message",
      id: "c",
      parentId: "b",
      timestamp: header.timestamp,
      message: {
        role: "toolResult",
        toolCallId: "call-one",
        toolName: "synthetic",
        content: [{ type: "text", text: "synthetic result" }],
      },
    },
    {
      type: "message",
      id: "d",
      parentId: "a",
      timestamp: header.timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "retained sibling" }] },
    },
    {
      type: "compaction",
      id: "e",
      parentId: "d",
      timestamp: header.timestamp,
      firstKeptEntryId: "a",
      summary: "synthetic summary",
      custom: { count: "LARGE_NUMBER" },
    },
  ];
  const input = `${[header, ...entries]
    .map((x) => JSON.stringify(x))
    .join("\n")
    .replace('"LARGE_NUMBER"', "9007199254740993")}\n`;
  writeFileSync(file, input);
  try {
    const result = command(["transcript", "read", "pi", "--file", file]);
    expect(result.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(input);
    expect(result.out).toContain("9007199254740993");
    const output = result.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(output.map((x) => x.kind)).toEqual([
      "source",
      "record",
      "record",
      "record",
      "record",
      "record",
      "result",
    ]);
    expect(output[0].conversation.nativeId).toBe(header.id);
    expect(output[0].nativeHeaders[0].original).toEqual(header);
    expect(output.slice(1, -1).map((x) => x.nativeId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(output[3].normalized.parts[0].text).toBe("synthetic result");
    expect(output[3].normalized.relationships["tool-call"].targets[0].nativeId).toBe("call-one");
    expect(output[5].normalized.relationships["first-kept-entry"].targets[0].nativeId).toBe("a");
    expect(output[6].status).toBe("complete");
    expect(output[6].coverage.history.state).toBe("complete");
    expect(output[6].activeBranch.view).toBe("saved");
    expect(
      output[6].consistency.checks.every((x: { outcome: string }) => x.outcome === "passed"),
    ).toBe(true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("missing native IDs and invalid transcript arguments return complete structured failures", () => {
  const refused = command(["transcript", "read", "muse", "--id", "synthetic-id"]);
  expect(refused.code).toBe(1);
  const envelopes = refused.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(envelopes.map((x) => x.kind)).toEqual(["source", "result"]);
  expect(envelopes[1].failure.issue).toBe("source-not-found");
  expect(envelopes[1].bookmark).toBeNull();
  const invalid = command(["inspect", "pi", "--transcript", "--argv"]);
  expect(invalid.code).toBe(2);
  expect(JSON.parse(invalid.out).kind).toBe("transcript-inspection-error");
  expect(JSON.parse(invalid.out).failure.issue).toBe("mutually-exclusive-options");
});

test("bookmarks read after a verified prefix and reject an edited prefix even when its last ID survives", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-pi-bookmark-"));
  const file = join(directory, "synthetic.jsonl");
  const header = { type: "session", version: 3, id: "synthetic-bookmark", cwd: directory };
  const entry = (id: string, parentId: string | null, text: string) => ({
    type: "message",
    id,
    parentId,
    message: { role: "user", content: text },
  });
  const input = `${[
    header,
    entry("a", null, "original"),
    entry("b", "a", "anchor"),
    entry("c", "b", "later"),
  ]
    .map((x) => JSON.stringify(x))
    .join("\n")}\n`;
  writeFileSync(file, input);
  try {
    const initial = command(["transcript", "read", "pi", "--file", file, "--limit", "2"]);
    expect(initial.code).toBe(0);
    const first = initial.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(first.at(-1).more).toBe(true);
    const bookmark: string = first.at(-1).bookmark;
    expect(bookmark).toMatch(/^[A-Za-z0-9_-]+$/);
    const next = command(["transcript", "read", "pi", "--file", file, "--since", bookmark]);
    expect(next.code).toBe(0);
    const second = next.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(second.filter((x) => x.kind === "record").map((x) => x.nativeId)).toEqual(["c"]);
    expect(second.at(-1).continuation.input).toBe("verified");
    writeFileSync(file, input.replace("original", "modified"));
    const changed = command(["transcript", "read", "pi", "--file", file, "--since", bookmark]);
    expect(changed.code).toBe(1);
    const failed = changed.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(failed.failure.issue).toBe("fresh-read-required");
    expect(failed.continuation.input).toBe("invalid");
    expect(failed.bookmark).toBeNull();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("native ID lookup finds exactly one Pi conversation and rejects duplicate identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-pi-id-"));
  const workspace = join(directory, "project");
  const store = join(
    directory,
    "sessions",
    `--${workspace.replace(/^[/]/, "").replace(/[/:]/g, "-")}--`,
  );
  mkdirSync(store, { recursive: true });
  const nativeId = "11111111-2222-4333-8444-555555555555";
  const content = `${JSON.stringify({ type: "session", version: 3, id: nativeId, cwd: workspace })}\n`;
  writeFileSync(join(store, `2026-09-11_${nativeId}.jsonl`), content);
  try {
    const result = command(
      ["transcript", "read", "pi", "--id", nativeId, "--cwd", workspace],
      directory,
    );
    expect(result.code).toBe(0);
    const source = JSON.parse(result.out.split("\n")[0] ?? "{}");
    expect(source.selection.kind).toBe("id");
    expect(source.conversation.nativeId).toBe(nativeId);
    writeFileSync(join(store, `2026-09-12_${nativeId}.jsonl`), content);
    const duplicate = command(
      ["transcript", "read", "pi", "--id", nativeId, "--cwd", workspace],
      directory,
    );
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.out.trim().split("\n").at(-1) ?? "{}").failure.issue).toBe(
      "source-ambiguous",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex refuses an interrupted subagent inherited-context initialization", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-codex-subagent-"));
  const file = join(directory, "synthetic.jsonl");
  const header = {
    ordinal: 0,
    type: "session_meta",
    payload: {
      id: "synthetic",
      cli_version: "0.147.0",
      history_mode: "paginated",
      subagent_history_start_ordinal: 5,
    },
  };
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  try {
    const result = command(["transcript", "read", "codex", "--file", file]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.trim().split("\n").at(-1) ?? "{}").failure.issue).toBe(
      "guarantee-unmet",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex rejects missing, mismatched, cyclic and malformed inherited ranges", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-codex-invalid-lineage-"));
  const store = join(directory, "sessions");
  mkdirSync(store);
  const parentId = "11111111-2222-4333-8444-555555555555";
  const childId = "11111111-2222-4333-8444-666666666666";
  const parentFile = join(store, `rollout-2026-09-11T00-00-00-${parentId}.jsonl`);
  const childFile = join(directory, "child.jsonl");
  const parent = `${JSON.stringify({ type: "session_meta", ordinal: 0, payload: { id: parentId, cli_version: "0.147.0", history_mode: "paginated" } })}\n`;
  const base = {
    thread_id: parentId,
    end_byte_offset: Buffer.byteLength(parent),
    end_ordinal_exclusive: 1,
  };
  const cases = [
    { content: null, base, issue: "source-not-found" },
    { content: parent.replace(parentId, childId), base, issue: "source-identity-mismatch" },
    { content: parent, base: { ...base, thread_id: childId }, issue: "guarantee-unmet" },
    {
      content: parent,
      base: { ...base, end_byte_offset: base.end_byte_offset - 1 },
      issue: "guarantee-unmet",
    },
    { content: parent, base: { ...base, end_ordinal_exclusive: 2 }, issue: "guarantee-unmet" },
  ];
  try {
    for (const scenario of cases) {
      rmSync(parentFile, { force: true });
      if (scenario.content !== null) writeFileSync(parentFile, scenario.content);
      writeFileSync(
        childFile,
        `${JSON.stringify({ type: "session_meta", ordinal: scenario.base.end_ordinal_exclusive, payload: { id: childId, cli_version: "0.147.0", history_mode: "paginated", history_base: scenario.base } })}\n`,
      );
      const result = command(
        ["transcript", "read", "codex", "--file", childFile],
        undefined,
        directory,
      );
      expect(result.code).toBe(1);
      const final = JSON.parse(result.out.trim().split("\n").at(-1) ?? "{}");
      expect(final.failure.issue).toBe(scenario.issue);
      expect(final.bookmark).toBeNull();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex assembles only the inherited prefix and pages across physical sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-codex-lineage-"));
  const store = join(directory, "sessions");
  mkdirSync(store);
  const parentId = "11111111-2222-4333-8444-555555555555";
  const childId = "11111111-2222-4333-8444-666666666666";
  const parentFile = join(store, `rollout-2026-09-11T00-00-00-${parentId}.jsonl`);
  const childFile = join(store, `rollout-2026-09-12T00-00-00-${childId}.jsonl`);
  const header = (id: string, ordinal: number, base: unknown = null) => ({
    type: "session_meta",
    ordinal,
    payload: { id, cli_version: "0.147.0", history_mode: "paginated", history_base: base },
  });
  const entry = (ordinal: number, text: string) => ({
    ordinal,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  const lines = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const prefix = lines([header(parentId, 0), entry(1, "inherited")]);
  writeFileSync(parentFile, prefix + lines([entry(2, "parent-only")]));
  writeFileSync(
    childFile,
    lines([
      header(childId, 2, {
        thread_id: parentId,
        end_ordinal_exclusive: 2,
        end_byte_offset: Buffer.byteLength(prefix),
      }),
      entry(3, "child"),
    ]),
  );
  const read = (args: string[]) => {
    const result = command(
      ["transcript", "read", "codex", "--file", childFile, ...args],
      undefined,
      directory,
    );
    return {
      code: result.code,
      rows: result.out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  };
  try {
    const first = read(["--limit", "1"]);
    expect(first.code).toBe(0);
    expect(first.rows[0].conversation.nativeId).toBe(childId);
    expect(first.rows[0].sources.map((source: { nativeId: string }) => source.nativeId)).toEqual([
      parentId,
      childId,
    ]);
    expect(first.rows[1].original).toEqual(entry(1, "inherited"));
    expect(first.rows.at(-1).more).toBe(true);
    const bookmark = first.rows.at(-1).bookmark;
    const second = read(["--since", bookmark]);
    expect(second.code).toBe(0);
    expect(second.rows.filter((row) => row.kind === "record").map((row) => row.original)).toEqual([
      entry(3, "child"),
    ]);
    expect(second.rows[1].sourceKey).toBe("source-1");
    expect(second.rows[1].position.sourceKey).toBe("source-1");
    writeFileSync(parentFile, prefix.replace("inherited", "rewritten"));
    const changed = read(["--since", bookmark]);
    expect(changed.code).toBe(1);
    expect(changed.rows.at(-1).failure.issue).toBe("fresh-read-required");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex ID lookup includes archived rollouts and refuses ambiguous native sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-codex-id-"));
  const id = "11111111-2222-4333-8444-555555555555";
  const archived = join(directory, "archived_sessions", "2026", "09", "11");
  const active = join(directory, "sessions", "2026", "09", "12");
  mkdirSync(archived, { recursive: true });
  mkdirSync(active, { recursive: true });
  const input = `${JSON.stringify({ type: "session_meta", payload: { id, cli_version: "0.147.0" } })}\n`;
  writeFileSync(join(archived, `rollout-2026-09-11T00-00-00-${id}.jsonl`), input);
  try {
    const first = command(["transcript", "read", "codex", "--id", id], undefined, directory);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out.split("\n")[0] ?? "{}").conversation.nativeId).toBe(id);
    writeFileSync(join(active, `rollout-2026-09-12T00-00-00-${id}.jsonl`), input);
    const duplicate = command(["transcript", "read", "codex", "--id", id], undefined, directory);
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.out.trim().split("\n").at(-1) ?? "{}").failure.issue).toBe(
      "source-ambiguous",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex batches preserve source positions and invalidate a changed committed prefix", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-codex-pages-"));
  const file = join(directory, "synthetic.jsonl");
  const header = { type: "session_meta", payload: { id: "synthetic", cli_version: "0.147.0" } };
  const entries = ["before", "after"].map((text) => ({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  }));
  const input = `${[header, ...entries].map((row) => JSON.stringify(row)).join("\n")}\n`;
  const read = (args: string[]) => {
    const result = command(["transcript", "read", "codex", "--file", file, ...args]);
    return {
      code: result.code,
      rows: result.out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  };
  writeFileSync(file, input);
  try {
    const first = read(["--limit", "1"]);
    expect(first.code).toBe(0);
    expect(first.rows.at(-1).more).toBe(true);
    const bookmark = first.rows.at(-1).bookmark;
    const second = read(["--since", bookmark]);
    expect(second.code).toBe(0);
    expect(second.rows.filter((row) => row.kind === "record").map((row) => row.original)).toEqual([
      entries[1],
    ]);
    expect(second.rows[1].position).not.toEqual(first.rows[1].position);
    expect(second.rows.at(-1).continuation.input).toBe("verified");
    writeFileSync(file, input.replace("before", "edited"));
    const changed = read(["--since", bookmark]);
    expect(changed.code).toBe(1);
    expect(changed.rows.at(-1).failure.issue).toBe("fresh-read-required");
    expect(changed.rows.at(-1).bookmark).toBeNull();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex legacy export preserves retained rollout items and refuses a paginated suffix as full history", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-codex-source-"));
  const file = join(directory, "synthetic.jsonl");
  const header = {
    type: "session_meta",
    timestamp: "2026-09-11T00:00:00.000Z",
    payload: {
      id: "11111111-2222-4333-8444-555555555555",
      session_id: "11111111-2222-4333-8444-555555555555",
      cwd: directory,
      cli_version: "0.147.0",
      history_mode: "legacy",
    },
  };
  const rows = [
    header,
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "synthetic-call",
        name: "shell_command",
        arguments: "{}",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "synthetic-call",
        output: "synthetic result",
      },
    },
    { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
  ];
  const input = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(file, input);
  try {
    const exported = command(["transcript", "read", "codex", "--file", file]);
    expect(exported.code).toBe(0);
    const output = exported.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(output.slice(1, -1).map((row) => row.original)).toEqual(rows.slice(1));
    expect(output[1].nativeId).toBeNull();
    expect(output[2].normalized.parts[0].text).toBe("synthetic result");
    expect(output[2].normalized.relationships["tool-call"].targets[0].scope.sourceKey).toBeNull();
    expect(output.at(-1).historicalLoss.state).toBe("known-loss");
    expect(output.at(-1).coverage.history.state).toBe("complete");
    writeFileSync(file, input.replace('"history_mode":"legacy"', '"history_mode":"paginated"'));
    const segmented = command(["transcript", "read", "codex", "--file", file]);
    expect(segmented.code).toBe(1);
    expect(JSON.parse(segmented.out.trim().split("\n").at(-1) ?? "{}").failure.issue).toBe(
      "guarantee-unmet",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("invalid bookmark encoding is refused without claiming it was checked against a source", () => {
  const run = command([
    "transcript",
    "read",
    "pi",
    "--file",
    "/synthetic/no-source",
    "--since",
    "not!base64",
  ]);
  expect(run.code).toBe(2);
  const result = JSON.parse(run.out.trim().split("\n").at(-1) ?? "{}");
  expect(result.failure.issue).toBe("invalid-option-value");
  expect(result.continuation.input).toBe("not-checked");
});

test("transcript help and version describe passive export without opening history", () => {
  const help = command(["transcript", "--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("--accept-limits");
  expect(help.out).toContain("--since");
  expect(command(["transcript", "--version"]).code).toBe(0);
});
