import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

/**
 * RFC 35 (Lucid): Pi native settings for bound continuation.
 *
 * The session files here are composed inline, not captured: a captured Pi
 * session carries conversation content that must not be read into a review
 * or committed. Their shape follows Pi 0.99.1's own writer
 * (`dist/core/session-manager.js`: the `session` header, `model_change`,
 * `thinking_level_change`, and `message` entries with `id`/`parentId`).
 */

const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const cli = resolve("src/cli/index.ts");
const sessionId = "01a0e08c-06b0-71d0-8bfd-8304dfbd84b3";
const recorded = resolve("test/fixtures/pi-0.99.1/fresh.ndjson");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type Entry = Record<string, unknown>;
const header = (cwd: string, id = sessionId): Entry => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-09-27T00:00:00.000Z",
  cwd,
});
const modelChange = (id: string, parentId: string | null, provider: string, modelId: string) => ({
  type: "model_change",
  id,
  parentId,
  provider,
  modelId,
});
const thinking = (id: string, parentId: string | null, thinkingLevel: string) => ({
  type: "thinking_level_change",
  id,
  parentId,
  thinkingLevel,
});
const user = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  message: {
    role: "user",
    content: [{ type: "text", text: "DO_NOT_RETURN_CONVERSATION_CONTENT" }],
  },
});
const assistant = (id: string, parentId: string | null, provider: string, model: string) => ({
  type: "message",
  id,
  parentId,
  message: {
    role: "assistant",
    provider,
    model,
    content: [{ type: "text", text: "DO_NOT_RETURN_CONVERSATION_CONTENT" }],
  },
});

