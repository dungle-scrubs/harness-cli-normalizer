import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { listSessions } from "../../src/execution/transcript/list.js";
import {
  IDS,
  START_TIMES,
  WORKSPACE_A,
  WORKSPACE_B,
  WRITE_TIMES,
  writeSyntheticStores,
} from "./list-store.js";

interface Row {
  readonly kind: string;
  readonly harness: string;
  readonly id: string;
  readonly file: string;
  readonly cwd: string | null;
  readonly lastWriteAt: string;
  readonly startedAt: string | null;
  readonly sizeBytes: number;
  readonly mode: string;
  readonly readable: boolean;
  readonly blocked: { readonly issue: string; readonly reason: string } | null;
}
interface HarnessOutcome {
  readonly harness: string;
  readonly state: string;
  readonly rows: number;
  readonly reason: string | null;
}
interface Listing {
  readonly code: number | null;
  readonly source: { readonly kind: string; readonly scope: Record<string, unknown> };
  readonly rows: readonly Row[];
  readonly result: {
    readonly kind: string;
    readonly exitCode: number;
    readonly status: string;
    readonly rowsReturned: number;
    readonly more: boolean;
    readonly harnesses: readonly HarnessOutcome[];
    readonly failure: { readonly issue: string; readonly message: string } | null;
  };
}

let home = "";
let storeEnv: Record<string, string> = {};

beforeAll(async () => {
  const built = spawnSync("node", [resolve("scripts/build-native.ts"), "--stage"], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(built.status, built.stderr).toBe(0);
  home = mkdtempSync(join(tmpdir(), "hcn-list-home-"));
  storeEnv = (await writeSyntheticStores(home)).env;
});
afterAll(() => {
  if (home) rmSync(home, { force: true, recursive: true });
});

function list(args: readonly string[]): Listing {
  const run = spawnSync("bun", [resolve("src/cli/index.ts"), "transcript", "ls", ...args], {
    encoding: "utf8",
    env: { ...storeEnv, PATH: process.env.PATH, TMPDIR: tmpdir() },
  });
  if (run.error) throw run.error;
  const parsed = run.stdout
    .trim()
    .split("\n")
    .filter((line) => line)
    .map((line) => JSON.parse(line) as unknown);
  const source = parsed[0] as Listing["source"];
  const result = parsed.at(-1) as Listing["result"];
  expect(source?.kind, run.stderr).toBe("session-list-source");
  expect(result?.kind, run.stderr).toBe("session-list-result");
  return { code: run.status, source, rows: parsed.slice(1, -1) as Row[], result };
}
const identify = (rows: readonly Row[]): string[] => rows.map((row) => `${row.harness}:${row.id}`);
const outcome = (listing: Listing, harness: string): HarnessOutcome => {
  const found = listing.result.harnesses.find((item) => item.harness === harness);
  if (!found) throw new Error(`no outcome for ${harness}`);
  return found;
};

test("every harness contributes its saved sessions for one workspace, newest first", () => {
  const listing = list(["--cwd", WORKSPACE_A, "--headless"]);
  expect(listing.code, JSON.stringify(listing.result)).toBe(0);
  expect(listing.result.status).toBe("complete");
  expect(identify(listing.rows)).toEqual([
    `claude:${IDS.claudeInteractive}`,
    `claude:${IDS.claudeHeadless}`,
    `codex:${IDS.codexInteractive}`,
    `codex:${IDS.codexHeadless}`,
    `pi:${IDS.pi}`,
    `muse:${IDS.muse}`,
    `cursor:${IDS.cursor}`,
    `antigravity:${IDS.antigravity}`,
  ]);
  for (const harness of ["claude", "codex", "pi", "muse", "cursor", "antigravity"])
    expect(outcome(listing, harness).state, harness).toBe("listed");
  expect(listing.rows.map((row) => row.lastWriteAt)).toEqual([
    WRITE_TIMES.claudeInteractive,
    WRITE_TIMES.claudeHeadless,
    WRITE_TIMES.codexInteractive,
    WRITE_TIMES.codexHeadless,
    WRITE_TIMES.pi,
    WRITE_TIMES.muse,
    WRITE_TIMES.cursor,
    WRITE_TIMES.antigravity,
  ]);
  expect(new Set(listing.rows.map((row) => row.cwd))).toEqual(new Set([WORKSPACE_A]));
  expect(listing.rows.every((row) => row.readable)).toBe(true);
});

test("each row carries the start time its own native header names", () => {
  const rows = list(["--cwd", WORKSPACE_A, "--headless"]).rows;
  const started = (harness: string): string | null | undefined =>
    rows.find((row) => row.harness === harness)?.startedAt;
  // Four shapes in, one shape out: ISO with milliseconds from claude, codex
  // and pi, epoch microseconds from muse, epoch milliseconds from cursor, and
  // second-precision ISO from antigravity.
  expect(started("claude")).toBe(START_TIMES.claudeInteractive);
  expect(started("codex")).toBe(START_TIMES.codexInteractive);
  expect(started("pi")).toBe(START_TIMES.pi);
  expect(started("muse")).toBe(START_TIMES.muse);
  expect(started("cursor")).toBe(START_TIMES.cursor);
  expect(started("antigravity")).toBe("2026-09-19T00:00:00.000Z");
  // The store's own time, never the filesystem's: every start time here is a
  // day behind the write time beside it.
  for (const row of rows) expect(row.startedAt, row.harness).not.toBe(row.lastWriteAt);
});

test("a session whose store names no workspace still reports its start time", () => {
  const row = list(["--all-workspaces", "--headless"]).rows.find(
    (item) => item.id === IDS.museUnmarked,
  );
  // The workspace is genuinely absent, so the row says so.
  expect(row?.cwd).toBeNull();
  // The prefix the scan already read carries the time, so the row reports it.
  // A missing workspace is not a reason to drop a fact the store does record.
  expect(row?.startedAt).toBe(START_TIMES.museUnmarked);
});

test("a source with no readable header reports no start time", () => {
  const row = list(["--all-workspaces", "--headless"]).rows.find(
    (item) => item.id === IDS.codexCompressed,
  );
  expect(row?.startedAt).toBeNull();
});

test("each row names the native source transcript read accepts", () => {
  const rows = list(["--cwd", WORKSPACE_A, "--headless"]).rows;
  const file = (harness: string): string => rows.find((row) => row.harness === harness)?.file ?? "";
  expect(file("claude")).toBe(
    join(home, ".claude", "projects", "-synthetic-alpha", `${IDS.claudeInteractive}.jsonl`),
  );
  expect(file("cursor")).toBe(
    join(home, ".cursor", "chats", "0".repeat(32), IDS.cursor, "store.db"),
  );
  expect(file("antigravity")).toBe(
    join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      IDS.antigravity,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    ),
  );
  const read = spawnSync(
    "bun",
    [resolve("src/cli/index.ts"), "transcript", "read", "claude", "--file", file("claude")],
    { encoding: "utf8", env: { ...storeEnv, PATH: process.env.PATH, TMPDIR: tmpdir() } },
  );
  expect(read.status, read.stderr).toBe(0);
});

