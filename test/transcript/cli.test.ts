import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

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
): { code: number | null; out: string; err: string } {
  const home = mkdtempSync(join(tmpdir(), "hcn-transcript-test-"));
  try {
    const run = spawnSync("bun", [resolve("src/cli/index.ts"), ...args], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: process.env.PATH,
        ...(agentDirectory ? { PI_CODING_AGENT_DIR: agentDirectory } : {}),
      },
    });
    if (run.error) throw run.error;
    return { code: run.status, err: run.stderr, out: run.stdout };
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

test("transcript inspection reports unverified Muse support without starting a native reader", () => {
  const result = command(["inspect", "muse", "--transcript"]);
  expect(result.code).toBe(0);
  const doc = JSON.parse(result.out);
  expect(doc.kind).toBe("transcript-capabilities");
  expect(doc.schemaVersion).toBe(1);
  expect(doc.harness).toBe("muse");
  expect(doc.methods).toEqual([]);
  expect(doc.capabilities.history.status).toBe("unknown");
  expect(Object.keys(doc.capabilities)).toHaveLength(8);
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

test("unverified readers and invalid transcript arguments return complete structured failures", () => {
  const refused = command(["transcript", "read", "muse", "--id", "synthetic-id"]);
  expect(refused.code).toBe(2);
  const envelopes = refused.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(envelopes.map((x) => x.kind)).toEqual(["source", "result"]);
  expect(envelopes[1].failure.issue).toBe("passive-read-unverified");
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
