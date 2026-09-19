/**
 * Issue #179, gap 1: the observer's parsing of a NON-EMPTY
 * `approval/listPending` response, validated against muse's published MSP
 * schema. The live probe only ever saw empty lists, so every earlier
 * non-empty sample was a hand-written shape. This test builds the pending
 * approval from the issue's snapshot (network subject reached from a shell
 * command, the four `availableChoices`, `judgeEscalated` false and true,
 * plus a pending user input), validates it against the schema
 * programmatically - a focused structural check that reads the schema's own
 * `required`/`properties`/`$ref`/`enum` entries, since no JSON Schema
 * validator ships in devDependencies - and asserts the observer reads
 * identity, kind, and judgeEscalated from it.
 *
 * Schema source: `muse schema generate-json-schema` (stable surface) from
 * Muse Code 1.3.0, closure of the listPending defs captured at
 * `test/fixtures/msp-1.3.0/listPending.schema.json`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { APPROVAL_STUCK_POLLS, watchMuseApprovals } from "../../src/execution/muse-approvals.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

interface SchemaNode {
  readonly $ref?: string;
  readonly enum?: readonly string[];
  readonly items?: SchemaNode;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: readonly string[];
  readonly type?: string;
}

interface SchemaFile {
  readonly $defs: Record<string, SchemaNode>;
}

const loadSchema = (): Record<string, SchemaNode> =>
  (
    JSON.parse(
      readFileSync(
        new URL("../fixtures/msp-1.3.0/listPending.schema.json", import.meta.url),
        "utf8",
      ),
    ) as SchemaFile
  ).$defs;

/** Focused structural check driven by the schema itself: every `required`
 * entry must be present, every present value must match its declared
 * `type`/`$ref`/`enum`. Throws naming the offending path. */
const assertValid = (
  defs: Record<string, SchemaNode>,
  node: SchemaNode,
  value: unknown,
  path: string,
): void => {
  const resolved = node.$ref !== undefined ? defs[node.$ref.split("/").at(-1) ?? ""] : node;
  if (resolved === undefined) throw new Error(`unknown $ref at ${path}`);
  if (resolved.enum !== undefined) {
    expect(resolved.enum, `${path} is a schema enum value`).toContain(value);
    return;
  }
  switch (resolved.type) {
    case "object": {
      expect(value, `${path} is an object`).toMatchObject({});
      const record = value as Record<string, unknown>;
      for (const key of resolved.required ?? []) {
        expect(record[key] !== undefined, `${path}.${key} is required`).toBe(true);
      }
      for (const [key, prop] of Object.entries(resolved.properties ?? {})) {
        if (record[key] !== undefined) assertValid(defs, prop, record[key], `${path}.${key}`);
      }
      return;
    }
    case "array": {
      expect(Array.isArray(value), `${path} is an array`).toBe(true);
      for (const [index, item] of (value as readonly unknown[]).entries()) {
        assertValid(defs, resolved.items ?? {}, item, `${path}[${index}]`);
      }
      return;
    }
    case "string":
      expect(typeof value, `${path} is a string`).toBe("string");
      return;
    case "integer":
      expect(Number.isInteger(value), `${path} is an integer`).toBe(true);
      return;
    case "boolean":
      expect(typeof value, `${path} is a boolean`).toBe("boolean");
      return;
    default:
      throw new Error(`no type or enum at ${path}`);
  }
};

const SALTS = new Map<string, number>();

/** Build a valid instance of a schema def from its own `required` entries:
 * scalars by declared type, arrays with one item, `$ref`s recursed. Leaf
 * overrides pin the issue's values; everything else is filler. */
const synthesize = (
  defs: Record<string, SchemaNode>,
  name: string,
  overrides: Record<string, unknown> = {},
  path = name,
): Record<string, unknown> => {
  const node = defs[name];
  const out: Record<string, unknown> = {};
  for (const key of node?.required ?? []) {
    if (key in overrides) {
      out[key] = overrides[key];
      continue;
    }
    out[key] = synthesizeField(defs, node?.properties?.[key] ?? {}, `${path}.${key}`);
  }
  return { ...out, ...overrides };
};