test("--cwd scopes by exact workspace and --all-workspaces drops the filter", () => {
  const alpha = list(["--cwd", WORKSPACE_A, "--headless"]);
  expect(identify(alpha.rows)).not.toContain(`claude:${IDS.claudeOther}`);
  const beta = list(["--cwd", WORKSPACE_B, "--headless"]);
  expect(identify(beta.rows)).toEqual([`claude:${IDS.claudeOther}`, `codex:${IDS.codexArchived}`]);
  const nowhere = list(["--cwd", "/synthetic/alpha/inner", "--headless"]);
  expect(nowhere.rows).toEqual([]);
  expect(nowhere.result.status).toBe("complete");
  const all = list(["--all-workspaces", "--headless"]);
  expect(all.rows.length).toBeGreaterThan(alpha.rows.length);
  expect(identify(all.rows)).toEqual(
    expect.arrayContaining([...identify(alpha.rows), ...identify(beta.rows)]),
  );
});

test("the default scope omits headless runs and --headless admits them", () => {
  const listing = list(["--cwd", WORKSPACE_A]);
  expect(identify(listing.rows)).toEqual([
    `claude:${IDS.claudeInteractive}`,
    `codex:${IDS.codexInteractive}`,
    `pi:${IDS.pi}`,
    `muse:${IDS.muse}`,
    `cursor:${IDS.cursor}`,
    `antigravity:${IDS.antigravity}`,
  ]);
  const withHeadless = list(["--cwd", WORKSPACE_A, "--headless"]);
  const mode = (id: string): string | undefined =>
    withHeadless.rows.find((row) => row.id === id)?.mode;
  // Claude reads `entrypoint`; Codex reads session_meta `source`/`originator`.
  expect(mode(IDS.claudeHeadless)).toBe("headless");
  expect(mode(IDS.codexHeadless)).toBe("headless");
  expect(mode(IDS.claudeInteractive)).toBe("interactive");
  expect(mode(IDS.codexInteractive)).toBe("interactive");
  // Pi, Muse, Cursor and Antigravity carry no observed marker.
  for (const id of [IDS.pi, IDS.muse, IDS.cursor, IDS.antigravity])
    expect(mode(id), id).toBe("unknown");
});