function fixture(entries: (cwd: string) => readonly (Entry | string)[], flat = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-pi-settings-")));
  roots.push(root);
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const agent = join(root, "agent");
  const sessions = flat
    ? join(root, "flat")
    : join(agent, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `2026-09-27T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(
    file,
    `${entries(cwd)
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n")}\n`,
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  // A stub Pi that records its argv and replays a recorded 0.99.1 stream.
  writeFileSync(
    join(bin, "pi"),
    `#!${bun}\nimport {readFileSync, writeFileSync} from "node:fs";\nif (process.argv.includes("--version")) { console.log("0.99.1"); process.exit(0); }\nwriteFileSync(${JSON.stringify(join(root, "native-argv.json"))}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(readFileSync(${JSON.stringify(recorded)}, "utf8"));\n`,
    { mode: 0o700 },
  );
  const extension = join(root, "lucid.js");
  writeFileSync(extension, "export default function () {}\n");
  const env: Record<string, string> = {
    HCN_CONFIG_DIR: join(root, "hcn-config"),
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    ...(flat
      ? { PI_CODING_AGENT_SESSION_DIR: join(root, "flat") }
      : { PI_CODING_AGENT_DIR: agent }),
  };
  const hcn = (args: readonly string[]) =>
    // 60s: this rig spawns real pi processes; under a fully parallel suite
    // (one worker per file) the spawn+read chain has been observed past 15s
    // and the kill turned a passing assertion into a flake.
    spawnSync(bun, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
  const inspect = () =>
    hcn(["inspect", "pi", "--native-settings", "--resume", sessionId, "--cwd", cwd, "--json"]);
  return { root, cwd, file, extension, hcn, inspect };
}

const bound = (cwd: string) => [
  header(cwd),
  modelChange("a1", null, "zai", "glm-5.2"),
  thinking("a2", "a1", "high"),
  user("a3", "a2"),
  assistant("a4", "a3", "zai", "glm-5.3"),
];

test("a bound Pi session yields Pi's own settings, a fingerprint, and the resume transport", () => {
  const f = fixture(bound);
  const result = f.inspect();
  expect(result.status).toBe(0);
  const snapshot = JSON.parse(result.stdout);
  expect(snapshot).toMatchObject({
    v: 1,
    status: "available",
    harness: "pi",
    source: "pi-session-v1",
    continuation: "resume",
    sessionId,
    cwd: f.cwd,
    provider: "zai",
    model: "glm-5.3",
    effort: "high",
  });
  expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.permissions).toBeUndefined();
  expect(result.stdout).not.toContain("DO_NOT_RETURN_CONVERSATION_CONTENT");
});

test("the later of a model_change and an assistant message wins", () => {
  const f = fixture((cwd) => [...bound(cwd), modelChange("a5", "a4", "openai", "gpt-6")]);
  expect(JSON.parse(f.inspect().stdout)).toMatchObject({ provider: "openai", model: "gpt-6" });
});

test("only the path from the last entry counts; a sibling branch does not", () => {
  const f = fixture((cwd) => [
    ...bound(cwd),
    thinking("b1", "a4", "low"),
    // The last entry branches from a3, so b1 is off the path.
    assistant("c1", "a3", "zai", "glm-5.1"),
  ]);
  expect(JSON.parse(f.inspect().stdout)).toMatchObject({ model: "glm-5.1", effort: "high" });
});

test("the walk stops at a missing parent, as Pi's does", () => {
  const f = fixture((cwd) => [
    header(cwd),
    thinking("x1", "gone", "low"),
    assistant("x2", "x1", "zai", "glm-5.3"),
  ]);
  expect(JSON.parse(f.inspect().stdout)).toMatchObject({ model: "glm-5.3", effort: "low" });
});

test("no thinking change on the path means off", () => {
  const f = fixture((cwd) => [
    header(cwd),
    user("u1", null),
    assistant("u2", "u1", "zai", "glm-5.3"),
  ]);
  expect(JSON.parse(f.inspect().stdout)).toMatchObject({ effort: "off" });
});

test("a version 1 session is a chain in file order", () => {
  const f = fixture((cwd) => [
    { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "model_change", provider: "zai", modelId: "glm-4" },
    { type: "thinking_level_change", thinkingLevel: "minimal" },
  ]);
  expect(JSON.parse(f.inspect().stdout)).toMatchObject({ model: "glm-4", effort: "minimal" });
});

test("blank lines are skipped, as Pi skips them", () => {
  const f = fixture((cwd) => [header(cwd), "", ...bound(cwd).slice(1)]);
  expect(f.inspect().status).toBe(0);
});

test("a flat PI_CODING_AGENT_SESSION_DIR store is found", () => {
  const f = fixture(bound, true);
  expect(JSON.parse(f.inspect().stdout)).toMatchObject({ status: "available", model: "glm-5.3" });
});

test.each<[string, (cwd: string) => readonly (Entry | string)[], string]>([
  ["a malformed line", (cwd) => [...bound(cwd), "{not json"], "settings-unavailable"],
  [
    "an assistant message without a model",
    (cwd) => [
      ...bound(cwd),
      { type: "message", id: "z1", parentId: "a4", message: { role: "assistant", content: [] } },
    ],
    "settings-unavailable",
  ],
  ["no model on the path", (cwd) => [header(cwd), user("u1", null)], "settings-unavailable"],
  [
    "an unknown thinking level",
    (cwd) => [...bound(cwd), thinking("t1", "a4", "extreme")],
    "settings-unavailable",
  ],
  [
    "a cycle",
    (cwd) => [header(cwd), thinking("p", "q", "low"), assistant("q", "p", "zai", "m")],
    "settings-unavailable",
  ],
  [
    "another session's header",
    (cwd) => [header(cwd, "01a0e08c-0000-7000-8000-000000000000"), ...bound(cwd).slice(1)],
    "session-unavailable",
  ],
  ["another folder", () => [header("/elsewhere"), ...bound("/elsewhere").slice(1)], "cwd-refused"],
  ["a second header", (cwd) => [...bound(cwd), header(cwd)], "session-unavailable"],
])("%s is unavailable, never a guess", (_label, entries, reason) => {
  const f = fixture(entries);
  const result = f.inspect();
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unavailable", reason });
});

test("the fingerprint changes when the session file changes", () => {
  const f = fixture(bound);
  const before = JSON.parse(f.inspect().stdout).fingerprint;
  appendFileSync(f.file, `${JSON.stringify(user("a5", "a4"))}\n`);
  expect(JSON.parse(f.inspect().stdout).fingerprint).not.toBe(before);
});

test("the fingerprint covers the file bytes across read chunks", () => {
  // Past one 64 KiB read, so the digest must fold every chunk.
  const padding = "x".repeat(100 * 1024);
  const f = fixture((cwd) => [
    ...bound(cwd).slice(0, 3),
    { ...user("a3", "a2"), padding },
    ...bound(cwd).slice(4),
  ]);
  const bytes = readFileSync(f.file);
  expect(bytes.length).toBeGreaterThan(64 * 1024);
  const stat = statSync(f.file, { bigint: true });
  // Recomputed independently, so dropping the digest fails here whatever
  // the stat identity does.
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        "pi-session-v1",
        "pi",
        sessionId,
        f.cwd,
        ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
        createHash("sha256").update(bytes).digest("hex"),
        "a4",
        "a2",
        "glm-5.3",
        "high",
        "zai",
      ]),
    )
    .digest("hex");
  expect(JSON.parse(f.inspect().stdout).fingerprint).toBe(expected);
});

