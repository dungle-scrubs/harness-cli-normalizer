import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { contextInspectionOf } from "../../src/interpretation/context-inspection.js";
import { museCompactionOf } from "../../src/interpretation/muse-compaction.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const read = (directory: string, file: string): string =>
  readFileSync(new URL(`../fixtures/${directory}/${file}`, import.meta.url), "utf8");

const decoded = (harness: HarnessDescriptor, directory: string, file: string): HarnessEvent[] => {
  const state = freshDecodeState(null, harness.name);
  return read(directory, file)
    .trim()
    .split("\n")
    .flatMap((line) =>
      decodeLine(harness, line, state, harness.escalation.observedOn?.model ?? "captured-model"),
    );
};

const textOf = (events: readonly HarnessEvent[]): string =>
  events
    .filter((event) => event.kind === "message")
    .map((event) => event.text)
    .join("\n")
    .trim();

// Fresh and question captures across both verification generations. Rows
// marked `current` are the anchors the descriptors point at (issue 416,
// 2026-10-20); the earlier rows are history that must keep decoding, with
// their own capture date. Assertions comparing a capture to its
// descriptor's current anchor run only for current rows.
const freshQuestionCaptures: {
  harness: HarnessDescriptor;
  directory: string;
  version: string;
  date: string;
  current: boolean;
}[] = [
  {
    harness: claudeCode,
    directory: "claude-2.1.296",
    version: "2.1.296",
    date: "2026-10-10",
    current: false,
  },
  {
    harness: codexCli,
    directory: "codex-0.162.1",
    version: "0.162.1",
    date: "2026-10-10",
    current: false,
  },
  { harness: piCli, directory: "pi-1.1.0", version: "1.1.0", date: "2026-10-10", current: false },
  {
    harness: museCode,
    directory: "muse-1.4.4-R5419.1",
    version: "1.4.4",
    date: "2026-10-10",
    current: false,
  },
  {
    harness: antigravityCli,
    directory: "antigravity-1.3.2",
    version: "1.3.2",
    date: "2026-10-10",
    current: false,
  },
  {
    harness: antigravityCli,
    directory: "antigravity-1.3.3",
    version: "1.3.3",
    date: "2026-10-10",
    current: false,
  },
  {
    harness: claudeCode,
    directory: "claude-2.1.304",
    version: "2.1.304",
    date: "2026-10-20",
    current: true,
  },
  {
    harness: codexCli,
    directory: "codex-0.163.0",
    version: "0.163.0",
    date: "2026-10-20",
    current: true,
  },
  { harness: piCli, directory: "pi-1.3.0", version: "1.3.0", date: "2026-10-20", current: true },
];

test.each(freshQuestionCaptures)(
  "$directory fresh and question records still decode",
  ({ harness, directory, version, date, current }) => {
    expect(textOf(decoded(harness, directory, "fresh.ndjson"))).toBe("alpha");
    expect(
      detectQuestionBlock(textOf(decoded(harness, directory, "question.ndjson"))),
    ).toMatchObject({
      block: { question: expect.any(String), options: expect.any(Array) },
    });
    const questions = JSON.parse(read(directory, "questions.snapshot.json"));
    expect(questions.results[harness.name].status).toBe("pass");
    expect(questions.observations[harness.name]).toMatchObject({ version, date });
    if (current) {
      expect(questions.observations[harness.name]).toEqual(harness.escalation.observedOn);
      const source = JSON.parse(read(directory, "version-source.snapshot.json"));
      expect(source.version).toBe(harness.verifiedAgainst);
      expect(source.latest).toBe(harness.verifiedAgainst);
      expect(source.versionSource).toEqual(harness.versionSource);
    }
  },
);

// Completed-compaction and later-process recall captures across both
// generations. `version` is the capture's own version-source reading, which
// stays the capture's own after the descriptor anchors move on.
test.each([
  {
    harness: claudeCode,
    directory: "claude-2.1.296",
    version: "2.1.296",
    marker: "HERON-CLAUDE-1010",
  },
  { harness: piCli, directory: "pi-1.1.0", version: "1.1.0", marker: "HERON-PI-1010" },
  {
    harness: antigravityCli,
    directory: "antigravity-1.3.3",
    version: "1.3.3",
    marker: "LANTERN-133-1010",
  },
  {
    harness: claudeCode,
    directory: "claude-2.1.304",
    version: "2.1.304",
    marker: "HERON-CLAUDE-1010",
  },
  { harness: piCli, directory: "pi-1.3.0", version: "1.3.0", marker: "HERON-PI-1010" },
])(
  "$directory completed compaction and later-process recall decode",
  ({ harness, directory, version, marker }) => {
    const events = decoded(harness, directory, "compaction.ndjson");
    expect(
      events.filter((event) => event.kind === "compaction" && event.state === "compacted"),
    ).toHaveLength(1);
    expect(textOf(decoded(harness, directory, "later-recall.ndjson"))).toBe(marker);
    const source = JSON.parse(read(directory, "version-source.snapshot.json"));
    expect(source.version).toBe(version);
    expect(source.versionSource).toEqual(harness.versionSource);
  },
);