test("child conversations are not rows", () => {
  const all = identify(list(["--all-workspaces", "--headless"]).rows);
  expect(all).not.toContain(`claude:${IDS.claudeSidechain}`);
  expect(all).not.toContain(`codex:${IDS.codexSubagent}`);
  expect(all).not.toContain(`muse:${IDS.museSubagent}`);
  expect(all).not.toContain(`antigravity:${IDS.antigravityChild}`);
  // Their parents are still listed, so the rule dropped the children only.
  expect(all).toContain(`codex:${IDS.codexInteractive}`);
  expect(all).toContain(`muse:${IDS.muse}`);
  expect(all).toContain(`antigravity:${IDS.antigravity}`);
});

test("each row reports its own native source in bytes", () => {
  const rows = list(["--cwd", WORKSPACE_A, "--headless"]).rows;
  for (const row of rows) {
    // The row's own file, not whichever file its markers came from: Cursor
    // reads `meta.json` for those and reports the `store.db` beside it.
    expect(row.sizeBytes, `${row.harness}:${row.id}`).toBe(statSync(row.file).size);
    expect(row.sizeBytes, `${row.harness}:${row.id}`).toBeGreaterThan(0);
  }
  const cursor = rows.find((row) => row.harness === "cursor");
  const meta = join(dirname(cursor?.file ?? ""), "meta.json");
  expect(cursor?.sizeBytes).not.toBe(statSync(meta).size);
});

test("a chat whose WAL still holds writes lists readable and names what blocks the read", () => {
  const store = join(home, ".cursor", "chats", "0".repeat(32), IDS.cursor, "store.db");
  const wal = `${store}-wal`;
  // What a Cursor turn in progress leaves behind: committed writes the main
  // file does not hold yet.
  writeFileSync(wal, "uncheckpointed");
  try {
    const row = list(["--cwd", WORKSPACE_A, "--headless"]).rows.find(
      (item) => item.harness === "cursor",
    );
    // A verified method still addresses this source; it is the source that is
    // busy, and the two are different answers.
    expect(row?.readable).toBe(true);
    expect(row?.blocked?.issue).toBe("guarantee-unmet");
    expect(row?.blocked?.reason).toContain("-wal");
    // The read refuses on exactly the precondition the row named.
    const read = spawnSync(
      "bun",
      [resolve("src/cli/index.ts"), "transcript", "read", "cursor", "--file", store],
      { encoding: "utf8", env: { ...storeEnv, PATH: process.env.PATH, TMPDIR: tmpdir() } },
    );
    expect(read.status, read.stderr).not.toBe(0);
    expect(read.stdout).toContain("guarantee-unmet");
  } finally {
    rmSync(wal, { force: true });
  }
});

test("a source with nothing blocking it names no blocker", () => {
  const rows = list(["--cwd", WORKSPACE_A, "--headless"]).rows;
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter((row) => row.blocked !== null)).toEqual([]);
});

test("a source transcript read refuses on sight is listed as unreadable", () => {
  const row = list(["--all-workspaces", "--headless"]).rows.find(
    (item) => item.id === IDS.codexCompressed,
  );
  expect(row?.readable).toBe(false);
  expect(row?.cwd).toBeNull();
  expect(row?.mode).toBe("unknown");
});

test("--harness narrows the result and --limit caps the rows", () => {
  const narrowed = list(["--cwd", WORKSPACE_A, "--headless", "--harness", "claude,codex"]);
  expect(narrowed.source.scope).toMatchObject({ workspace: WORKSPACE_A, headless: true });
  expect(narrowed.result.harnesses.map((item) => item.harness)).toEqual(["claude", "codex"]);
  expect(new Set(narrowed.rows.map((row) => row.harness))).toEqual(new Set(["claude", "codex"]));
  const limited = list(["--cwd", WORKSPACE_A, "--headless", "--limit", "2"]);
  expect(identify(limited.rows)).toEqual([
    `claude:${IDS.claudeInteractive}`,
    `claude:${IDS.claudeHeadless}`,
  ]);
  expect(limited.result.rowsReturned).toBe(2);
  expect(limited.result.more).toBe(true);
  expect(outcome(limited, "claude").rows).toBe(2);
  const unlimited = list(["--cwd", WORKSPACE_A, "--headless"]);
  expect(unlimited.result.more).toBe(false);
});

