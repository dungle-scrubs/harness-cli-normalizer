import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { transcriptStoreRoot } from "../../src/cli/store-root.js";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { normalizePopeye, parsePopeyeHistory } from "../../src/interpretation/transcript/popeye.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

const read = (name: string): string =>
  readFileSync(
    new URL(`../fixtures/popeye-0.1.4-reverify-2026-10-03/${name}`, import.meta.url),
    "utf8",
  );
const rows = (name: string) =>
  read(name)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("current source-built Popeye passes every applicable standard seven scenario", () => {
  const snapshot = JSON.parse(read("seven.snapshot.json"));
  expect(Object.keys(snapshot.results.popeye)).toHaveLength(7);
  for (const [name, cell] of Object.entries(snapshot.results.popeye)) {
    expect(cell).toMatchObject({ status: name === "tool-use" ? "skip" : "pass" });
  }
  expect(read("version.txt").trim()).toBe(popeyeCli.verifiedAgainst);
});

test("native Popeye HCN streaming records decode the live loopback response", () => {
  const state = freshDecodeState(null, "popeye");
  const events = read("seven-01.ndjson")
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(popeyeCli, line, state, "qwen3.6-35b-a3b-ud-mlx"));
  const tokens = events
    .filter((event) => event.kind === "token")
    .map((event) => event.text)
    .join("");
  const messages = events
    .filter((event) => event.kind === "message")
    .map((event) => event.text)
    .join("");
  expect(tokens.trim()).toBe("alpha");
  expect(messages.trim()).toBe("alpha");
});

test("the native journal retains the live assistant text and session binding", () => {
  const history = parsePopeyeHistory(read("journal.jsonl"));
  expect(history.entries).toHaveLength(7);
  const records = history.entries.map((entry) => normalizePopeye(entry, "LYHFppTK5tALkoRi"));
  expect(
    records
      .flatMap((record) => record.normalized.parts)
      .some((part) => part.text?.trim() === "alpha"),
  ).toBe(true);
  expect(history.identityRecord.sessionId).toBe("LYHFppTK5tALkoRi");
});

test("Popeye passive read refuses unavailable content even with coverage opt-ins", () => {
  const directory = mkdtempSync(join(tmpdir(), "hcn-popeye-evidence-"));
  const sessionId = "LYHFppTK5tALkoRi";
  const original = read("journal.jsonl");
  const root = transcriptStoreRoot("popeye", { env: {}, cwd: directory, home: directory });
  const path = join(root, `${sessionId}.jsonl`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path, original);
  const bun = spawnSync("which", ["bun"], { encoding: "utf8" });
  expect(bun.status, bun.stderr).toBe(0);
  const command = (flags: string[]) =>
    spawnSync(
      bun.stdout.trim(),
      [
        resolve("src/cli/index.ts"),
        "transcript",
        "read",
        "popeye",
        "--id",
        sessionId,
        "--cwd",
        directory,
        ...flags,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { HOME: directory, TMPDIR: directory, HCN_STATE_DIR: join(directory, "state") },
      },
    );
  try {
    const refused = command([]);
    expect(refused.error).toBeUndefined();
    expect(refused.status, refused.stderr).toBe(2);
    const refusal = refused.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(refusal.filter((row) => row.kind === "record")).toEqual([]);
    expect(refusal.at(-1)).toMatchObject({
      kind: "result",
      status: "refused",
      failure: { issue: "transcript-divergence" },
    });
    const accepted = command(["--accept-limits", "branches,original-records,embedded-content"]);
    expect(accepted.error).toBeUndefined();
    expect(accepted.status, `${accepted.stderr}\n${accepted.stdout}`).toBe(2);
    const output = accepted.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(output.filter((row) => row.kind === "record")).toEqual([]);
    expect(output.at(-1)).toMatchObject({
      kind: "result",
      status: "refused",
      recordsReturned: 0,
      failure: {
        issue: "transcript-divergence",
        requirement: "retrieval",
        guarantee: "embedded-content",
      },
    });
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Popeye escalation remains an unverified absence, not invented parity", () => {
  const observed = JSON.parse(read("escalation-capability.snapshot.json"));
  expect(observed.escalation).toEqual({ supported: false, source: "unknown", confidence: "none" });
  expect(capabilitiesOf(popeyeCli, "fake-model", "headless-turn").escalation).toEqual(
    observed.escalation,
  );
  expect(popeyeCli.contextInspection).toBeNull();
  expect(popeyeCli.nativeContextManagement).toBeNull();
});

test("accepted parser grants do not hide native agent and missing-journal failures", () => {
  expect(rows("explicit-grant.ndjson").at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  expect(rows("unknown-agent.ndjson").at(-1)).toMatchObject({
    kind: "done",
    cause: "crash",
    failure: { class: "native", nativeExitCode: 2 },
  });
  expect(rows("missing-resume.ndjson").at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { class: "task", retryable: false },
  });
});
