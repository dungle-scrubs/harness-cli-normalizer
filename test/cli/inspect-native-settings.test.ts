import type { SpawnSyncReturns } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const sessionId = "407feafe-e82b-4df4-91ba-4f1aeb987508";
const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();

function fixture(): {
  readonly close: () => void;
  readonly root: string;
  readonly rollout: string;
  readonly run: (
    extra?: readonly string[],
    command?: string,
    harness?: string,
  ) => SpawnSyncReturns<string>;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-native-settings-")));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "09", "12");
  mkdirSync(sessions, { recursive: true });
  // Synthetic native records. Conversation content must not appear in the result.
  const records = [
    { type: "session_meta", payload: { id: sessionId, cwd: root, model_provider: "saved" } },
    { type: "turn_context", payload: { cwd: root, model: "older-model", effort: "low" } },
    { type: "response_item", payload: { content: "DO_NOT_RETURN_CONVERSATION_CONTENT" } },
    { type: "turn_context", payload: { cwd: root, model: "custom-model", effort: "high" } },
  ];
  const rollout = join(sessions, `rollout-2026-09-12T00-00-00-${sessionId}.jsonl`);
  writeFileSync(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return {
    close: () => rmSync(root, { force: true, recursive: true }),
    root,
    rollout,
    run: (extra = [], command = "inspect", harness = "codex") =>
      spawnSync(
        bun,
        [
          resolve("src/cli/index.ts"),
          command,
          harness,
          "--native-settings",
          extra.includes("--session-id") ? "--session-id" : "--resume",
          sessionId,
          "--cwd",
          root,
          "--json",
          ...extra.filter((arg) => arg !== "--session-id"),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 2000,
          env: {
            CODEX_HOME: codexHome,
            HCN_CONFIG_DIR: join(root, "hcn-config"),
            PATH: join(root, "no-executables"),
          },
        },
      ),
  };
}

test("native settings inspection reads the exact latest Codex turn without a native executable", () => {
  const f = fixture();
  try {
    const result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cwd: f.root,
      effort: "high",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      harness: "codex",
      model: "custom-model",
      provider: "saved",
      sessionId,
      source: "codex-rollout-v1",
      status: "available",
      v: 1,
    });
    expect(result.stdout).not.toContain("DO_NOT_RETURN_CONVERSATION_CONTENT");
    expect(result.stderr).toBe("");
  } finally {
    f.close();
  }
});

test("native settings inspection cannot be silently accepted by a run command", () => {
  const f = fixture();
  try {
    const result = f.run(["--prompt", "DO_NOT_EXECUTE"], "run");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("native-settings");
    expect(result.stdout).not.toContain('"kind":"spawn"');
  } finally {
    f.close();
  }
});

test("a second matching symlink makes native settings ambiguous rather than selecting the regular file", () => {
  const f = fixture();
  try {
    symlinkSync(f.rollout, f.rollout.replace("T00-00-00", "T00-00-01"));
    const result = f.run();
    expect(result.status).toBe(2);
    expect(JSON.parse(String(result.stdout))).toMatchObject({
      reason: "session-unavailable",
      status: "unavailable",
    });
    expect(String(result.stdout)).not.toContain("custom-model");
  } finally {
    f.close();
  }
});

test.each([
  { name: "missing effort", payload: { model: "custom-model" }, reason: "settings-unavailable" },
  {
    name: "null effort",
    payload: { model: "custom-model", effort: null },
    reason: "settings-unavailable",
  },
  {
    name: "unknown effort",
    payload: { model: "custom-model", effort: "invented" },
    reason: "settings-unavailable",
  },
  {
    name: "unsafe selector",
    payload: { model: "--config=unsafe", effort: "high" },
    reason: "settings-unavailable",
  },
  {
    name: "wrong folder",
    payload: { cwd: "/", model: "custom-model", effort: "high" },
    reason: "cwd-refused",
  },
])(
  "a later turn with $name refuses instead of falling back to an older turn",
  ({ payload, reason }) => {
    const f = fixture();
    try {
      appendFileSync(
        f.rollout,
        `${JSON.stringify({ type: "turn_context", payload: { cwd: f.root, ...payload } })}\n`,
      );
      const result = f.run();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "unavailable", reason });
      expect(result.stdout).not.toContain('"model"');
    } finally {
      f.close();
    }
  },
);