test("Antigravity 1.3.2 historical compaction and recall remain decodable", () => {
  const directory = "antigravity-1.3.2";
  expect(
    decoded(antigravityCli, directory, "compaction.ndjson").filter(
      (event) => event.kind === "compaction" && event.state === "compacted",
    ),
  ).toHaveLength(1);
  expect(textOf(decoded(antigravityCli, directory, "later-recall.ndjson"))).toBe("LANTERN-1010");
  expect(JSON.parse(read(directory, "version-source.snapshot.json"))).toMatchObject({
    version: "1.3.2",
    versionSource: { kind: "installed" },
  });
});

// Codex local store metadata, both generations: the 0.163.0 row pins its
// version to the descriptor anchor; the 0.162.1 row is history with its own
// literal version.
test.each([
  { directory: "codex-0.162.1", version: "0.162.1" },
  { directory: "codex-0.163.0", version: codexCli.verifiedAgainst },
])(
  "$directory local store metadata and later-process recall retain their evidence limits",
  ({ directory, version }) => {
    const metadata = JSON.parse(read(directory, "native-store-metadata.snapshot.json"));
    expect(metadata).toMatchObject({
      standing: "local-agent-observed-metadata",
      version,
      completion: { payloadType: "item_completed", itemType: "ContextCompaction", atLeast: 2 },
      installedReplacement: { recordType: "compacted", type: "array", nonempty: true },
    });
    expect(metadata.limits).toContain(
      "large rows were truncated; complete replacement contents and window links were not inspected",
    );
    expect(textOf(decoded(codexCli, directory, "later-recall.ndjson"))).toBe("HERON-CODEX-1010");
  },
);

// Pi RPC compaction, both generations; the 1.3.0 row also pins the
// installed-compactions snapshot.
test.each([
  { directory: "pi-1.1.0", installed: false },
  { directory: "pi-1.3.0", installed: true },
])("$directory RPC compaction still reports one completion", ({ directory, installed }) => {
  const events = decoded(piCli, directory, "compaction-rpc.ndjson");
  expect(
    events.filter((event) => event.kind === "compaction" && event.state === "compacted"),
  ).toHaveLength(1);
  if (installed) {
    const installedCompactions = JSON.parse(read(directory, "installed-compactions.snapshot.json"));
    expect(installedCompactions).toHaveLength(1);
    expect(installedCompactions[0].summary).toContain("HERON-PI-1010");
  }
});

// Claude native accounting, both generations; the 2.1.304 row also pins the
// source-unchanged hash snapshot.
test.each([
  { directory: "claude-2.1.296", totalTokens: 2778, hashes: false },
  { directory: "claude-2.1.304", totalTokens: 2565, hashes: true },
])(
  "$directory native accounting preserves the used count and input limit",
  ({ directory, totalTokens, hashes }) => {
    const accounting = (label: string) => {
      const native = JSON.parse(read(directory, `${label}.native.ndjson`));
      return contextInspectionOf(native.response.response);
    };
    expect(accounting("accounting-fresh")).toMatchObject({
      status: "available",
      method: "native-context-estimate",
      model: "claude-sonnet-5-5",
      totalTokens,
      contextWindowTokens: 1000000,
      inputLimitTokens: 967000,
    });
    const resumed = accounting("accounting-resume");
    expect(resumed).toMatchObject({ status: "available", inputLimitTokens: 967000 });
    if (resumed.status !== "available") throw new Error("Missing resumed accounting");
    expect(resumed.totalTokens).toBeGreaterThan(totalTokens);
    if (hashes) {
      const hashesSnapshot = JSON.parse(read(directory, "accounting-source-hashes.snapshot.json"));
      expect(hashesSnapshot).toMatchObject({ unchanged: true });
    }
  },
);

test("Muse 1.4.4 terminal compaction items normalize the native counts", () => {
  const items: unknown[] = JSON.parse(read("muse-1.4.4-R5419.1", "compaction-items.snapshot.json"));
  const compactions = items.map(museCompactionOf).filter((item) => item !== null);
  expect(compactions).toHaveLength(1);
  expect(compactions[0]).toMatchObject({
    state: "compacted",
    trigger: "auto",
    tokensBefore: 170718,
    tokensAfter: 25861,
  });
});
