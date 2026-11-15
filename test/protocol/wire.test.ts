/**
 * Issue #441: the built `hcn` binary, spawned as a consumer spawns it,
 * writes only the lines the published unions name. The harness is a
 * synthetic `claude` on PATH that answers each user line with one turn, so
 * no real harness, credential or configuration directory is read.
 *
 * The kind lists `satisfies` the published unions, so a kind removed from a
 * union fails typecheck here, and a kind the binary writes past its list
 * fails the membership assertion.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import type { RunEvent, SessionCommand, SessionEvent } from "../../src/cli/protocol.js";
import { cliFixtureTmpdir } from "../cli/fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

/** A one-shot stream-json turn for `hcn run`. */
const FAKE_CLAUDE_RUN = `#!${process.execPath}
const lines = [
  { type: "system", subtype: "init", session_id: "${SESSION_ID}" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
  { type: "result", subtype: "success", is_error: false },
];
process.stdout.write(lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
`;

/** A stream-json session: every user line gets an init naming its uuid, one
 * assistant message and a result; stdin EOF ends the process. */
const FAKE_CLAUDE_SESSION = `#!${process.execPath}
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record.type !== "user") return;
    out({
      type: "system",
      subtype: "init",
      session_id: "${SESSION_ID}",
      user_message_uuids: [record.uuid],
    });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } });
    out({ type: "result", subtype: "success", is_error: false });
  })
  .on("close", () => process.exit(0));
`;

interface Spawned {
  readonly status: number | null;
  readonly stderr: string;
  readonly kinds: readonly string[];
  readonly lines: readonly Record<string, unknown>[];
}

const spawnHcn = (
  runtime: string,
  stub: string,
  args: readonly string[],
  input: string | undefined,
): Spawned => {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-protocol-wire-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), stub, { mode: 0o755 });
  try {
    const result = spawnSync(runtime, [cli, ...args], {
      cwd: root,
      input,
      env: {
        HOME: root,
        PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        XDG_STATE_HOME: root,
        HCN_CONFIG_DIR: join(root, "config"),
        HCN_STATE_DIR: join(root, "state"),
      },
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.error).toBeUndefined();
    const lines = (result.stdout ?? "")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return {
      status: result.status,
      stderr: result.stderr ?? "",
      kinds: lines.map((line) => String(line.kind)),
      lines,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const expectKinds = (spawned: Spawned, kinds: readonly string[]): void => {
  for (const kind of spawned.kinds) {
    expect(kinds, `the binary wrote a kind the union does not name: ${kind}`).toContain(kind);
  }
  for (const kind of kinds) {
    expect(spawned.kinds, `the scenario never produced ${kind}\n${spawned.stderr}`).toContain(kind);
  }
};

for (const runtime of runtimes) {
  test(`${runtime}: a spawned hcn session writes only SessionEvent kinds`, () => {
    const commands: readonly SessionCommand[] = [
      { op: "send", id: "in-1", text: "hi" },
      { op: "interrupt", id: "stop" },
    ];
    const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\nnot json at all\n`;
    const spawned = spawnHcn(
      runtime,
      FAKE_CLAUDE_SESSION,
      ["session", "claude", "--json", "--questions", "none"],
      input,
    );
    const kinds = [
      "session",
      "disposition",
      "turn",
      "identity",
      "message",
      "done",
      "interruption",
      "error",
      "closed",
    ] satisfies readonly SessionEvent["kind"][];
    expectKinds(spawned, kinds);
    expect(spawned.kinds[0]).toBe("session");
    expect(spawned.kinds.at(-1)).toBe("closed");
  });

  test(`${runtime}: a spawned hcn run writes only RunEvent kinds, ending on a done with escalation`, () => {
    const spawned = spawnHcn(
      runtime,
      FAKE_CLAUDE_RUN,
      ["run", "claude", "--json", "--questions", "none", "--prompt", "fixture"],
      undefined,
    );
    const kinds = ["identity", "message", "done"] satisfies readonly RunEvent["kind"][];
    expectKinds(spawned, kinds);
    expect(spawned.status, spawned.stderr).toBe(0);
    expect(spawned.lines.at(-1)?.escalation).toBeDefined();
  });

  test(`${runtime}: a refused hcn run ends on a failure and a done with no escalation`, () => {
    const spawned = spawnHcn(
      runtime,
      FAKE_CLAUDE_RUN,
      ["run", "claude", "--json", "--no-such-option", "--prompt", "fixture"],
      undefined,
    );
    const kinds = ["failure", "done"] satisfies readonly RunEvent["kind"][];
    expectKinds(spawned, kinds);
    expect(spawned.status).toBe(2);
    const done = spawned.lines.at(-1);
    expect(done?.escalation).toBeUndefined();
    expect(done?.failure).toBeDefined();
  });
}
