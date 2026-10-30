// Capture receipts for the issue-420 harness fixtures.
//
// Each receipt ties one committed fixture file to the original native capture it
// was excerpted from: the source's digest, the source line of every selected
// record, and each record's digest on both sides. The generator re-derives the
// selection from the original capture and compares the fixture to it byte for
// byte, allowing only the operator-configuration redactions AGENTS.md permits.
// It refuses to write a receipt for a fixture that reorders, drops, adds or edits
// native records. test/knowledge/capture-integrity.test.ts then holds the
// committed fixtures to these receipts without the original captures.
//
// Usage (on the capture machine, with the original evidence tree):
//   node scripts/capture-receipts.ts --evidence <harness-refresh evidence root> [--check]
// --check verifies and compares with the committed receipts without writing.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot = join(repositoryRoot, "test/fixtures");
export const receiptsPath = join(fixtureRoot, "capture-receipts.snapshot.json");
export const coveredDirectories = ["claude-2.1.312", "codex-0.165.0", "pi-1.4.0"] as const;

// ---------------------------------------------------------------------------
// Approved redactions
// ---------------------------------------------------------------------------

// Any redaction-looking text counts as a marker, so a malformed one cannot pass
// as native text; its label and length are parsed separately.
const MARKER = /<redacted[^>]*>/g;
const MARKER_PARTS = /^<redacted: operator agent configuration \((.*)\), (\d+) chars>$/;

export const marker = (label: string, characters: number): string =>
  `<redacted: operator agent configuration (${label}), ${characters} chars>`;

/** A marker's label and reported length; a malformed marker has no label. */
const markerParts = (text: string): { label: string; characters: number } => {
  const parts = MARKER_PARTS.exec(text);
  return parts
    ? { label: parts[1] ?? "", characters: Number(parts[2]) }
    : { label: `malformed marker ${text}`, characters: Number.NaN };
};

const wholeMarker = (text: string) => (/^<redacted[^>]*>$/.test(text) ? markerParts(text) : null);

/** Every redaction marker in a text, with its label and reported length. */
export const markersIn = (text: string): { label: string; characters: number }[] =>
  [...text.matchAll(MARKER)].map((match) => markerParts(match[0]));

export const PI_QUOTE_LABEL = "message.content[].thinking operator quote";

/**
 * Exact quotes of the operator's global instructions and task board that the
 * model echoed inside Pi thinking. Only their digests are committed; a thinking
 * span may be masked only when its text hashes to one of these.
 */
export const APPROVED_PI_QUOTES: readonly { sha256: string; characters: number }[] = [
  { sha256: "06eb6aa9ea623986cccd823bceceedce0afc7a4dc6172a3dc7e3215e24e87d0c", characters: 40 },
  { sha256: "6fa7370888b2d07dc0da642c860fb1274f1d1c5280f6f30bc472d1f618a13b65", characters: 109 },
  { sha256: "89ed19778be21ae61d31ca5a73298858b03e1b673d460147eed6f874f4440401", characters: 56 },
];

/**
 * Native evidence, @earendil-works/pi-coding-agent 1.4.0: digests of the read,
 * bash, edit and write descriptions defined in its dist/core/tools/*.js, which
 * match the captured descriptions byte for byte. They are SDK data, never
 * operator configuration. A core tool whose description has another digest has
 * unknown provenance and may not be masked either.
 */
export const PI_NATIVE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  read: "b15dd29794ef5562ddee30a6282387ee7b40b9806c10ae2616daf75514ddc1f6",
  bash: "2342e7705e926b8d953d482a7e82b7a4fd7103bb1f202f64c005460843c180cb",
  edit: "c498a85576e187d069e8e8ea4f70f81bddd57829600d385ef61c4359fd634c9e",
  write: "cdb1c46027b22d1f1b923b47bfe297821d9fe589a9f9d92994961948060a4d89",
};

/** Skills Claude Code 2.1.312 bundles itself; masking one is never approved. */
export const NATIVE_CLAUDE_SKILLS: readonly string[] = [
  "deep-research",
  "design",
  "design-sync",
  "dataviz",
  "update-config",
  "verify",
  "debug",
  "code-review",
  "simplify",
  "batch",
  "fewer-permission-prompts",
  "doctor",
  "loop",
  "schedule",
  "claude-api",
  "workflow-authoring",
  "run",
  "run-skill-generator",
  "plugin-authoring",
];

/** Claude init arrays whose contiguous operator entries collapse to one marker. */
const CLAUDE_RUN_FIELDS = ["tools", "slash_commands", "agents", "skills"] as const;
type ClaudeRunField = (typeof CLAUDE_RUN_FIELDS)[number];

/**
 * Positive operator ownership of a bare (unnamespaced) name: a skill, agent or
 * command file the operator configured where Claude discovers them.
 */
export type OwnerLookup = (kind: "skill" | "agent" | "command", name: string) => boolean;

export const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Raw JSON spans
// ---------------------------------------------------------------------------

type Span = { start: number; end: number };
type JsonNode =
  | (Span & { kind: "object"; entries: { key: string; value: JsonNode }[] })
  | (Span & { kind: "array"; items: JsonNode[] })
  | (Span & { kind: "string"; value: string })
  | (Span & { kind: "scalar" });

