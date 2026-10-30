import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  APPROVED_PI_QUOTES,
  compareRecord,
  coveredFiles,
  type FileReceipt,
  fixtureRoot,
  marker,
  markersIn,
  NATIVE_CLAUDE_SKILLS,
  type OwnerLookup,
  PI_NATIVE_TOOL_DESCRIPTIONS,
  PI_QUOTE_LABEL,
  type Receipts,
  receiptsPath,
  sha256,
  verifyExcerpt,
} from "../../scripts/capture-receipts.ts";

// The issue-420 fixtures are excerpts of original native captures that stay on
// the capture machine. scripts/capture-receipts.ts verified each one against
// its capture and wrote these receipts; this gate holds the committed bytes to
// them and checks that only operator configuration was redacted.

const receipts = JSON.parse(readFileSync(receiptsPath, "utf8")) as Receipts;
const byFile = new Map(receipts.files.map((receipt) => [receipt.file, receipt]));
const fixture = (file: string) => readFileSync(join(fixtureRoot, file), "utf8");
const regenerate =
  "regenerate with `node scripts/capture-receipts.ts --evidence <original captures>`, which verifies the fixture against its capture first";

const CLAUDE_INIT_LABELS = new Set([
  "tools",
  "slash_commands",
  "agents",
  "skills",
  "mcp_servers.name",
  "plugins.name",
  "plugins.path",
  "plugins.source",
]);
const PI_INSTALLED_LABELS = new Set([
  "sections.project_context",
  "sections.docs",
  "sections.skills",
  "sections.rules",
  "sections.tools",
  "toolsAdded.description",
]);

const recordRedactions = (receipt: FileReceipt) =>
  receipt.records
    ? receipt.records.flatMap((record) =>
        Object.entries(record.redactions ?? {}).map(([label, value]) => ({
          label,
          markers: value.markers,
        })),
      )
    : Object.entries(receipt.redactions ?? {}).map(([label, value]) => ({
        label,
        markers: value.markers,
      }));

