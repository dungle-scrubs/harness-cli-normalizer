import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { cliFixtureTmpdir } from "../cli/fixture-tmpdir.js";

/**
 * The published protocol surface (issue #441, ADR 0014), checked the way a
 * consumer sees it: a temporary project with no `@types/node` and no
 * dependencies of its own resolves the package through `node_modules` and
 * compiles against `dist/` with the repository's own tsc. The build has to
 * exist first (`pnpm check` runs it before the test lanes).
 */
const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

/** The exact compiler options an outsider starts from: strict, no ambient
 * node types, and every shipped declaration checked. */
const consumerTsconfig = {
  compilerOptions: {
    module: "NodeNext",
    strict: true,
    types: [],
    skipLibCheck: false,
    noEmit: true,
    target: "ES2023",
  },
  files: ["src/main.ts"],
};

/** A consumer that spells every command arm, switches exhaustively on both
 * event unions, and tries the three shapes the wire must refuse. */
const consumerMain = `import type {
  RunEvent,
  SessionCommand,
  SessionEvent,
} from "@dungle-scrubs/harness-cli-normalizer/protocol";

const commands: readonly SessionCommand[] = [
  { op: "send", id: "in-1", text: "hello" },
  { op: "answer", id: "in-2", text: "yes" },
  { op: "interrupt", id: "in-3" },
  { op: "stop-background", id: "in-4", job: "job-1" },
  { op: "approval", id: "in-5", requestId: "req-1", choiceId: "allow" },
  { op: "settings", id: "in-6", model: "opus" },
  { op: "close" },
];

const runKindOf = (event: RunEvent): string => {
  switch (event.kind) {
    case "identity":
      return event.sessionId;
    case "token":
      return event.text;
    case "message":
      return event.text;
    case "progress":
      return event.label;
    case "tool":
      return event.name;
    case "tool-result":
      return event.name ?? event.callId ?? "tool-result";
    case "usage":
      return event.scope;
    case "compaction":
      return event.state;
    case "background":
      return event.id;
    case "question":
      return event.question;
    case "limit":
      return event.code;
    case "warning":
      return event.message;
    case "error":
      return event.message;
    case "failure":
      return event.class;
    case "done":
      return event.cause;
    case "approval-request":
      return event.requestId;
    case "approval-disposition":
      return event.status;
    case "approval-cleared":
      return event.requestId;
    default: {
      const unhandled: never = event;
      return String(unhandled);
    }
  }
};

const sessionKindOf = (event: SessionEvent): string => {
  switch (event.kind) {
    case "session":
      return event.harness;
    case "turn":
      return event.turnId;
    case "disposition":
      return event.disposition;
    case "interruption":
      return event.state;
    case "background-stop":
      return event.state;
    case "settings":
      return event.state;
    case "closed":
      return event.cause;
    case "identity":
      return event.sessionId;
    case "token":
      return event.text;
    case "message":
      return event.text;
    case "progress":
      return event.label;
    case "tool":
      return event.name;
    case "tool-result":
      return event.name ?? event.callId ?? "tool-result";
    case "usage":
      return event.scope;
    case "compaction":
      return event.state;
    case "background":
      return event.id;
    case "question":
      return event.question;
    case "limit":
      return event.code;
    case "warning":
      return event.message;
    case "error":
      return event.message;
    case "failure":
      return event.class;
    case "done":
      return event.cause;
    case "approval-request":
      return event.requestId;
    case "approval-disposition":
      return event.status;
    case "approval-cleared":
      return event.requestId;
    default: {
      const unhandled: never = event;
      return String(unhandled);
    }
  }
};

// An unknown event kind is on neither wire.
// @ts-expect-error
const unknownKind: SessionEvent = { kind: "reboot" };

// A send without its id is not a command the session reads.
// @ts-expect-error
const sendWithoutId: SessionCommand = { op: "send", text: "hi" };

const ended: SessionEvent = { kind: "closed", exitCode: 0, cause: "clean" };
if (ended.kind === "closed") {
  // A closed event carries no escalation record.
  // @ts-expect-error
  ended.escalation;
}

export const describeSample = (run: RunEvent, session: SessionEvent): string =>
  \`\${runKindOf(run)}/\${sessionKindOf(session)} of \${commands.length} commands\`;
`;

/** A consumer reaching past the export map: neither the package root nor a
 * deep dist path is an install surface. */
const offSurfaceMain = `import type * as root from "@dungle-scrubs/harness-cli-normalizer";
import type * as deep from "@dungle-scrubs/harness-cli-normalizer/dist/cli/index.js";

export type Surface = [root, deep];
`;

const writeConsumer = (root: string, main: string): string => {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@dungle-scrubs"), { recursive: true });
  symlinkSync(
    repositoryRoot,
    join(root, "node_modules", "@dungle-scrubs", "harness-cli-normalizer"),
  );
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(consumerTsconfig, null, 2)}\n`);
  writeFileSync(join(root, "src", "main.ts"), main);
  return join(root, "tsconfig.json");
};

const compileConsumer = (tsconfig: string): ReturnType<typeof spawnSync> =>
  spawnSync("node", [tsc, "-p", tsconfig], {
    encoding: "utf8",
    timeout: 120_000,
  });

describe("protocol export (issue #441)", () => {
  test("a consumer with no @types/node compiles against dist/ through ./protocol", () => {
    expect(
      existsSync(join(repositoryRoot, "dist", "cli", "protocol.d.ts")),
      "dist/cli/protocol.d.ts is missing - run `pnpm build` first",
    ).toBe(true);
    const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-protocol-consumer-"));
    try {
      const result = compileConsumer(writeConsumer(root, consumerMain));
      expect(
        result.status,
        `${String(result.error ?? "")}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the package root and deep dist paths fail to resolve: the surface is ./protocol", () => {
    const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-protocol-off-surface-"));
    try {
      const result = compileConsumer(writeConsumer(root, offSurfaceMain));
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("'@dungle-scrubs/harness-cli-normalizer'");
      expect(output).toContain("'@dungle-scrubs/harness-cli-normalizer/dist/cli/index.js'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
