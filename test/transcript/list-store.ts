/**
 * Builds one synthetic native store per harness under a temporary home, with
 * the identity, workspace and mode markers the real stores carry. The listing
 * is checked against these rather than against a machine's own sessions.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeCursorStore, writeDatabase } from "./cursor-store.js";

export const WORKSPACE_A = "/synthetic/alpha";
export const WORKSPACE_B = "/synthetic/beta";

/** Distinct write times, newest first, so row order is checkable. */
export const WRITE_TIMES = {
  claudeInteractive: "2026-09-20T13:00:00.000Z",
  claudeHeadless: "2026-09-20T12:00:00.000Z",
  claudeSidechain: "2026-09-20T11:00:00.000Z",
  claudeOther: "2026-09-20T10:00:00.000Z",
  codexInteractive: "2026-09-20T09:00:00.000Z",
  codexHeadless: "2026-09-20T08:00:00.000Z",
  codexSubagent: "2026-09-20T07:00:00.000Z",
  codexArchived: "2026-09-20T06:00:00.000Z",
  codexCompressed: "2026-09-20T05:00:00.000Z",
  pi: "2026-09-20T04:00:00.000Z",
  muse: "2026-09-20T03:00:00.000Z",
  museSubagent: "2026-09-20T02:00:00.000Z",
  cursor: "2026-09-20T01:00:00.000Z",
  // Older than every other source, so a time window cannot pick it up.
  museUnmarked: "2026-09-20T00:30:00.000Z",
  antigravity: "2026-09-20T00:00:00.000Z",
} as const;

/**
 * Native start times, taken from each store's own header rather than the
 * filesystem. They are a day behind the write times so a row that reported
 * the filesystem's answer for `startedAt` could not pass. Antigravity writes
 * second precision, as the real logs do.
 */
export const START_TIMES = {
  claudeInteractive: "2026-09-19T13:00:00.000Z",
  claudeHeadless: "2026-09-19T12:00:00.000Z",
  claudeSidechain: "2026-09-19T11:00:00.000Z",
  claudeOther: "2026-09-19T10:00:00.000Z",
  codexInteractive: "2026-09-19T09:00:00.000Z",
  codexHeadless: "2026-09-19T08:00:00.000Z",
  codexSubagent: "2026-09-19T07:00:00.000Z",
  codexArchived: "2026-09-19T06:00:00.000Z",
  pi: "2026-09-19T04:00:00.000Z",
  muse: "2026-09-19T03:00:00.000Z",
  museSubagent: "2026-09-19T02:00:00.000Z",
  cursor: "2026-09-19T01:00:00.000Z",
  museUnmarked: "2026-09-19T00:30:00.000Z",
  antigravity: "2026-09-19T00:00:00Z",
} as const;