const synthesizeField = (
  defs: Record<string, SchemaNode>,
  node: SchemaNode,
  path: string,
): unknown => {
  const resolved = node.$ref !== undefined ? (defs[node.$ref.split("/").at(-1) ?? ""] ?? {}) : node;
  if (resolved.enum !== undefined) return resolved.enum[0];
  switch (resolved.type) {
    case "object": {
      const name = Object.entries(defs).find(([, def]) => def === resolved)?.[0] ?? path;
      return synthesize(defs, name, {}, path);
    }
    case "array":
      return [synthesizeField(defs, resolved.items ?? {}, `${path}[]`)];
    case "string": {
      const seen = (SALTS.get(path) ?? 0) + 1;
      SALTS.set(path, seen);
      return `${path.split(".").at(-1)}-${seen}`;
    }
    case "integer":
      return 1;
    case "boolean":
      return false;
    default:
      throw new Error(`cannot synthesize ${path}`);
  }
};

/** The issue's snapshot as a wire approval: network subject reached from a
 * shell command, the four observed choices, judge still deciding. */
const issueApproval = (
  defs: Record<string, SchemaNode>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  synthesize(
    defs,
    "ApprovalRequestParams",
    {
      approvalId: "appr-179-network",
      judgeEscalated: false,
      subject: {
        kind: "network",
        host: "o4504648565915648.ingest.us.sentry.io",
        port: 443,
        protocol: "https",
        origin: { kind: "shellCommand", command: "third-party-cli sync" },
      },
      availableChoices: [
        { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
        {
          choiceId: "allow_session",
          decision: "approvedForSession",
          label: "Allow for session",
          scope: "session",
        },
        {
          choiceId: "allow_local_network",
          decision: "approvedPolicyAmendment",
          label: "Allow local network",
          scope: "localPersistent",
        },
        { choiceId: "abort", decision: "abort", label: "Abort", scope: "once" },
      ],
      ...overrides,
    },
    "ApprovalRequestParams",
  );

const issueUserInput = (defs: Record<string, SchemaNode>): Record<string, unknown> =>
  synthesize(
    defs,
    "UserInputRequestParams",
    {
      userInputId: "input-179",
      questions: [
        {
          header: "Clarify",
          id: "q1",
          options: [{ label: "Proceed" }, { label: "Stop" }],
          question: "How should the turn proceed?",
          selection: { mode: "single", minSelections: 0, maxSelections: 1 },
        },
      ],
    },
    "UserInputRequestParams",
  );

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

const setup = () => {
  const proc = new FakeProcess({ exitOnStdinEnd: false });
  const clock = new FakeClock();
  const sig = fakeSignal();
  const spawner = fakeSpawner([proc]);
  const seen: Array<{ subject: "approval" | "input"; kind: string; sandboxEscalation: boolean }> =
    [];
  let unavailable = 0;
  const watch = watchMuseApprovals(
    "/selected/muse",
    { cwd: "/work" },
    { clock, signal: sig.signal, spawn: spawner.spawn },
    "session-179",
    (subject, kind, sandboxEscalation) => seen.push({ subject, kind, sandboxEscalation }),
    () => {
      unavailable += 1;
    },
  );
  const reply = (id: number, result: unknown): void =>
    proc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", result }));
  return { proc, clock, seen, watch, reply, unavailable: () => unavailable };
};

describe("muse listPending against the published MSP schema (issue #179)", () => {
  test("the issue-shaped approval and user input validate against the schema", () => {
    const defs = loadSchema();
    const approval = issueApproval(defs);
    assertValid(defs, { $ref: "#/$defs/ApprovalRequestParams" }, approval, "approval");
    const escalated = issueApproval(defs, { judgeEscalated: true });
    assertValid(defs, { $ref: "#/$defs/ApprovalRequestParams" }, escalated, "escalated");
    const input = issueUserInput(defs);
    assertValid(defs, { $ref: "#/$defs/UserInputRequestParams" }, input, "userInput");
    assertValid(
      defs,
      { $ref: "#/$defs/ApprovalListPendingResult" },
      { approvals: [approval], userInputs: [input] },
      "listPending",
    );
    // The validator reads the schema, not a hand copy: every required
    // field of the wire approval is present because the schema says so.
    const required = defs.ApprovalRequestParams?.required ?? [];
    expect(required).toContain("judgeEscalated");
    expect(required).toContain("availableChoices");
    expect(required).toContain("subject");
    for (const key of required) {
      expect(approval[key] !== undefined, `required ${key} present`).toBe(true);
    }
  });

  test("the captured sandbox-escalation frame validates against the schema", () => {
    // Issue #189: the live frame that pins the escalation signal - rawArgs
    // JSON carrying sandbox_permissions require_escalated - is
    // schema-conformant, so the observer's read of it is a read of the
    // published surface, not a hand-written shape.
    const defs = loadSchema();
    const frame = JSON.parse(
      readFileSync(
        new URL("../fixtures/msp-1.3.0/listPending.sandbox-escalation.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    assertValid(defs, { $ref: "#/$defs/ApprovalListPendingResult" }, frame, "listPending");
  });

  test("the observer reads kind from a schema-conformant stuck approval", async () => {
    const defs = loadSchema();
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = {
      approvals: [issueApproval(defs)],
      userInputs: [],
    };
    assertValid(defs, { $ref: "#/$defs/ApprovalListPendingResult" }, pending, "listPending");
    for (let id = 2; id <= APPROVAL_STUCK_POLLS + 1; id++) {
      if (id > 2) {
        s.clock.advance(1_000);
        await flush();
      }
      s.reply(id, pending);
      await flush();
      if (id <= APPROVAL_STUCK_POLLS) expect(s.seen).toEqual([]);
    }
    expect(s.seen).toEqual([{ subject: "approval", kind: "network", sandboxEscalation: false }]);
    await s.watch.close();
  });

  test("the observer reports a schema-conformant judge-escalated approval at once", async () => {
    const defs = loadSchema();
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = {
      approvals: [issueApproval(defs, { judgeEscalated: true })],
      userInputs: [],
    };
    assertValid(defs, { $ref: "#/$defs/ApprovalListPendingResult" }, pending, "listPending");
    s.reply(2, pending);
    await flush();
    expect(s.seen).toEqual([{ subject: "approval", kind: "network", sandboxEscalation: false }]);
    await s.watch.close();
  });

  test("the observer reads a schema-conformant pending user input", async () => {
    const defs = loadSchema();
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = { approvals: [], userInputs: [issueUserInput(defs)] };
    assertValid(defs, { $ref: "#/$defs/ApprovalListPendingResult" }, pending, "listPending");
    for (let id = 2; id <= APPROVAL_STUCK_POLLS + 1; id++) {
      if (id > 2) {
        s.clock.advance(1_000);
        await flush();
      }
      s.reply(id, pending);
      await flush();
      if (id <= APPROVAL_STUCK_POLLS) expect(s.seen).toEqual([]);
    }
    expect(s.seen).toEqual([{ subject: "input", kind: "input", sandboxEscalation: false }]);
    await s.watch.close();
  });

  test("a user input with autoResolutionMs waits past the stuck window", async () => {
    // M2: headless muse resolves the request itself at 60s, so hcn must
    // not report at 30 polls - only past the deadline plus a margin.
    const defs = loadSchema();
    const s = setup();
    s.reply(1, {});
    await flush();
    const input = { ...issueUserInput(defs), autoResolutionMs: 60_000 };
    const pending = { approvals: [], userInputs: [input] };
    assertValid(defs, { $ref: "#/$defs/ApprovalListPendingResult" }, pending, "listPending");
    for (let id = 2; id <= 66; id++) {
      if (id > 2) {
        s.clock.advance(1_000);
        await flush();
      }
      s.reply(id, pending);
      await flush();
      // 30 consecutive polls pass with no report; the 65th reports.
      if (id < 66) expect(s.seen).toEqual([]);
    }
    expect(s.seen).toEqual([{ subject: "input", kind: "input", sandboxEscalation: false }]);
    await s.watch.close();
  });

  test("identity comes from approvalId: a replaced id restarts the stuck window", async () => {
    const defs = loadSchema();
    const s = setup();
    s.reply(1, {});
    await flush();
    s.reply(2, { approvals: [issueApproval(defs)], userInputs: [] });
    await flush();
    // The first approval clears and a different identity appears: the
    // count restarts instead of reporting the first id's sightings.
    const later = (id: number): void => {
      s.clock.advance(1_000);
      s.reply(id, {
        approvals: [issueApproval(defs, { approvalId: "appr-179-later" })],
        userInputs: [],
      });
    };
    for (let id = 3; id <= APPROVAL_STUCK_POLLS + 1; id++) {
      later(id);
      await flush();
      expect(s.seen).toEqual([]);
    }
    later(APPROVAL_STUCK_POLLS + 2);
    await flush();
    expect(s.seen).toEqual([{ subject: "approval", kind: "network", sandboxEscalation: false }]);
    await s.watch.close();
  });
});