// Seven sequential real-CLI spawns (inspect, preview, run, refusals): under
// the fully parallel suite each spawn slows several-fold and the default
// 20s test timeout (vitest and bun both) turns the chain into the suite's
// one flake. The numeric third arg is the one timeout form both lanes honor.
test("a fingerprinted Pi resume is flagless, loads the extension, and refuses every other option", () => {
  const f = fixture(bound);
  const fingerprint = JSON.parse(f.inspect().stdout).fingerprint;
  const base = [
    "--resume",
    sessionId,
    "--cwd",
    f.cwd,
    "--native-settings-fingerprint",
    fingerprint,
    "--extension",
    f.extension,
    "--questions",
    "none",
    "--prompt",
    "EXACT_INPUT",
    "--json",
  ];
  const preview = f.hcn(["inspect", "pi", "--runtime", ...base]);
  expect(preview.status).toBe(0);
  const argv: string[] = JSON.parse(preview.stdout).argv;
  expect(argv).toContain("-e");
  expect(argv).toContain(f.extension);
  for (const flag of ["--model", "--provider", "--thinking"]) expect(argv).not.toContain(flag);
  // Map #300 (#308): --runtime probes pi's declared extension-registered
  // option, so the preview above legitimately executed one probe call
  // (the fake pi logs every invocation to native-argv.json). The refused
  // runs below assert no FURTHER spawn happens - start from a clean slate.
  rmSync(join(f.root, "native-argv.json"), { force: true });

  for (const extra of [
    ["--model", "zai/other"],
    ["--effort", "low"],
    ["--provider", "other"],
    ["--tools", "read"],
    ["--access", "read"],
    ["--no-extensions"],
    ["--system-prompt", "x"],
    ["--skills="],
    ["--", "-e", "/tmp/other.js"],
  ]) {
    const refused = f.hcn(["run", "pi", ...base, ...extra]);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain('"issue":"invalid-option-value"');
    expect(existsSync(join(f.root, "native-argv.json"))).toBe(false);
  }

  const run = f.hcn(["run", "pi", ...base]);
  expect(run.status).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, "native-argv.json"), "utf8"))).toEqual([
    "--session-id",
    sessionId,
    "-p",
    "--mode",
    "json",
    "-e",
    f.extension,
    "--",
    expect.stringContaining("EXACT_INPUT"),
  ]);

  // A flag-shaped prompt stays the message: Pi reads every token after its
  // `--` as text, so it cannot become an option the guard never saw.
  rmSync(join(f.root, "native-argv.json"));
  const flagShaped = base.map((token) => (token === "EXACT_INPUT" ? "--no-extensions" : token));
  expect(f.hcn(["run", "pi", ...flagShaped]).status).toBe(0);
  const flagArgv: string[] = JSON.parse(readFileSync(join(f.root, "native-argv.json"), "utf8"));
  expect(flagArgv.slice(-2)).toEqual(["--", expect.stringContaining("--no-extensions")]);
  expect(flagArgv.filter((token) => token.includes("--no-extensions"))).toHaveLength(1);

  rmSync(join(f.root, "native-argv.json"));
  appendFileSync(f.file, `${JSON.stringify(user("a5", "a4"))}\n`);
  const changed = f.hcn(["run", "pi", ...base]);
  expect(changed.status).toBe(2);
  expect(changed.stdout).toContain("native-settings-changed");
  expect(existsSync(join(f.root, "native-argv.json"))).toBe(false);
}, 120_000);

test("--extension refuses a missing file and a harness without extension support", () => {
  const f = fixture(bound);
  const missing = f.hcn([
    "run",
    "pi",
    "--extension",
    join(f.root, "missing.js"),
    "--prompt",
    "x",
    "--json",
  ]);
  expect(missing.status).toBe(2);
  expect(missing.stdout).toContain('"issue":"invalid-option-value"');
  const relative = f.hcn(["run", "pi", "--extension", "lucid.js", "--prompt", "x", "--json"]);
  expect(relative.status).toBe(2);
  const claude = f.hcn(["run", "claude", "--extension", f.extension, "--prompt", "x", "--json"]);
  expect(claude.status).toBe(2);
  expect(claude.stdout).toContain("unsupported-option");
});