/** Parse JSON text keeping each value's byte span. */
export const parseSpans = (raw: string): JsonNode => {
  let at = 0;
  const space = () => {
    while (at < raw.length && " \t\n\r".includes(raw[at] ?? "")) at++;
  };
  const string = (): JsonNode => {
    const start = at;
    at++;
    while (at < raw.length && raw[at] !== '"') at += raw[at] === "\\" ? 2 : 1;
    if (at >= raw.length) throw new Error(`unterminated string at ${start}`);
    at++;
    return { kind: "string", start, end: at, value: JSON.parse(raw.slice(start, at)) as string };
  };
  const value = (): JsonNode => {
    space();
    const start = at;
    const char = raw[at];
    if (char === '"') return string();
    if (char === "{") {
      at++;
      const entries: { key: string; value: JsonNode }[] = [];
      space();
      if (raw[at] === "}") return { kind: "object", start, end: ++at, entries };
      for (;;) {
        space();
        const key = string();
        space();
        if (raw[at++] !== ":") throw new Error(`expected ':' at ${at - 1}`);
        entries.push({ key: (key as { value: string }).value, value: value() });
        space();
        const next = raw[at++];
        if (next === "}") return { kind: "object", start, end: at, entries };
        if (next !== ",") throw new Error(`expected ',' or '}' at ${at - 1}`);
      }
    }
    if (char === "[") {
      at++;
      const items: JsonNode[] = [];
      space();
      if (raw[at] === "]") return { kind: "array", start, end: ++at, items };
      for (;;) {
        items.push(value());
        space();
        const next = raw[at++];
        if (next === "]") return { kind: "array", start, end: at, items };
        if (next !== ",") throw new Error(`expected ',' or ']' at ${at - 1}`);
      }
    }
    while (at < raw.length && !",]} \t\n\r".includes(raw[at] ?? "")) at++;
    if (at === start) throw new Error(`unexpected character at ${start}`);
    JSON.parse(raw.slice(start, at));
    return { kind: "scalar", start, end: at };
  };
  const root = value();
  space();
  if (at !== raw.length) throw new Error(`trailing bytes at ${at}`);
  return root;
};

const childSpans = (node: JsonNode): Span[] =>
  node.kind === "object"
    ? node.entries.map((entry) => entry.value)
    : node.kind === "array"
      ? node.items
      : [];

/** The node's bytes with every direct child value cut out: keys, order, punctuation, spacing. */
const skeleton = (raw: string, node: JsonNode): string[] => {
  const parts: string[] = [];
  let from = node.start;
  for (const child of childSpans(node)) {
    parts.push(raw.slice(from, child.start));
    from = child.end;
  }
  parts.push(raw.slice(from, node.end));
  return parts;
};

// ---------------------------------------------------------------------------
// Record comparison
// ---------------------------------------------------------------------------

/** Which redactions a record may carry. */
export type RedactionPolicy =
  | { kind: "none" }
  | { kind: "claude-init"; owners: OwnerLookup }
  // approvedQuotes defaults to APPROVED_PI_QUOTES; only synthetic tests set it.
  | { kind: "pi-assistant"; approvedQuotes?: readonly { sha256: string; characters: number }[] }
  | { kind: "pi-installed-compactions" };

const positiveCount = (characters: number) => Number.isSafeInteger(characters) && characters > 0;

/** Raw offset, inside a JSON string literal, of each decoded UTF-16 unit and of the closing quote. */
const rawOffsets = (literal: string): number[] => {
  const offsets: number[] = [];
  let at = 1;
  while (at < literal.length - 1) {
    offsets.push(at);
    at += literal[at] !== "\\" ? 1 : literal[at + 1] === "u" ? 6 : 2;
  }
  offsets.push(at);
  return offsets;
};

export type RedactionCounts = Record<string, { markers: number; entries: number }>;

class Mismatch extends Error {}

const count = (counts: RedactionCounts, label: string, entries: number) => {
  const current = counts[label] ?? { markers: 0, entries: 0 };
  counts[label] = { markers: current.markers + 1, entries: current.entries + entries };
};

const normalize = (path: (string | number)[]): string =>
  path
    .map((segment) => (typeof segment === "number" ? "[]" : `.${segment}`))
    .join("")
    .replace(/^\./, "");

const PI_INSTALLED_FIELDS: Record<string, string> = {
  "[].systemMessage.sections.project_context": "sections.project_context",
  "[].systemMessage.sections.docs": "sections.docs",
  "[].systemMessage.sections.skills": "sections.skills",
  "[].systemMessage.sections.rules": "sections.rules",
  "[].systemMessage.sections.tools": "sections.tools",
  "[].systemMessage.toolsAdded[].description": "toolsAdded.description",
};