test("--since-time admits only sources written at or after that instant", () => {
  const listing = list([
    "--all-workspaces",
    "--headless",
    "--since-time",
    WRITE_TIMES.codexInteractive,
  ]);
  expect(listing.code, JSON.stringify(listing.result)).toBe(0);
  expect(identify(listing.rows)).toEqual([
    `claude:${IDS.claudeInteractive}`,
    `claude:${IDS.claudeHeadless}`,
    `claude:${IDS.claudeOther}`,
    // Written exactly at the instant asked for, so it is in.
    `codex:${IDS.codexInteractive}`,
  ]);
  expect(listing.source.scope).toMatchObject({ sinceTime: WRITE_TIMES.codexInteractive });
  // A harness whose every source is older still lists, with no rows.
  expect(outcome(listing, "muse")).toMatchObject({ state: "listed", rows: 0 });
});

test("--since-time takes a UTC instant and refuses anything else", () => {
  for (const value of ["2026-09-20", "2026-09-20T09:00:00", "2026-09-20T09:00:00+02:00", "now"]) {
    const listing = list(["--all-workspaces", "--since-time", value]);
    expect(listing.code, value).toBe(2);
    expect(listing.result.failure?.issue, value).toBe("invalid-option-value");
    expect(listing.rows).toEqual([]);
  }
});

test("an unknown flag and a bad --limit refuse with exit 2", () => {
  for (const [args, issue] of [
    [["--nope"], "invalid-option-value"],
    [["--limit", "0"], "invalid-option-value"],
    [["--limit", "two"], "invalid-option-value"],
    [["--harness", "grok"], "invalid-option-value"],
    [["--cwd", WORKSPACE_A, "--all-workspaces"], "mutually-exclusive-options"],
  ] as const) {
    const listing = list([...args]);
    expect(listing.code, args.join(" ")).toBe(2);
    expect(listing.result.exitCode).toBe(2);
    expect(listing.result.status).toBe("refused");
    expect(listing.result.failure?.issue, args.join(" ")).toBe(issue);
    expect(listing.rows).toEqual([]);
  }
});

test("a harness with no listing method is reported with its reason and keeps exit 0", async () => {
  const written: string[] = [];
  const exitCode = await listSessions(
    {
      harnesses: [
        {
          harness: "cursor",
          listing: null,
          listingRoot: null,
          readable: true,
          quiescentSiblings: [],
          divergence: "cursor has no transcript listing method in v1.",
        },
      ],
      hcnVersion: "0.0.0-test",
      workspace: null,
      headless: true,
      limit: null,
      sinceTime: null,
    },
    {
      files: {
        open: () => Promise.reject(new Error("unused")),
        version: () => Promise.reject(new Error("unused")),
      },
      snapshotFiles: {
        open: () => Promise.reject(new Error("unused")),
        version: () => Promise.reject(new Error("unused")),
      },
      write: async (line) => {
        written.push(line);
      },
    },
  );
  expect(exitCode).toBe(0);
  const result = JSON.parse(written.at(-1) ?? "{}") as Listing["result"];
  expect(result.status).toBe("partial");
  expect(result.exitCode).toBe(0);
  expect(result.rowsReturned).toBe(0);
  expect(result.harnesses).toEqual([
    {
      harness: "cursor",
      state: "divergent",
      storeRoot: null,
      rows: 0,
      reason: "cursor has no transcript listing method in v1.",
      issue: "transcript-divergence",
    },
  ]);
});

test("a harness whose store cannot be read is reported and the rest still list", () => {
  const listing = list(["--all-workspaces", "--headless", "--harness", "antigravity,claude"]);
  expect(listing.code).toBe(0);
  expect(outcome(listing, "antigravity").state).toBe("listed");
  const broken = spawnSync(
    "bun",
    [
      resolve("src/cli/index.ts"),
      "transcript",
      "ls",
      "--all-workspaces",
      "--headless",
      "--harness",
      "claude",
    ],
    {
      encoding: "utf8",
      env: {
        ...storeEnv,
        CLAUDE_CONFIG_DIR: join(home, "absent"),
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
      },
    },
  );
  expect(broken.status, broken.stderr).toBe(0);
  const result = JSON.parse(broken.stdout.trim().split("\n").at(-1) ?? "{}") as Listing["result"];
  // An absent store root is an empty store, not a failure.
  expect(result.harnesses[0]).toMatchObject({ harness: "claude", state: "listed", rows: 0 });
});