export const IDS = {
  claudeInteractive: "11111111-1111-4111-8111-111111111111",
  claudeHeadless: "22222222-2222-4222-8222-222222222222",
  claudeSidechain: "33333333-3333-4333-8333-333333333333",
  claudeOther: "44444444-4444-4444-8444-444444444444",
  codexInteractive: "55555555-5555-4555-8555-555555555555",
  codexHeadless: "66666666-6666-4666-8666-666666666666",
  codexSubagent: "77777777-7777-4777-8777-777777777777",
  codexArchived: "88888888-8888-4888-8888-888888888888",
  codexCompressed: "99999999-9999-4999-8999-999999999999",
  pi: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  muse: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  museSubagent: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  cursor: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  museUnmarked: "01010101-0101-4101-8101-010101010101",
  antigravity: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  antigravityChild: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

function write(path: string, text: string, writeTime?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (writeTime) touch(path, writeTime);
}
export function touch(path: string, writeTime: string): void {
  const at = new Date(writeTime);
  utimesSync(path, at, at);
}
const lines = (entries: readonly unknown[]): string =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

function claudeRecord(
  id: string,
  cwd: string,
  entrypoint: string | null,
  startedAt: string,
  isSidechain = false,
): unknown {
  return {
    parentUuid: null,
    isSidechain,
    type: "user",
    uuid: `${id.slice(0, 8)}-0000-4000-8000-000000000001`,
    timestamp: startedAt,
    userType: "external",
    ...(entrypoint === null ? {} : { entrypoint }),
    cwd,
    sessionId: id,
    version: "2.1.263",
    message: { role: "user", content: "synthetic question" },
  };
}
function codexRollout(
  id: string,
  cwd: string,
  startedAt: string,
  payload: Record<string, unknown>,
): string {
  return lines([
    {
      timestamp: startedAt,
      type: "session_meta",
      payload: { session_id: id, id, cwd, ...payload },
    },
  ]);
}
/** Muse counts `recorded_at` in microseconds since the epoch, as the real
 * store does; the opening frame envelope carries none. */
function museRecord(workspaceRoot: string, startedAt: string): unknown {
  return {
    schema_version: 1,
    stream: { kind: "session", id: "01a0b000-0000-7000-8000-000000000001" },
    sequence: 0,
    recorded_at: Date.parse(startedAt) * 1000,
    record_type: "observed",
    payload_type: "runtime.session.metadata",
    payload: { kind: "metadata", record: { workspace_root: workspaceRoot } },
  };
}
/** A Muse session whose store never wrote the metadata record naming its
 * workspace. Four of the 990 Muse sources on the machine this was written
 * against are like this; they still carry `recorded_at` on every record. */
function museUnmarkedRecord(startedAt: string): unknown {
  return {
    schema_version: 1,
    stream: { kind: "session", id: "01a0b000-0000-7000-8000-000000000002" },
    sequence: 0,
    recorded_at: Date.parse(startedAt) * 1000,
    record_type: "event",
    payload_type: "runtime.session",
    payload: { kind: "run", event: { kind: "started" } },
  };
}
function antigravityStep(startedAt: string): string {
  return lines([
    {
      step_index: 0,
      source: "USER",
      type: "USER_INPUT",
      status: "DONE",
      created_at: startedAt,
      content: "synthetic question",
    },
  ]);
}

/** The real `conversation_summaries` definition, so column order comes from it. */
const ANTIGRAVITY_SCHEMA =
  'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",' +
  '`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,' +
  "`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL," +
  '`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",' +
  '`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",' +
  '`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,' +
  "`raw_summary` blob,PRIMARY KEY (`conversation_id`))";

function summaryRow(id: string, workspace: string | null, parent: string, depth: number): string {
  const uris = workspace ? JSON.stringify([`file://${encodeURI(workspace)}`]) : "[]";
  return (
    "INSERT INTO conversation_summaries (conversation_id,title,preview,step_count," +
    "last_modified_time,workspace_uris,status,source,project_id,agent_name," +
    `parent_conversation_id,nesting_depth,raw_summary) VALUES ('${id}','t','p',1,` +
    `'2026-09-20 00:00:00+00:00','${uris}','CASCADE_RUN_STATUS_IDLE','',` +
    `'default-cli-project','','${parent}',${depth},NULL)`
  );
}

export interface SyntheticStore {
  readonly home: string;
  readonly env: Record<string, string>;
}

/** Writes every harness's store under `home` and returns the env that finds them. */
export async function writeSyntheticStores(home: string): Promise<SyntheticStore> {
  const claudeProjects = join(home, ".claude", "projects", "-synthetic-alpha");
  write(
    join(claudeProjects, `${IDS.claudeInteractive}.jsonl`),
    lines([claudeRecord(IDS.claudeInteractive, WORKSPACE_A, "cli", START_TIMES.claudeInteractive)]),
    WRITE_TIMES.claudeInteractive,
  );
  write(
    join(claudeProjects, `${IDS.claudeHeadless}.jsonl`),
    lines([claudeRecord(IDS.claudeHeadless, WORKSPACE_A, "sdk-cli", START_TIMES.claudeHeadless)]),
    WRITE_TIMES.claudeHeadless,
  );
  write(
    join(claudeProjects, `${IDS.claudeSidechain}.jsonl`),
    lines([
      claudeRecord(IDS.claudeSidechain, WORKSPACE_A, "cli", START_TIMES.claudeSidechain, true),
    ]),
    WRITE_TIMES.claudeSidechain,
  );
  write(
    join(home, ".claude", "projects", "-synthetic-beta", `${IDS.claudeOther}.jsonl`),
    lines([claudeRecord(IDS.claudeOther, WORKSPACE_B, "cli", START_TIMES.claudeOther)]),
    WRITE_TIMES.claudeOther,
  );

  const codexDay = join(home, ".codex", "sessions", "2026", "09", "20");
  write(
    join(codexDay, `rollout-2026-09-20T00-00-00-${IDS.codexInteractive}.jsonl`),
    codexRollout(IDS.codexInteractive, WORKSPACE_A, START_TIMES.codexInteractive, {
      source: "cli",
      originator: "codex-tui",
    }),
    WRITE_TIMES.codexInteractive,
  );
  write(
    join(codexDay, `rollout-2026-09-20T00-00-00-${IDS.codexHeadless}.jsonl`),
    codexRollout(IDS.codexHeadless, WORKSPACE_A, START_TIMES.codexHeadless, {
      source: "exec",
      originator: "codex_exec",
    }),
    WRITE_TIMES.codexHeadless,
  );
  write(
    join(codexDay, `rollout-2026-09-20T00-00-00-${IDS.codexSubagent}.jsonl`),
    codexRollout(IDS.codexSubagent, WORKSPACE_A, START_TIMES.codexSubagent, {
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: IDS.codexInteractive,
            depth: 1,
            agent_role: "explorer",
          },
        },
      },
      originator: "codex-tui",
    }),
    WRITE_TIMES.codexSubagent,
  );
  write(
    join(
      home,
      ".codex",
      "archived_sessions",
      `rollout-2026-09-20T00-00-00-${IDS.codexArchived}.jsonl`,
    ),
    codexRollout(IDS.codexArchived, WORKSPACE_B, START_TIMES.codexArchived, {
      source: "vscode",
      originator: "codex-vscode",
    }),
    WRITE_TIMES.codexArchived,
  );
  write(
    join(codexDay, `rollout-2026-09-20T00-00-00-${IDS.codexCompressed}.jsonl.zst`),
    "compressed bytes are never parsed\n",
    WRITE_TIMES.codexCompressed,
  );

  write(
    join(
      home,
      ".pi",
      "agent",
      "sessions",
      "--synthetic-alpha--",
      `2026-09-20T00-00-00-000Z_${IDS.pi}.jsonl`,
    ),
    lines([
      { type: "session", version: 3, id: IDS.pi, cwd: WORKSPACE_A, timestamp: START_TIMES.pi },
    ]),
    WRITE_TIMES.pi,
  );

  const museSession = join(
    home,
    ".local",
    "share",
    "muse",
    "sessions",
    "2026",
    "09",
    "20",
    IDS.muse,
  );
  write(
    join(museSession, "session.jsonl"),
    lines([museRecord(WORKSPACE_A, START_TIMES.muse)]),
    WRITE_TIMES.muse,
  );
  write(
    join(museSession, "subagent", IDS.museSubagent, "session.jsonl"),
    lines([museRecord(WORKSPACE_A, START_TIMES.museSubagent)]),
    WRITE_TIMES.museSubagent,
  );

  const cursorChat = join(home, ".cursor", "chats", "0".repeat(32), IDS.cursor);
  mkdirSync(cursorChat, { recursive: true });
  await writeCursorStore(join(cursorChat, "store.db"), {
    agentId: IDS.cursor,
    messages: [{ role: "user", content: "synthetic question" }],
  });
  write(
    join(cursorChat, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      createdAtMs: Date.parse(START_TIMES.cursor),
      hasConversation: true,
      updatedAtMs: Date.parse(START_TIMES.cursor) + 1,
      cwd: WORKSPACE_A,
    }),
  );
  touch(join(cursorChat, "store.db"), WRITE_TIMES.cursor);

  const museUnmarked = join(
    home,
    ".local",
    "share",
    "muse",
    "sessions",
    "2026",
    "09",
    "20",
    IDS.museUnmarked,
  );
  write(
    join(museUnmarked, "session.jsonl"),
    lines([museUnmarkedRecord(START_TIMES.museUnmarked)]),
    WRITE_TIMES.museUnmarked,
  );

  const brain = join(home, ".gemini", "antigravity-cli", "brain");
  for (const id of [IDS.antigravity, IDS.antigravityChild])
    write(
      join(brain, id, ".system_generated", "logs", "transcript_full.jsonl"),
      antigravityStep(START_TIMES.antigravity),
      WRITE_TIMES.antigravity,
    );
  await writeDatabase(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"), [
    ANTIGRAVITY_SCHEMA,
    summaryRow(IDS.antigravity, WORKSPACE_A, "", 0),
    summaryRow(IDS.antigravityChild, WORKSPACE_A, IDS.antigravity, 1),
  ]);

  return {
    home,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      CURSOR_CONFIG_DIR: join(home, ".cursor"),
    },
  };
}