/** Whether a Claude init entry may be masked, and why not when it may not. */
const claudeEntryOwned = (
  field: ClaudeRunField,
  name: string,
  record: { plugins?: { name?: string; path?: string }[]; skills?: string[] },
  owners: OwnerLookup,
): string | null => {
  if (field === "tools")
    return name.startsWith("mcp__") ? null : "only mcp__ tools are configuration";
  if (field === "skills" && NATIVE_CLAUDE_SKILLS.includes(name)) return "a native bundled skill";
  if (field === "slash_commands" && NATIVE_CLAUDE_SKILLS.includes(name))
    return "the command of a native bundled skill";
  const separator = name.indexOf(":");
  if (separator > 0) {
    const namespace = name.slice(0, separator);
    if (namespace === "anthropic-skills" && field !== "agents") return null;
    const plugin = record.plugins?.find((candidate) => candidate.name === namespace);
    if (plugin === undefined) return `namespace ${namespace} is not a configured plugin`;
    return plugin.path === "builtin" ? `namespace ${namespace} is a native builtin plugin` : null;
  }
  if (field === "skills") return owners("skill", name) ? null : "no operator skill of that name";
  if (field === "agents") return owners("agent", name) ? null : "no operator agent of that name";
  return owners("command", name) || owners("skill", name)
    ? null
    : "no operator command or skill of that name";
};

/**
 * Compare one fixture record with its native source record. Every byte outside
 * an approved redaction must match; returns the redactions found.
 */