test.each([
  { name: "partial final record", suffix: '{"type":', reason: "source-incomplete" },
  { name: "malformed complete record", suffix: "{broken}\n", reason: "session-unavailable" },
  { name: "invalid UTF-8", suffix: Buffer.from([0xff, 10]), reason: "session-unavailable" },
  { name: "oversized line", suffix: "x".repeat(1024 * 1024 + 1), reason: "source-too-large" },
])("native settings refuse a $name", ({ suffix, reason }) => {
  const f = fixture();
  try {
    appendFileSync(f.rollout, suffix);
    const result = f.run();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "unavailable", reason });
    expect(result.stdout).not.toContain('"model"');
  } finally {
    f.close();
  }
});

test("native settings refuse a source larger than the read bound", () => {
  const f = fixture();
  try {
    truncateSync(f.rollout, 64 * 1024 * 1024 + 1);
    const result = f.run();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ reason: "source-too-large" });
  } finally {
    f.close();
  }
});

test("native settings refuse a wrong header ID even when the filename matches", () => {
  const f = fixture();
  try {
    writeFileSync(
      f.rollout,
      readFileSync(f.rollout, "utf8").replace(sessionId, "507feafe-e82b-4df4-91ba-4f1aeb987508"),
    );
    const result = f.run();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ reason: "session-unavailable" });
  } finally {
    f.close();
  }
});

test("the source fingerprint is stable until native history changes", () => {
  const f = fixture();
  try {
    const first = f.run();
    const second = f.run();
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    appendFileSync(
      f.rollout,
      `${JSON.stringify({ type: "turn_context", payload: { cwd: f.root, model: "next-model", effort: "low" } })}\n`,
    );
    const next = f.run();
    expect(next.status).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ model: "next-model", effort: "low" });
    expect(JSON.parse(next.stdout).fingerprint).not.toBe(JSON.parse(first.stdout).fingerprint);
  } finally {
    f.close();
  }
});

test("a matching FIFO refuses without waiting for a writer", () => {
  const f = fixture();
  try {
    rmSync(f.rollout);
    execFileSync("mkfifo", [f.rollout]);
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ reason: "session-unavailable" });
  } finally {
    f.close();
  }
});

test("native settings inspection accepts the shared session-id alias", () => {
  const f = fixture();
  try {
    const result = f.run(["--session-id"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "available", sessionId });
  } finally {
    f.close();
  }
});

test("native UTF-8 records may cross a read boundary without changing the settings", () => {
  const f = fixture();
  try {
    const prefix = '{"type":"response_item","payload":{"content":"';
    const bytes = readFileSync(f.rollout).length + Buffer.byteLength(prefix);
    const padding = 65536 - (bytes % 65536) - 1;
    appendFileSync(f.rollout, `${prefix}${"x".repeat(padding)}💡"}}\n`);
    const result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ model: "custom-model", effort: "high" });
    expect(result.stdout).not.toContain("💡");
  } finally {
    f.close();
  }
});

test.each(["claude", "muse", "pi"])(
  "%s native settings remain explicitly unsupported",
  (harness) => {
    const f = fixture();
    try {
      const result = f.run([], "inspect", harness);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        v: 1,
        harness,
        status: "unavailable",
        reason: "unsupported-harness",
      });
    } finally {
      f.close();
    }
  },
);

test.each([["--model", "custom-model"], ["--argv"], ["--", "extra"], ["positional"]])(
  "native inspection refuses extra arguments %j",
  (...extra) => {
    const f = fixture();
    try {
      const result = f.run(extra);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "unavailable",
        reason: "invalid-request",
      });
    } finally {
      f.close();
    }
  },
);