describe("captured fixtures match their receipts", () => {
  test("every covered fixture has a receipt and every receipt has a fixture", () => {
    const covered = coveredFiles();
    const missing = covered.filter((file) => !byFile.has(file));
    const stale = [...byFile.keys()].filter((file) => !covered.includes(file));
    expect(missing, `fixtures without a capture receipt; ${regenerate}`).toEqual([]);
    expect(stale, "receipts whose fixture no longer exists; regenerate the receipts").toEqual([]);
  });

  test.each(receipts.files.map((receipt) => [receipt.file, receipt] as const))(
    "%s holds the bytes its receipt approved",
    (file, receipt) => {
      const text = fixture(file);
      if (receipt.records) {
        const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [text];
        expect(lines.length, `${file} record count changed since its receipt`).toBe(
          receipt.records.length,
        );
        lines.forEach((line, index) => {
          const record = receipt.records?.[index];
          expect(
            sha256(line),
            `${file} line ${index + 1} (${record?.type} from source line ${record?.sourceLine}) changed since its receipt; ${regenerate}`,
          ).toBe(record?.sha256);
        });
      }
      expect(sha256(text), `${file} changed since its receipt; ${regenerate}`).toBe(receipt.sha256);
      expect(Buffer.byteLength(text)).toBe(receipt.bytes);
    },
  );

  test("every receipt cites its native capture, and excerpts keep source order", () => {
    for (const receipt of receipts.files) {
      if (receipt.transform === "version-anchor") {
        expect(receipt.file, "only the version anchor has no source capture").toMatch(
          /\/version\.txt$/,
        );
        expect(fixture(receipt.file)).toBe(`${receipt.version}\n`);
        continue;
      }
      expect(receipt.source?.sha256, `${receipt.file} has no source capture digest`).toMatch(
        /^[0-9a-f]{64}$/,
      );
      if (!receipt.transform.startsWith("excerpt:")) continue;
      const positions = receipt.records?.map((record) => record.sourceLine) ?? [];
      expect(positions.length, `${receipt.file} receipt lists no records`).toBeGreaterThan(0);
      positions.forEach((position, index) => {
        expect(
          Number.isSafeInteger(position) && position >= 1,
          `${receipt.file}: sourceLine ${position} is not a positive integer source line`,
        ).toBe(true);
        const previous = positions[index - 1];
        if (previous !== undefined)
          expect(
            position,
            `${receipt.file}: selected records must keep source order`,
          ).toBeGreaterThan(previous);
        expect(position).toBeLessThanOrEqual(receipt.source?.lines ?? 0);
      });
      for (const record of receipt.records ?? [])
        expect(record.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

test.each([["pi-1.4.0/compaction.ndjson"], ["pi-1.4.0/compaction-rpc.ndjson"]])(
  "%s keeps each compaction after the assistant turn that triggered it",
  (file) => {
    const kinds = fixture(file)
      .trimEnd()
      .split("\n")
      .map((line) => {
        const record = JSON.parse(line) as { type: string; message?: { role?: string } };
        return record.type === "message_end" ? `message_end/${record.message?.role}` : record.type;
      });
    const starts = kinds.flatMap((kind, index) => (kind === "compaction_start" ? [index] : []));
    expect(starts.length, `${file} has no compaction`).toBeGreaterThan(0);
    for (const index of starts) {
      expect(
        [kinds[index - 1], kinds[index + 1]],
        `${file}: compaction records were moved away from their source position`,
      ).toEqual(["message_end/assistant", "compaction_end"]);
    }
  },
);

describe("only operator configuration is redacted", () => {
  test.each(coveredFiles().map((file) => [file] as const))(
    "%s carries only approved redactions",
    (file) => {
      const text = fixture(file);
      const receipt = byFile.get(file);
      const found = markersIn(text);
      const approved = receipt ? recordRedactions(receipt) : [];
      expect(found.length, `${file} redaction markers differ from its receipt`).toBe(
        approved.reduce((total, entry) => total + entry.markers, 0),
      );
      if (found.length === 0) return;

      if (file.startsWith("claude-2.1.312/") && file.endsWith(".ndjson")) {
        const [initLine = "", ...rest] = text.split("\n");
        expect(
          markersIn(rest.join("\n")),
          `${file}: only the init record may carry redactions`,
        ).toEqual([]);
        const init = JSON.parse(initLine) as {
          subtype?: string;
          skills: string[];
          slash_commands: string[];
          plugins: { name: string; path: string; source?: string }[];
        };
        expect(init.subtype).toBe("init");
        for (const entry of markersIn(initLine))
          expect(
            CLAUDE_INIT_LABELS.has(entry.label),
            `${file}: ${entry.label} is not operator configuration`,
          ).toBe(true);
        for (const plugin of init.plugins.filter((candidate) => candidate.path === "builtin"))
          expect(
            markersIn(JSON.stringify(plugin)),
            `${file}: native builtin plugin ${plugin.name} was redacted`,
          ).toEqual([]);
        for (const skill of NATIVE_CLAUDE_SKILLS) {
          expect(init.skills, `${file}: native bundled skill ${skill} was redacted`).toContain(
            skill,
          );
          expect(
            init.slash_commands,
            `${file}: native bundled skill ${skill} was redacted`,
          ).toContain(skill);
        }
        return;
      }

      if (file === "pi-1.4.0/installed-compactions.snapshot.json") {
        for (const entry of found)
          expect(
            PI_INSTALLED_LABELS.has(entry.label),
            `${file}: ${entry.label} is not operator configuration`,
          ).toBe(true);
        const [installed] = JSON.parse(text) as {
          systemMessage: { toolsAdded: { name: string; description: string }[] };
        }[];
        const core = (installed?.systemMessage.toolsAdded ?? []).filter((tool) =>
          Object.hasOwn(PI_NATIVE_TOOL_DESCRIPTIONS, tool.name),
        );
        expect(core.map((tool) => tool.name).sort()).toEqual(
          Object.keys(PI_NATIVE_TOOL_DESCRIPTIONS).sort(),
        );
        for (const tool of core)
          expect(
            sha256(tool.description),
            `${file}: the native Pi 1.4.0 SDK description of ${tool.name} was redacted or changed`,
          ).toBe(PI_NATIVE_TOOL_DESCRIPTIONS[tool.name]);
        return;
      }

      expect(file, `${file} may not carry redactions`).toMatch(/^pi-1\.4\.0\/.*\.ndjson$/);
      for (const line of text.trimEnd().split("\n")) {
        const record = JSON.parse(line) as {
          message?: { content?: { type: string; thinking?: string }[] };
        };
        for (const block of record.message?.content ?? []) {
          const masks = markersIn(block.thinking ?? "");
          if (block.type !== "thinking" || masks.length === 0) continue;
          for (const entry of masks) {
            expect(entry.label, `${file}: mask only approved operator quotes inside thinking`).toBe(
              PI_QUOTE_LABEL,
            );
            expect(APPROVED_PI_QUOTES.map((quote) => quote.characters)).toContain(entry.characters);
          }
          const remaining = (block.thinking ?? "").replaceAll(/<redacted: [^>]*>/g, "").trim();
          expect(
            remaining.length,
            `${file}: an ordinary thinking block was replaced whole`,
          ).toBeGreaterThan(0);
        }
        const outside =
          markersIn(line).length -
          (record.message?.content ?? []).reduce(
            (total, block) => total + markersIn(block.thinking ?? "").length,
            0,
          );
        expect(outside, `${file}: only thinking quotes may be redacted in Pi records`).toBe(0);
      }
    },
  );
});

describe("the receipt generator refuses altered native records", () => {
  const owners: OwnerLookup = (kind, name) => kind === "agent" && name === "operator-agent";
  const init = (fields: Record<string, unknown>) =>
    JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["Bash"],
      agents: ["Explore"],
      skills: ["run"],
      plugins: [],
      ...fields,
    });
  const initPolicy = { kind: "claude-init", owners } as const;

  test("a native message text edit", () => {
    const source = '{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]}}';
    expect(() => compareRecord(source, source.replace("PONG", "PING"), { kind: "none" })).toThrow(
      "native text changed at message.content[].text",
    );
  });

  test("a record swap, even when every record is native", () => {
    const source = [
      '{"type":"session","id":"a"}',
      '{"type":"message_end","message":{"role":"assistant","n":1}}',
      '{"type":"compaction_start"}',
    ];
    const swapped = [source[0], source[2], source[1]];
    expect(() =>
      verifyExcerpt(`${source.join("\n")}\n`, `${swapped.join("\n")}\n`, "pi-compaction", owners),
    ).toThrow("selected records must keep source order");
  });

  test("a dropped selected record", () => {
    const source = [
      '{"type":"session","id":"a"}',
      '{"type":"message_end","message":{"role":"assistant"}}',
    ];
    expect(() => verifyExcerpt(`${source.join("\n")}\n`, `${source[0]}\n`, "pi", owners)).toThrow(
      "fixture omits selected source line 2",
    );
  });

  test("an ordinary Pi thinking block replaced whole", () => {
    const thinking = "The user wants PONG. I will answer directly.";
    const source = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking }] },
    });
    const whole = source.replace(thinking, marker("message.content[].thinking", thinking.length));
    expect(() => compareRecord(source, whole, { kind: "pi-assistant" })).toThrow(
      "a whole Pi thinking block was replaced",
    );
    const quoted = source.replace(
      "I will answer directly.",
      marker(PI_QUOTE_LABEL, "I will answer directly.".length),
    );
    expect(() => compareRecord(source, quoted, { kind: "pi-assistant" })).toThrow(
      "masked thinking text is not an approved operator quote",
    );
  });

  test("a native builtin plugin redacted", () => {
    const source = init({
      plugins: [
        { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
      ],
    });
    const masked = source.replace(
      '"name":"cc-plugin-telemetry"',
      `"name":"${marker("plugins.name", 19)}"`,
    );
    expect(() => compareRecord(source, masked, initPolicy)).toThrow(
      "native builtin plugin cc-plugin-telemetry was redacted",
    );
  });

  test("native tools, skills and unowned agents redacted", () => {
    const tools = init({ tools: ["Bash", "mcp__x__y"] });
    expect(() =>
      compareRecord(
        tools,
        tools.replace('"Bash","mcp__x__y"', `"${marker("tools", 13)}"`),
        initPolicy,
      ),
    ).toThrow("native tools entry was redacted (only mcp__ tools are configuration)");
    expect(
      compareRecord(tools, tools.replace('"mcp__x__y"', `"${marker("tools", 9)}"`), initPolicy),
    ).toEqual({
      tools: { markers: 1, entries: 1 },
    });
    const skills = init({});
    expect(() =>
      compareRecord(skills, skills.replace('"run"', `"${marker("skills", 3)}"`), initPolicy),
    ).toThrow("native skills entry was redacted (a native bundled skill)");
    const agents = init({ agents: ["Explore", "operator-agent", "new-native-agent"] });
    expect(
      compareRecord(
        agents,
        agents.replace('"operator-agent"', `"${marker("agents", 14)}"`),
        initPolicy,
      ),
    ).toEqual({
      agents: { markers: 1, entries: 1 },
    });
    expect(() =>
      compareRecord(
        agents,
        agents.replace('"new-native-agent"', `"${marker("agents", 16)}"`),
        initPolicy,
      ),
    ).toThrow("native agents entry was redacted (no operator agent of that name)");
  });

  // A synthetic stand-in for an operator quote; the real quotes stay out of this file.
  const quote = "synthetic operator quote";
  const quotePolicy = {
    kind: "pi-assistant",
    approvedQuotes: [{ sha256: sha256(quote), characters: quote.length }],
  } as const;
  const piRaw = (thinkingJson: string) =>
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"${thinkingJson}"}]}}`;
  const quoteMarker = (characters: number = quote.length) => marker(PI_QUOTE_LABEL, characters);

  test("Pi thinking keeps its native JSON escape bytes outside the masked quote", () => {
    // Raw JSON escapes are spelled with "\\u" so no formatter can decode them.
    const letterA = "\\u0061";
    const surrogates = "\\ud83d\\ude00";
    const accent = "\\u00e9";
    const prefix = `native ${letterA}nswer ${surrogates} \\"q\\"\\n`;
    const source = piRaw(`${prefix}${quote} tail ${accent}`);
    const masked = piRaw(`${prefix}${quoteMarker()} tail ${accent}`);
    expect(source).toContain("\\u0061nswer");
    expect(compareRecord(source, masked, quotePolicy)).toEqual({
      [PI_QUOTE_LABEL]: { markers: 1, entries: 1 },
    });
    for (const rewritten of [
      masked.replace(letterA, "a"),
      masked.replace(surrogates, String.fromCodePoint(0x1f600)),
      masked.replace(surrogates, surrogates.toUpperCase().replaceAll("\\U", "\\u")),
      masked.replace(accent, String.fromCharCode(0xe9)),
    ])
      expect(() => compareRecord(source, rewritten, quotePolicy)).toThrow(
        "native thinking bytes changed outside a masked quote",
      );
  });

  test("a Pi quote mask reports the quote's exact positive length", () => {
    const source = piRaw(`native ${quote}`);
    expect(compareRecord(source, piRaw(`native ${quoteMarker()}`), quotePolicy)).toEqual({
      [PI_QUOTE_LABEL]: { markers: 1, entries: 1 },
    });
    for (const characters of [999, quote.length + 1]) {
      expect(() =>
        compareRecord(source, piRaw(`native ${quoteMarker(characters)}`), quotePolicy),
      ).toThrow("thinking redaction reports more characters than the native text holds");
    }
    expect(() =>
      compareRecord(source, piRaw(`native ${quoteMarker(0)}${quote}`), quotePolicy),
    ).toThrow("thinking redaction must report a safe positive character count");
    expect(() =>
      compareRecord(
        source,
        piRaw(
          `native ${marker(PI_QUOTE_LABEL, 0).replace("0 chars", "99999999999999999999 chars")}`,
        ),
        quotePolicy,
      ),
    ).toThrow("thinking redaction must report a safe positive character count");
    expect(() =>
      compareRecord(source, piRaw(`native ${quoteMarker(quote.length - 1)}e`), quotePolicy),
    ).toThrow("masked thinking text is not an approved operator quote");
    expect(() =>
      compareRecord(source, piRaw(`native ${quoteMarker()}`), {
        kind: "pi-assistant",
        approvedQuotes: [{ sha256: sha256(quote), characters: quote.length + 1 }],
      }),
    ).toThrow("masked thinking text is not an approved operator quote");
  });

  test("a Claude init mask consumes at least one whole native entry", () => {
    const source = init({ tools: ["Bash", "mcp__x__y"] });
    for (const masked of [
      source.replace('"Bash"', `"${marker("tools", 0)}","Bash"`),
      source.replace('"mcp__x__y"', `"${marker("tools", 0)}","mcp__x__y"`),
      source.replace('"mcp__x__y"', `"mcp__x__y","${marker("tools", 0)}"`),
    ])
      expect(() => compareRecord(source, masked, initPolicy)).toThrow(
        "tools redaction must report a safe positive character count",
      );
    expect(
      compareRecord(source, source.replace('"mcp__x__y"', `"${marker("tools", 9)}"`), initPolicy),
    ).toEqual({
      tools: { markers: 1, entries: 1 },
    });
  });

  test("native Pi SDK tool descriptions are never masked", () => {
    const installed = (tools: { name: string; description: string }[]) =>
      JSON.stringify([{ systemMessage: { toolsAdded: tools } }], null, 2);
    const mask = (tools: { name: string; description: string }[], name: string) =>
      tools.map((tool) =>
        tool.name === name
          ? { ...tool, description: marker("toolsAdded.description", tool.description.length) }
          : tool,
      );
    const policy = { kind: "pi-installed-compactions" } as const;
    const extension = [{ name: "extension_tool", description: "an extension's tool" }];
    expect(
      compareRecord(installed(extension), installed(mask(extension, "extension_tool")), policy),
    ).toEqual({ "toolsAdded.description": { markers: 1, entries: 1 } });
    const unknownCore = [{ name: "read", description: "a read tool of unknown provenance" }];
    expect(() =>
      compareRecord(installed(unknownCore), installed(mask(unknownCore, "read")), policy),
    ).toThrow("core Pi tool read has a description of unknown provenance");
    const [fixtureEntry] = JSON.parse(fixture("pi-1.4.0/installed-compactions.snapshot.json")) as {
      systemMessage: { toolsAdded: { name: string; description: string }[] };
    }[];
    const core = (fixtureEntry?.systemMessage.toolsAdded ?? []).filter((tool) =>
      Object.hasOwn(PI_NATIVE_TOOL_DESCRIPTIONS, tool.name),
    );
    expect(core).toHaveLength(4);
    for (const tool of core)
      expect(() =>
        compareRecord(installed(core), installed(mask(core, tool.name)), policy),
      ).toThrow(`native Pi 1.4.0 SDK description of ${tool.name} was redacted`);
  });

  test("native usage, field order and paths stay as captured", () => {
    const source =
      '{"type":"result","cwd":"/Users/x/ws","usage":{"input_tokens":3,"output_tokens":5}}';
    expect(() =>
      compareRecord(source, source.replace('"input_tokens":3', '"input_tokens":4'), {
        kind: "none",
      }),
    ).toThrow("native value changed at usage.input_tokens");
    expect(() =>
      compareRecord(
        source,
        '{"cwd":"/Users/x/ws","type":"result","usage":{"input_tokens":3,"output_tokens":5}}',
        { kind: "none" },
      ),
    ).toThrow("native fields or field order changed at <record>");
    expect(() =>
      compareRecord(source, source.replace("/Users/x/ws", "<cwd>"), { kind: "none" }),
    ).toThrow("native text changed at cwd");
  });
});