export const compareRecord = (
  sourceRaw: string,
  fixtureRaw: string,
  policy: RedactionPolicy,
): RedactionCounts => {
  const counts: RedactionCounts = {};
  if (sourceRaw === fixtureRaw) return counts;
  const source = parseSpans(sourceRaw);
  const fixture = parseSpans(fixtureRaw);
  const record = JSON.parse(sourceRaw) as Record<string, unknown> & {
    plugins?: { name?: string; path?: string }[];
  };
  const text = (raw: string, node: JsonNode) => raw.slice(node.start, node.end);
  const errors: string[] = [];
  const child = (left: JsonNode, right: JsonNode, path: (string | number)[]) => {
    try {
      walk(left, right, path);
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error;
      errors.push(error.message);
    }
  };

  const walk = (left: JsonNode, right: JsonNode, path: (string | number)[]): void => {
    if (text(sourceRaw, left) === text(fixtureRaw, right)) return;
    const where = normalize(path) || "<record>";
    if (right.kind === "string" && left.kind === "string") {
      const whole = wholeMarker(right.value);
      if (whole) {
        wholeValue(left, path, whole.label, whole.characters);
        return;
      }
      if (policy.kind === "pi-assistant" && where === "message.content[].thinking") {
        quoteMask(left, right, policy.approvedQuotes ?? APPROVED_PI_QUOTES);
        return;
      }
      throw new Mismatch(`native text changed at ${where}`);
    }
    if (left.kind !== right.kind) throw new Mismatch(`native value type changed at ${where}`);
    if (left.kind === "object" && right.kind === "object") {
      const leftKeys = left.entries.map((entry) => entry.key).join(",");
      const rightKeys = right.entries.map((entry) => entry.key).join(",");
      if (leftKeys !== rightKeys)
        throw new Mismatch(`native fields or field order changed at ${where}`);
      if (skeleton(sourceRaw, left).join("\0") !== skeleton(fixtureRaw, right).join("\0"))
        throw new Mismatch(`native formatting changed at ${where}`);
      left.entries.forEach((entry, index) => {
        const other = right.entries[index];
        if (other) child(entry.value, other.value, [...path, entry.key]);
      });
      return;
    }
    if (left.kind === "array" && right.kind === "array") {
      const field = path.length === 1 ? path[0] : undefined;
      if (policy.kind === "claude-init" && CLAUDE_RUN_FIELDS.includes(field as ClaudeRunField)) {
        runs(left, right, field as ClaudeRunField, policy.owners);
        return;
      }
      if (left.items.length !== right.items.length)
        throw new Mismatch(`native records added or removed at ${where}`);
      if (skeleton(sourceRaw, left).join("\0") !== skeleton(fixtureRaw, right).join("\0"))
        throw new Mismatch(`native formatting changed at ${where}`);
      left.items.forEach((item, index) => {
        const other = right.items[index];
        if (other) child(item, other, [...path, index]);
      });
      return;
    }
    throw new Mismatch(`native value changed at ${where}`);
  };

  const wholeValue = (
    left: JsonNode & { kind: "string" },
    path: (string | number)[],
    label: string,
    characters: number,
  ) => {
    const where = normalize(path);
    let expected: string | undefined;
    if (policy.kind === "claude-init") {
      if (where === "mcp_servers[].name") expected = "mcp_servers.name";
      if (/^plugins\[\]\.(name|path|source)$/.test(where)) {
        const plugin = record.plugins?.[path[1] as number];
        if (plugin?.path === "builtin")
          throw new Mismatch(`native builtin plugin ${plugin.name} was redacted at ${where}`);
        expected = `plugins.${String(path[2])}`;
      }
    }
    if (policy.kind === "pi-installed-compactions") {
      expected = PI_INSTALLED_FIELDS[where];
      if (where === "[].systemMessage.toolsAdded[].description") {
        const entries = record as unknown as {
          systemMessage?: { toolsAdded?: { name?: string }[] };
        }[];
        const name =
          entries[path[0] as number]?.systemMessage?.toolsAdded?.[path[3] as number]?.name;
        if (name !== undefined && Object.hasOwn(PI_NATIVE_TOOL_DESCRIPTIONS, name))
          throw new Mismatch(
            PI_NATIVE_TOOL_DESCRIPTIONS[name] === sha256(left.value)
              ? `native Pi 1.4.0 SDK description of ${name} was redacted at ${where}`
              : `core Pi tool ${name} has a description of unknown provenance at ${where}; it may not be redacted until its source is established`,
          );
      }
    }
    if (policy.kind === "pi-assistant" && where === "message.content[].thinking")
      throw new Mismatch(
        `a whole Pi thinking block was replaced at ${where}; mask only approved operator quotes inside it`,
      );
    if (expected === undefined)
      throw new Mismatch(
        `native text changed at ${where}: ${label} is not an approved redaction here`,
      );
    if (label !== expected)
      throw new Mismatch(`redaction at ${where} must be labelled ${expected}, not ${label}`);
    if (characters !== left.value.length)
      throw new Mismatch(
        `redaction at ${where} reports ${characters} chars; the native value has ${left.value.length}`,
      );
    count(counts, label, 1);
  };

  // Locates each quote in the decoded text, then requires the fixture's raw
  // string to be the source's raw string with only those quotes' wire spans
  // replaced by their markers, so native escape bytes cannot be rewritten.
  const quoteMask = (
    left: JsonNode & { kind: "string" },
    right: JsonNode & { kind: "string" },
    approvedQuotes: readonly { sha256: string; characters: number }[],
  ) => {
    const native = left.value;
    const masked = right.value;
    const sourceLiteral = text(sourceRaw, left);
    const offsets = rawOffsets(sourceLiteral);
    if (offsets.length !== native.length + 1)
      throw new Error("raw string offsets disagree with the decoded string");
    let expected = "";
    let rawFrom = 0;
    let at = 0;
    let last = 0;
    let found = 0;
    for (const match of masked.matchAll(MARKER)) {
      const segment = masked.slice(last, match.index);
      if (!native.startsWith(segment, at))
        throw new Mismatch("native thinking text changed outside a masked quote");
      at += segment.length;
      const parts = markerParts(match[0]);
      if (parts.label !== PI_QUOTE_LABEL)
        throw new Mismatch(
          `thinking redaction must be labelled ${PI_QUOTE_LABEL}, not ${parts.label}`,
        );
      if (!positiveCount(parts.characters))
        throw new Mismatch("thinking redaction must report a safe positive character count");
      if (at + parts.characters > native.length)
        throw new Mismatch("thinking redaction reports more characters than the native text holds");
      const quote = native.slice(at, at + parts.characters);
      if (
        !approvedQuotes.some(
          (approved) =>
            approved.characters === parts.characters && approved.sha256 === sha256(quote),
        )
      )
        throw new Mismatch("masked thinking text is not an approved operator quote");
      expected += sourceLiteral.slice(rawFrom, offsets[at]) + JSON.stringify(match[0]).slice(1, -1);
      at += parts.characters;
      rawFrom = offsets[at] ?? sourceLiteral.length;
      last = (match.index ?? 0) + match[0].length;
      found++;
    }
    if (found === 0 || native.slice(at) !== masked.slice(last))
      throw new Mismatch("native thinking text changed outside a masked quote");
    expected += sourceLiteral.slice(rawFrom);
    if (text(fixtureRaw, right) !== expected)
      throw new Mismatch("native thinking bytes changed outside a masked quote");
    for (let index = 0; index < found; index++) count(counts, PI_QUOTE_LABEL, 1);
  };

  const runs = (
    left: JsonNode & { kind: "array" },
    right: JsonNode & { kind: "array" },
    field: ClaudeRunField,
    owners: OwnerLookup,
  ) => {
    const leftSkeleton = skeleton(sourceRaw, left);
    const rightSkeleton = skeleton(fixtureRaw, right);
    const separators = new Set([...leftSkeleton.slice(1, -1), ...rightSkeleton.slice(1, -1)]);
    if (
      leftSkeleton[0] !== rightSkeleton[0] ||
      leftSkeleton.at(-1) !== rightSkeleton.at(-1) ||
      separators.size > 1
    )
      throw new Mismatch(`native formatting changed at ${field}`);
    let next = 0;
    let previousMasked = false;
    for (const item of right.items) {
      const whole = item.kind === "string" ? wholeMarker(item.value) : null;
      if (!whole) {
        const native = left.items[next];
        if (!native || text(sourceRaw, native) !== text(fixtureRaw, item))
          throw new Mismatch(
            `native ${field} entry changed, dropped or reordered at position ${next}`,
          );
        next++;
        previousMasked = false;
        continue;
      }
      if (whole.label !== field)
        throw new Mismatch(`redaction in ${field} must be labelled ${field}, not ${whole.label}`);
      if (previousMasked) throw new Mismatch(`adjacent ${field} redactions must be one run`);
      const target = whole.characters;
      // A positive count consumes at least one native entry, so a mask cannot insert one.
      if (!positiveCount(target))
        throw new Mismatch(`${field} redaction must report a safe positive character count`);
      let total = 0;
      let entries = 0;
      while (total < target) {
        const native = left.items[next];
        if (native?.kind !== "string")
          throw new Mismatch(
            `${field} redaction reports more characters than the native entries hold`,
          );
        const refusal = claudeEntryOwned(field, native.value, record, owners);
        if (refusal)
          throw new Mismatch(`native ${field} entry was redacted (${refusal}) at position ${next}`);
        total += native.value.length;
        entries++;
        next++;
      }
      if (total !== target)
        throw new Mismatch(`${field} redaction length does not end on an entry boundary`);
      count(counts, field, entries);
      previousMasked = true;
    }
    if (next !== left.items.length)
      throw new Mismatch(`native ${field} entries were dropped after position ${next}`);
  };

  child(source, fixture, []);
  if (errors.length > 0) throw new Mismatch(errors.join("; "));
  return counts;
};

