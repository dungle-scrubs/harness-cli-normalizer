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

const captures = [
  { harness: claudeCode, directory: "claude-2.1.296", version: "2.1.296" },
  { harness: codexCli, directory: "codex-0.162.1", version: "0.162.1" },
  { harness: piCli, directory: "pi-1.1.0", version: "1.1.0" },
  { harness: museCode, directory: "muse-1.4.4-R5419.1", version: "1.4.4" },
  { harness: antigravityCli, directory: "antigravity-1.3.2", version: "1.3.2" },
  { harness: antigravityCli, directory: "antigravity-1.3.3", version: "1.3.3" },
];

test.each(captures)(
  "$directory fresh and question records still decode",
  ({ harness, directory, version }) => {
    expect(textOf(decoded(harness, directory, "fresh.ndjson"))).toBe("alpha");
    expect(
      detectQuestionBlock(textOf(decoded(harness, directory, "question.ndjson"))),
    ).toMatchObject({
      block: { question: expect.any(String), options: expect.any(Array) },
    });
    const questions = JSON.parse(read(directory, "questions.snapshot.json"));
    expect(questions.results[harness.name].status).toBe("pass");
    expect(questions.observations[harness.name]).toMatchObject({ version, date: "2026-10-10" });
  },
);

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
    expect(source.version).toBe(harness.verifiedAgainst);
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

test("Codex 0.162.1 local store metadata and later-process recall retain their evidence limits", () => {
  const metadata = JSON.parse(read("codex-0.162.1", "native-store-metadata.snapshot.json"));
  expect(metadata).toMatchObject({
    standing: "local-agent-observed-metadata",
    version: codexCli.verifiedAgainst,
    completion: { payloadType: "item_completed", itemType: "ContextCompaction", atLeast: 2 },
    installedReplacement: { recordType: "compacted", type: "array", nonempty: true },
  });
  expect(metadata.limits).toContain(
    "large rows were truncated; complete replacement contents and window links were not inspected",
  );
  expect(textOf(decoded(codexCli, "codex-0.162.1", "later-recall.ndjson"))).toBe(
    "HERON-CODEX-1010",
  );
});

test("Pi 1.1 RPC compaction still reports one completion", () => {
  const events = decoded(piCli, "pi-1.1.0", "compaction-rpc.ndjson");
  expect(
    events.filter((event) => event.kind === "compaction" && event.state === "compacted"),
  ).toHaveLength(1);
});

test("Claude 2.1.296 native accounting preserves the used count and input limit", () => {
  const accounting = (label: string) => {
    const native = JSON.parse(read("claude-2.1.296", `${label}.native.ndjson`));
    return contextInspectionOf(native.response.response);
  };
  expect(accounting("accounting-fresh")).toMatchObject({
    status: "available",
    method: "native-context-estimate",
    model: "claude-sonnet-5-5",
    totalTokens: 2778,
    contextWindowTokens: 1000000,
    inputLimitTokens: 967000,
  });
  const resumed = accounting("accounting-resume");
  expect(resumed).toMatchObject({ status: "available", inputLimitTokens: 967000 });
  if (resumed.status !== "available") throw new Error("Missing resumed accounting");
  expect(resumed.totalTokens).toBeGreaterThan(2778);
});

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