// ---------------------------------------------------------------------------
// Selection: exactly the capture map
// ---------------------------------------------------------------------------

type NativeRecord = {
  type?: string;
  subtype?: string;
  message?: { role?: string };
};

export type Selection =
  | "claude"
  | "claude-compaction"
  | "codex"
  | "pi"
  | "pi-last-assistant"
  | "pi-compaction"
  | "pi-compaction-rpc";

const piAssistantEnd = (record: NativeRecord) =>
  record.type === "message_end" && record.message?.role === "assistant";

/** Source line indices (0-based) the capture map selects, in source order. */
export const select = (selection: Selection, records: NativeRecord[]): number[] => {
  const keep = (predicate: (record: NativeRecord) => boolean) =>
    records.flatMap((record, index) => (predicate(record) ? [index] : []));
  switch (selection) {
    case "claude":
    case "claude-compaction":
      return keep(
        (record) =>
          record.type === "stream_event" ||
          record.type === "assistant" ||
          record.type === "result" ||
          (record.type === "system" &&
            (record.subtype === "init" ||
              record.subtype === "status" ||
              (selection === "claude-compaction" && record.subtype === "compact_boundary"))),
      );
    case "codex":
      return keep((record) =>
        ["thread.started", "turn.started", "item.completed", "turn.completed"].includes(
          record.type ?? "",
        ),
      );
    case "pi":
      return keep((record) => record.type === "session" || piAssistantEnd(record));
    case "pi-last-assistant": {
      const last = records.findLastIndex(piAssistantEnd);
      return keep((record) => record.type === "session")
        .concat(last >= 0 ? [last] : [])
        .sort((a, b) => a - b);
    }
    case "pi-compaction":
      return keep(
        (record) =>
          record.type === "session" ||
          record.type === "compaction_start" ||
          record.type === "compaction_end" ||
          piAssistantEnd(record),
      );
    case "pi-compaction-rpc":
      return keep(
        (record) =>
          record.type === "compaction_start" ||
          record.type === "compaction_end" ||
          piAssistantEnd(record),
      );
  }
};

const policyFor = (
  selection: Selection,
  record: NativeRecord,
  owners: OwnerLookup,
): RedactionPolicy => {
  if (selection.startsWith("claude") && record.type === "system" && record.subtype === "init")
    return { kind: "claude-init", owners };
  if (selection.startsWith("pi") && piAssistantEnd(record)) return { kind: "pi-assistant" };
  return { kind: "none" };
};

const recordKind = (record: NativeRecord) =>
  [record.type, record.subtype, record.message?.role].filter(Boolean).join("/");

const lines = (text: string, what: string): string[] => {
  if (!text.endsWith("\n")) throw new Mismatch(`${what} does not end with a newline`);
  return text.slice(0, -1).split("\n");
};

export type RecordReceipt = {
  sourceLine: number;
  type: string;
  sourceSha256: string;
  sha256: string;
  redactions?: RedactionCounts;
};

/** Verify an NDJSON excerpt against its original capture; one receipt per record. */
export const verifyExcerpt = (
  sourceText: string,
  fixtureText: string,
  selection: Selection,
  owners: OwnerLookup,
): RecordReceipt[] => {
  const sourceLines = lines(sourceText, "source capture");
  const records = sourceLines.map((line) => JSON.parse(line) as NativeRecord);
  const selected = select(selection, records);
  const fixtureLines = lines(fixtureText, "fixture");
  const receipts: RecordReceipt[] = [];
  fixtureLines.forEach((line, position) => {
    const expected = selected[position];
    if (expected === undefined)
      throw new Mismatch(`fixture line ${position + 1} is not a record the capture map selects`);
    const sourceLine = sourceLines[expected] ?? "";
    const record = records[expected] ?? {};
    let redactions: RedactionCounts;
    try {
      redactions = compareRecord(sourceLine, line, policyFor(selection, record, owners));
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error;
      const elsewhere = selected.find(
        (index) =>
          index !== expected &&
          sameRecord(sourceLines[index] ?? "", line, selection, records[index] ?? {}, owners),
      );
      if (elsewhere !== undefined)
        throw new Mismatch(
          `fixture line ${position + 1} is source line ${elsewhere + 1}, but the capture map selects source line ${expected + 1} there: selected records must keep source order`,
        );
      throw new Mismatch(
        `fixture line ${position + 1} (source line ${expected + 1}, ${recordKind(record)}): ${error.message}`,
      );
    }
    receipts.push({
      sourceLine: expected + 1,
      type: recordKind(record),
      sourceSha256: sha256(sourceLine),
      sha256: sha256(line),
      ...(Object.keys(redactions).length > 0 ? { redactions } : {}),
    });
  });
  if (fixtureLines.length < selected.length)
    throw new Mismatch(
      `fixture omits selected source line ${(selected[fixtureLines.length] ?? 0) + 1}; it holds ${fixtureLines.length} of ${selected.length} selected records`,
    );
  return receipts;
};

const sameRecord = (
  sourceLine: string,
  line: string,
  selection: Selection,
  record: NativeRecord,
  owners: OwnerLookup,
) => {
  try {
    compareRecord(sourceLine, line, policyFor(selection, record, owners));
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// The capture map
// ---------------------------------------------------------------------------

type Transform =
  | { kind: "excerpt"; selection: Selection }
  | { kind: "native-line" }
  | { kind: "copied" }
  | { kind: "snapshot"; policy: "none" | "pi-installed-compactions" }
  | { kind: "version-anchor" };

type MapEntry = { file: string; scenario: string; source?: string; transform: Transform };

const excerpt = (selection: Selection): Transform => ({ kind: "excerpt", selection });
const snapshot: Transform = { kind: "snapshot", policy: "none" };

/** Fixture -> original capture, relative to the harness-refresh evidence root. */
export const CAPTURE_MAP: readonly MapEntry[] = [
  {
    file: "claude-2.1.312/fresh.ndjson",
    scenario: "seven/01",
    source: "claude/seven-captures/01.ndjson",
    transform: excerpt("claude"),
  },
  {
    file: "claude-2.1.312/question.ndjson",
    scenario: "questions/01",
    source: "claude/questions-captures/01.ndjson",
    transform: excerpt("claude"),
  },
  {
    file: "claude-2.1.312/compaction.ndjson",
    scenario: "compaction/turn-05",
    source: "claude/compaction/turn-05.ndjson",
    transform: excerpt("claude-compaction"),
  },
  {
    file: "claude-2.1.312/later-recall.ndjson",
    scenario: "compaction/later-recall",
    source: "claude/compaction/later-recall.ndjson",
    transform: excerpt("claude"),
  },
  {
    file: "claude-2.1.312/accounting-fresh.native.ndjson",
    scenario: "context/accounting-fresh",
    source: "claude/context/accounting-fresh.native.ndjson",
    transform: { kind: "native-line" },
  },
  {
    file: "claude-2.1.312/accounting-resume.native.ndjson",
    scenario: "context/accounting-resume",
    source: "claude/context/accounting-resume.native.ndjson",
    transform: { kind: "native-line" },
  },
  {
    file: "claude-2.1.312/accounting-fresh.proof.snapshot.json",
    scenario: "context/accounting-fresh",
    source: "claude/context/accounting-fresh.proof.snapshot.json",
    transform: snapshot,
  },
  {
    file: "claude-2.1.312/accounting-resume.proof.snapshot.json",
    scenario: "context/accounting-resume",
    source: "claude/context/accounting-resume.proof.snapshot.json",
    transform: snapshot,
  },
  {
    file: "claude-2.1.312/accounting-source-hashes.snapshot.json",
    scenario: "context/source-hashes",
    source: "claude/context/accounting-source-hashes.snapshot.json",
    transform: snapshot,
  },
  {
    file: "claude-2.1.312/seven.snapshot.json",
    scenario: "seven",
    source: "claude/seven.snapshot.json",
    transform: snapshot,
  },
  {
    file: "claude-2.1.312/questions.snapshot.json",
    scenario: "questions",
    source: "claude/questions.snapshot.json",
    transform: snapshot,
  },
  {
    file: "claude-2.1.312/version-source.snapshot.json",
    scenario: "version-source",
    source: "claude/version-source.snapshot.json",
    transform: snapshot,
  },
  { file: "claude-2.1.312/version.txt", scenario: "anchor", transform: { kind: "version-anchor" } },
  {
    file: "codex-0.165.0/fresh.ndjson",
    scenario: "seven/01",
    source: "codex/seven-captures/01.ndjson",
    transform: excerpt("codex"),
  },
  {
    file: "codex-0.165.0/question.ndjson",
    scenario: "questions/01",
    source: "codex/questions-captures/01.ndjson",
    transform: excerpt("codex"),
  },
  {
    file: "codex-0.165.0/later-recall.ndjson",
    scenario: "compaction/turn-03",
    source: "codex/compaction/turn-03.ndjson",
    transform: excerpt("codex"),
  },
  {
    file: "codex-0.165.0/native-store-metadata.snapshot.json",
    scenario: "compaction/native-store-metadata",
    source: "codex/compaction/native-store-metadata.snapshot.json",
    transform: snapshot,
  },
  {
    file: "codex-0.165.0/models.rpc.ndjson",
    scenario: "app-server/model-list",
    source: "codex/app-server/models.rpc.ndjson",
    transform: { kind: "copied" },
  },
  {
    file: "codex-0.165.0/models-all.rpc.ndjson",
    scenario: "app-server/model-list-include-hidden",
    source: "codex/app-server/models-all.rpc.ndjson",
    transform: { kind: "copied" },
  },
  ...["ThreadStartParams", "ThreadResumeParams", "TurnStartParams", "TurnSteerParams"].map(
    (type): MapEntry => ({
      file: `codex-0.165.0/${type}.schema.snapshot.json`,
      scenario: `app-server/schema/${type}`,
      source: `codex/schemas/${type}.schema.snapshot.json`,
      transform: { kind: "copied" },
    }),
  ),
  {
    file: "codex-0.165.0/seven.snapshot.json",
    scenario: "seven",
    source: "codex/seven.snapshot.json",
    transform: snapshot,
  },
  {
    file: "codex-0.165.0/questions.snapshot.json",
    scenario: "questions",
    source: "codex/questions.snapshot.json",
    transform: snapshot,
  },
  {
    file: "codex-0.165.0/version-source.snapshot.json",
    scenario: "version-source",
    source: "codex/version-source.snapshot.json",
    transform: snapshot,
  },
  { file: "codex-0.165.0/version.txt", scenario: "anchor", transform: { kind: "version-anchor" } },
  {
    file: "pi-1.4.0/fresh.ndjson",
    scenario: "seven/01",
    source: "pi/seven-captures/01.ndjson",
    transform: excerpt("pi"),
  },
  {
    file: "pi-1.4.0/question.ndjson",
    scenario: "questions/01",
    source: "pi/questions-captures/01.ndjson",
    transform: excerpt("pi-last-assistant"),
  },
  {
    file: "pi-1.4.0/compaction.ndjson",
    scenario: "json/r950000/turn-01",
    source: "pi/json/r950000/turn-01.ndjson",
    transform: excerpt("pi-compaction"),
  },
  {
    file: "pi-1.4.0/later-recall.ndjson",
    scenario: "json/r950000/later-recall",
    source: "pi/json/r950000/later-recall.ndjson",
    transform: excerpt("pi"),
  },
  {
    file: "pi-1.4.0/compaction-rpc.ndjson",
    scenario: "rpc/rpc-stream",
    source: "pi/rpc/rpc-stream.ndjson",
    transform: excerpt("pi-compaction-rpc"),
  },
  {
    file: "pi-1.4.0/installed-compactions.snapshot.json",
    scenario: "json/installed-compactions",
    source: "pi/json/installed-compactions.snapshot.json",
    transform: { kind: "snapshot", policy: "pi-installed-compactions" },
  },
  {
    file: "pi-1.4.0/seven.snapshot.json",
    scenario: "seven",
    source: "pi/seven.snapshot.json",
    transform: snapshot,
  },
  {
    file: "pi-1.4.0/questions.snapshot.json",
    scenario: "questions",
    source: "pi/questions.snapshot.json",
    transform: snapshot,
  },
  {
    file: "pi-1.4.0/version-source.snapshot.json",
    scenario: "version-source",
    source: "pi/version-source.snapshot.json",
    transform: snapshot,
  },
  { file: "pi-1.4.0/version.txt", scenario: "anchor", transform: { kind: "version-anchor" } },
];

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export type FileReceipt = {
  file: string;
  harness: string;
  version: string;
  scenario: string;
  transform: string;
  sha256: string;
  bytes: number;
  source: { sha256: string; bytes: number; lines: number } | null;
  records?: RecordReceipt[];
  redactions?: RedactionCounts;
};

export type Receipts = { description: string; files: FileReceipt[] };

/** Files the gate covers: every file in the covered directories but the hand-written notes. */
export const coveredFiles = (root: string = fixtureRoot): string[] =>
  coveredDirectories.flatMap((directory) =>
    readdirSync(join(root, directory))
      .filter((name) => name !== "VERIFICATION.md")
      .sort()
      .map((name) => `${directory}/${name}`),
  );

/** Operator ownership resolved where Claude discovers skills, agents and commands. */
export const claudeConfigOwners = (captureCwd: string): OwnerLookup => {
  const roots = [process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")];
  for (let directory = resolve(captureCwd); ; directory = dirname(directory)) {
    roots.push(join(directory, ".claude"));
    if (dirname(directory) === directory) break;
  }
  return (kind, name) =>
    roots.some((root) =>
      kind === "skill"
        ? existsSync(join(root, "skills", name, "SKILL.md"))
        : existsSync(join(root, kind === "agent" ? "agents" : "commands", `${name}.md`)),
    );
};

const formatSnapshot = (text: string) => `${JSON.stringify(JSON.parse(text), null, 2)}\n`;

/** Verify one covered fixture against its original capture and build its receipt. */
export const receiptFor = (
  entry: MapEntry,
  evidenceRoot: string,
  fixtureText: string,
): FileReceipt => {
  const [directory = ""] = entry.file.split("/");
  const harness = directory.slice(0, directory.lastIndexOf("-"));
  const version = directory.slice(directory.lastIndexOf("-") + 1);
  const base = {
    file: entry.file,
    harness,
    version,
    scenario: entry.scenario,
    transform:
      entry.transform.kind === "excerpt"
        ? `excerpt:${entry.transform.selection}`
        : entry.transform.kind,
    sha256: sha256(fixtureText),
    bytes: Buffer.byteLength(fixtureText),
  };
  if (entry.transform.kind === "version-anchor") {
    if (fixtureText !== `${version}\n`)
      throw new Mismatch(`must hold exactly the anchor version ${version}`);
    return { ...base, source: null };
  }
  if (entry.source === undefined) throw new Mismatch("has no original capture in the capture map");
  const sourceText = readFileSync(join(evidenceRoot, entry.source), "utf8");
  const source = {
    sha256: sha256(sourceText),
    bytes: Buffer.byteLength(sourceText),
    lines: sourceText.split("\n").length - (sourceText.endsWith("\n") ? 1 : 0),
  };
  switch (entry.transform.kind) {
    case "copied":
      if (fixtureText !== sourceText)
        throw new Mismatch("must be a byte-for-byte copy of its capture");
      return { ...base, source };
    case "native-line": {
      const native = `${(JSON.parse(sourceText.trim()) as string).replace(/\n+$/, "")}\n`;
      if (fixtureText !== native)
        throw new Mismatch("must be the decoded native line of its capture");
      return { ...base, source };
    }
    case "snapshot": {
      const formatted = formatSnapshot(sourceText);
      if (entry.transform.policy === "none") {
        if (fixtureText !== sourceText && fixtureText !== formatted)
          throw new Mismatch(
            "must be its probe snapshot, as captured or in two-space snapshot formatting",
          );
        return { ...base, source };
      }
      const redactions = compareRecord(formatted.trimEnd(), fixtureText.trimEnd(), {
        kind: entry.transform.policy,
      });
      if (!fixtureText.endsWith("}\n") && !fixtureText.endsWith("]\n"))
        throw new Mismatch("must end with one newline");
      return { ...base, source, redactions };
    }
    case "excerpt": {
      const owners = (() => {
        let lookup: OwnerLookup | undefined;
        return ((kind, name) => {
          if (lookup === undefined) {
            const init = sourceText
              .split("\n")
              .find(
                (line) => line.includes('"subtype":"init"') && line.includes('"type":"system"'),
              );
            lookup = claudeConfigOwners(
              init ? (JSON.parse(init) as { cwd: string }).cwd : repositoryRoot,
            );
          }
          return lookup(kind, name);
        }) satisfies OwnerLookup;
      })();
      return {
        ...base,
        source,
        records: verifyExcerpt(sourceText, fixtureText, entry.transform.selection, owners),
      };
    }
  }
};

/** Verify every covered fixture against its original capture. */
export const buildReceipts = (evidenceRoot: string): Receipts => {
  const covered = coveredFiles();
  const mapped = new Set(CAPTURE_MAP.map((entry) => entry.file));
  const errors: string[] = [];
  for (const file of covered)
    if (!mapped.has(file))
      errors.push(
        `${file}: not in the capture map; add its original capture before it can be approved`,
      );
  const files: FileReceipt[] = [];
  for (const entry of CAPTURE_MAP) {
    const path = join(fixtureRoot, entry.file);
    if (!existsSync(path)) {
      errors.push(`${entry.file}: missing fixture`);
      continue;
    }
    try {
      files.push(receiptFor(entry, evidenceRoot, readFileSync(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error;
      errors.push(`${entry.file}: ${error.message}`);
    }
  }
  if (errors.length > 0)
    throw new Error(`capture receipts refused:\n${errors.map((line) => `  ${line}`).join("\n")}`);
  return {
    description:
      "Receipts tying each issue-420 fixture to its original native capture. Regenerate only with scripts/capture-receipts.ts against the original captures.",
    files,
  };
};

export const formatReceipts = (receipts: Receipts): string =>
  `${JSON.stringify(receipts, null, 2)}\n`;

const main = () => {
  const args = process.argv.slice(2);
  const evidenceAt = args.indexOf("--evidence");
  const evidenceRoot = evidenceAt >= 0 ? args[evidenceAt + 1] : undefined;
  if (!evidenceRoot) {
    console.error(
      "usage: node scripts/capture-receipts.ts --evidence <harness-refresh evidence root> [--check]",
    );
    process.exit(2);
  }
  let receipts: Receipts;
  try {
    receipts = buildReceipts(resolve(evidenceRoot));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const text = formatReceipts(receipts);
  if (args.includes("--check")) {
    const committed = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf8") : "";
    if (committed !== text) {
      console.error(
        `${receiptsPath} does not match the original captures; regenerate it without --check`,
      );
      process.exit(1);
    }
    console.log(`verified ${receipts.files.length} fixtures against their original captures`);
    return;
  }
  writeFileSync(receiptsPath, text);
  console.log(`wrote receipts for ${receipts.files.length} fixtures`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
