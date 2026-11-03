/**
 * Built-CLI tests for the Cursor SDK backend (issue #440): run and session
 * over dist/cli.js under Node and Bun, driven end to end through the
 * scripted fake SDK loaded into the real worker by a test-only module
 * loader. The assertions cover the worker wire contract: model params,
 * first and second send, the question/answer escalation, native busy
 * rejection, interrupt during generation, resume across processes,
 * startup/auth failure, cancellation vs clean/error, the access mapping
 * including the task/mcp deny, no duplicate tool/usage observations,
 * malformed payload tolerance, and #438 message boundaries.
 *
 * Stream records (usage, tool_call) and callbacks (deltas, steps) race by
 * design in the SDK, so cross-source ORDER is never asserted - only
 * presence, counts, and per-source order.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { command, ndjsonOf, runCliWithFakeSdk, sendOf } from "./cursor-sdk-fixture.js";

const agentId = "agent-da354f73-06a8-4bb8-8c6f-e88da9f95eb1";
const cliUuid = "5d296b52-5123-42d9-90d1-125df15205b0";

/** The captured account catalog's gpt-5.3-codex entry, scripted into the
 * fake SDK so the built CLI resolves effort against the real public
 * shape (native default reasoning high, fast true; the CLI's medium tier
 * is the bare slug itself). */
const CODEX_CATALOG = JSON.parse(
  readFileSync(
    new URL("../fixtures/cursor-sdk-1.0.38/models.full.snapshot.json", import.meta.url),
    "utf8",
  ),
) as readonly unknown[];
const codexCatalog = CODEX_CATALOG.filter(
  (entry) => (entry as { id?: string }).id === "gpt-5.3-codex",
);
const pinnedMedium = {
  id: "gpt-5.3-codex",
  params: [
    { id: "reasoning", value: "medium" },
    { id: "fast", value: "false" },
  ],
};

describe("hcn run cursor (built CLI, fake SDK worker)", () => {
  test("spawns the worker, resolves model params, streams tokens once and a complete message", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              { delta: { type: "text-delta", text: "H" } },
              { delta: { type: "text-delta", text: "CN" } },
              { step: { type: "assistantMessage", message: { text: "HCN_CURSOR_SDK_OK" } } },
              {
                stream: {
                  type: "usage",
                  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
                },
              },
            ],
          }),
        ],
      },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--model",
        "grok-4.7",
        "--effort",
        "high",
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      const kinds = events.map((event) => event.kind);
      expect(kinds[0]).toBe("identity");
      expect(kinds.filter((kind) => kind === "token")).toEqual(["token", "token"]);
      expect(events.filter((event) => event.kind === "message")).toEqual([
        { kind: "message", role: "assistant", text: "HCN_CURSOR_SDK_OK" },
      ]);
      expect(events.filter((event) => event.kind === "usage")).toEqual([
        {
          kind: "usage",
          scope: "turn",
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          inputIncludesCache: false,
        },
      ]);
      expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
      const identity = events[0] as { sessionId?: string; authority?: string };
      expect(identity.sessionId).toBe(agentId);
      expect(identity.authority).toBe("harness-minted");
      // The worker received the resolved base id plus the pinned params -
      // grok-4.7-high decomposed against the catalog, never a raw slug.
      const create = run.calls[0] as { phase?: string; options?: Record<string, unknown> };
      expect(create.phase).toBe("create");
      expect(create.options?.model).toEqual({
        id: "grok-4.7",
        params: [
          { id: "reasoning_effort", value: "high" },
          { id: "context", value: "256k" },
          { id: "fast", value: "false" },
        ],
      });
      const send = run.calls.find((call) => call.phase === "send") as { message?: string };
      expect(send.message).toContain("fixture");
    } finally {
      run.cleanup();
    }
  });

  test("access write runs unconfined; bare runs inherit the SDK's native defaults", async () => {
    for (const args of [["--access", "write"], []] as const) {
      const run = await runCliWithFakeSdk({
        script: { agentId, sends: [sendOf({ status: "finished" })] },
        args: ["run", "cursor", "--json", "--questions", "none", ...args, "--prompt", "fixture"],
      });
      try {
        expect(run.status, run.stderr).toBe(0);
        const options = (run.calls[0] as { options?: Record<string, unknown> }).options;
        expect(options?.model).toEqual({ id: "grok-4.7" });
        // Neither leg carries an hcn tool restriction: a bare run leaves
        // the SDK's own default toolset and sandbox in place, write states
        // the unconfined contract.
        expect(options?.tools).toBeUndefined();
        expect(options?.disallowedTools).toBeUndefined();
        if (args.length > 0) {
          expect(options?.local).toMatchObject({ sandboxOptions: { enabled: false } });
        } else {
          expect(options?.local).not.toHaveProperty("sandboxOptions");
        }
      } finally {
        run.cleanup();
      }
    }
  });

  test("explicit --access read keeps the allowlist and the task/mcp deny, even with --autonomy", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished" })] },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--access",
        "read",
        "--autonomy",
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const options = (run.calls[0] as { options?: Record<string, unknown> }).options;
      expect(options?.tools).toEqual(["read", "grep", "glob", "ls", "webFetch", "webSearch"]);
      expect(options?.disallowedTools).toEqual(["task", "mcp"]);
      expect(options?.local).not.toHaveProperty("sandboxOptions");
    } finally {
      run.cleanup();
    }
  });

  test("a bare resume carries no hcn tool restriction either", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished" })] },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--resume",
        agentId,
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const resume = run.calls[0] as {
        phase?: string;
        options?: Record<string, unknown>;
      };
      expect(resume.phase).toBe("resume");
      expect(resume.options?.tools).toBeUndefined();
      expect(resume.options?.disallowedTools).toBeUndefined();
      expect(resume.options?.local).not.toHaveProperty("sandboxOptions");
    } finally {
      run.cleanup();
    }
  });

  test("one tool event, one tool-result, one usage - never duplicates", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              {
                stream: {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "running",
                  args: { path: "a" },
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "completed",
                  result: { content: "x" },
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "completed",
                  result: { content: "x" },
                },
              },
              { stream: { type: "usage", usage: { inputTokens: 1, totalTokens: 1 } } },
              { step: { type: "assistantMessage", message: { text: "done" } } },
            ],
          }),
        ],
      },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      expect(events.filter((event) => event.kind === "tool")).toEqual([
        { kind: "tool", name: "read", callId: "c1", input: { path: "a" } },
      ]);
      expect(events.filter((event) => event.kind === "tool-result")).toEqual([
        { kind: "tool-result", name: "read", callId: "c1", result: { content: "x" } },
      ]);
      expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
    } finally {
      run.cleanup();
    }
  });

  test("one native call the SDK reports as repeated running emits one tool; a nonzero SDK shell exit is an error result", async () => {
    // The SDK repeats running records for one call_id with identical args
    // in the committed task-steps capture. Its shell wrapper maps success and
    // failure alike onto status:success with the exitCode as the only
    // failure signal.
    const running = {
      stream: {
        type: "tool_call",
        call_id: "call-r",
        name: "shell",
        status: "running",
        args: { command: "sleep 10", timeout: 30000 },
      },
    };
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              running,
              running,
              {
                stream: {
                  type: "tool_call",
                  call_id: "call-r",
                  name: "shell",
                  status: "completed",
                  args: { command: "sleep 10", timeout: 30000 },
                  result: {
                    status: "success",
                    value: { exitCode: 7, signal: "", stdout: "", stderr: "", executionTime: 1 },
                  },
                },
              },
              { step: { type: "assistantMessage", message: { text: "done" } } },
            ],
          }),
        ],
      },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      expect(events.filter((event) => event.kind === "tool")).toEqual([
        {
          kind: "tool",
          name: "shell",
          callId: "call-r",
          input: { command: "sleep 10", timeout: 30000 },
        },
      ]);
      expect(events.filter((event) => event.kind === "tool-result")).toEqual([
        {
          kind: "tool-result",
          name: "shell",
          callId: "call-r",
          result: {
            status: "success",
            value: { exitCode: 7, signal: "", stdout: "", stderr: "", executionTime: 1 },
          },
          isError: true,
        },
      ]);
    } finally {
      run.cleanup();
    }
  });

  test("SDK status:error shell completions - timeout and rejection-looking alike - are error results, never denials", async () => {
    // The installed @cursor/sdk 1.0.38 converts rejection, timeout and
    // spawn errors for ordinary built-in tools into one and the same
    // {status:'error', error:{message,...}} wrapper (dist/cjs/748.js): the
    // reason text survives in error.message, the rejection category does
    // not. hcn reports the raw wrapper unchanged with isError true and
    // invents no denial metadata: no error.denial event, no
    // done.denialCount, whatever the message text looks like.
    const errorWrapper = (message: string, command: string) => ({
      status: "error",
      error: { message, command, workingDirectory: "/w" },
    });
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              {
                stream: {
                  type: "tool_call",
                  call_id: "call-d",
                  name: "shell",
                  status: "running",
                  args: { command: "rm -rf /" },
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "call-d",
                  name: "shell",
                  status: "completed",
                  args: { command: "rm -rf /" },
                  result: errorWrapper("sandbox denied the command", "rm -rf /"),
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "call-e",
                  name: "shell",
                  status: "running",
                  args: { command: "slow" },
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "call-e",
                  name: "shell",
                  status: "completed",
                  args: { command: "slow" },
                  result: errorWrapper("Command timed out after 5ms", "slow"),
                },
              },
              { step: { type: "assistantMessage", message: { text: "done" } } },
            ],
          }),
        ],
      },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      expect(events.filter((event) => event.kind === "tool")).toHaveLength(2);
      // Both completions forward their raw wrapper verbatim, flagged
      // isError; rejection-looking text is not privileged over a timeout.
      expect(events.filter((event) => event.kind === "tool-result")).toEqual([
        {
          kind: "tool-result",
          name: "shell",
          callId: "call-d",
          result: errorWrapper("sandbox denied the command", "rm -rf /"),
          isError: true,
        },
        {
          kind: "tool-result",
          name: "shell",
          callId: "call-e",
          result: errorWrapper("Command timed out after 5ms", "slow"),
          isError: true,
        },
      ]);
      // No denial is invented from prose: no error event at all, and the
      // done record carries no denialCount.
      expect(events.filter((event) => event.kind === "error")).toEqual([]);
      const done = events.at(-1) as Record<string, unknown>;
      expect(done.cause).toBe("clean");
      expect("denialCount" in done).toBe(false);
    } finally {
      run.cleanup();
    }
  });

  test("#438: a task boundary between two assistant messages never concatenates them", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              { delta: { type: "text-delta", text: "be" } },
              { step: { type: "assistantMessage", message: { text: "before" } } },
              { stream: { type: "task", status: "queuedFollowUp" } },
              { step: { type: "assistantMessage", message: { text: "after" } } },
            ],
          }),
        ],
      },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const messages = ndjsonOf(run.stdout).filter((event) => event.kind === "message");
      expect(messages.map((message) => message.text)).toEqual(["before", "after"]);
    } finally {
      run.cleanup();
    }
  });

  test("an error run settles from Run.wait status, not assistant text; auth open failure is surfaced", async () => {
    const errorRun = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "error",
            error: { message: "You've hit your usage limit", code: "usage_capped" },
            events: [{ step: { type: "assistantMessage", message: { text: "all good" } } }],
          }),
        ],
      },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    const authRun = await runCliWithFakeSdk({
      script: { agentId, openError: { name: "AuthenticationError", message: "Invalid API key" } },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(errorRun.status, errorRun.stderr).toBe(1);
      const done = ndjsonOf(errorRun.stdout).at(-1) as Record<string, unknown>;
      expect(done.cause).toBe("limit");
      expect(done.failure).toMatchObject({ class: "usage-limit" });
      expect(authRun.status, authRun.stderr).toBe(1);
      const events = ndjsonOf(authRun.stdout);
      expect(events.some((event) => event.message === "Invalid API key")).toBe(true);
      const authDone = events.at(-1) as Record<string, unknown>;
      expect(authDone.failure).toMatchObject({ class: "auth" });
    } finally {
      errorRun.cleanup();
      authRun.cleanup();
    }
  });

  test("a malformed SDK payload never kills the stream", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              { delta: { type: "text-delta", text: "ok" } },
              { stream: "garbage-not-a-record" },
              { delta: { type: "thinking-delta", text: "ignored" } },
              { step: { type: "assistantMessage", message: "not-a-message-object" } },
            ],
          }),
        ],
      },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const done = ndjsonOf(run.stdout).at(-1) as Record<string, unknown>;
      expect(done.cause).toBe("clean");
    } finally {
      run.cleanup();
    }
  });

  test("resume rides the open line as Agent.resume; a bare CLI UUID refuses as incompatible", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished" })] },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--resume",
        agentId,
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const resume = run.calls[0] as { phase?: string; agentId?: string };
      expect(resume.phase).toBe("resume");
      expect(resume.agentId).toBe(agentId);
    } finally {
      run.cleanup();
    }
    const refused = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished" })] },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--resume",
        cliUuid,
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("not an SDK conversation id");
      expect(refused.calls).toHaveLength(0);
    } finally {
      refused.cleanup();
    }
  });

  test("explicit --effort medium on the bare gpt-5.3-codex slug pins reasoning medium, fast false", async () => {
    // The CLI grammar folds medium onto the bare slug (effortSlugs row:
    // medium = gpt-5.3-codex), so the slug alone loses the caller's
    // choice; the effort word rides the open line and the worker pins the
    // native parameter. Without it the exact id keeps the native default
    // variant (reasoning high, fast true) - asserted as the contrast.
    for (const effort of [["--effort", "medium"] as const, [] as const]) {
      const run = await runCliWithFakeSdk({
        script: {
          agentId,
          catalog: codexCatalog,
          sends: [sendOf({ status: "finished" })],
        },
        args: [
          "run",
          "cursor",
          "--json",
          "--questions",
          "none",
          "--model",
          "gpt-5.3-codex",
          ...effort,
          "--prompt",
          "fixture",
        ],
      });
      try {
        expect(run.status, run.stderr).toBe(0);
        const create = run.calls[0] as {
          phase?: string;
          options?: { model?: unknown };
        };
        expect(create.phase).toBe("create");
        expect(create.options?.model).toEqual(
          effort.length > 0 ? pinnedMedium : { id: "gpt-5.3-codex" },
        );
      } finally {
        run.cleanup();
      }
    }
  });

  test("resume with explicit effort rides Agent.resume with the same pinned selection", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        catalog: codexCatalog,
        sends: [sendOf({ status: "finished" })],
      },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--resume",
        agentId,
        "--model",
        "gpt-5.3-codex",
        "--effort",
        "medium",
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const resume = run.calls[0] as {
        phase?: string;
        agentId?: string;
        options?: { model?: unknown };
      };
      expect(resume.phase).toBe("resume");
      expect(resume.agentId).toBe(agentId);
      expect(resume.options?.model).toEqual(pinnedMedium);
    } finally {
      run.cleanup();
    }
  });

  test("a failed models.list with explicit effort surfaces the native auth error, not a config complaint", async () => {
    // The documented AuthenticationError ("Invalid API key") from the
    // catalog call: with an explicit effort that needs the catalog, the
    // original error reaches the caller as auth - never re-masked as a
    // configuration failure about effort.
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        catalogError: { name: "AuthenticationError", message: "Invalid API key" },
        sends: [sendOf({ status: "finished" })],
      },
      args: [
        "run",
        "cursor",
        "--json",
        "--questions",
        "none",
        "--model",
        "gpt-5.3-codex",
        "--effort",
        "medium",
        "--prompt",
        "fixture",
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(1);
      const events = ndjsonOf(run.stdout);
      expect(events.some((event) => event.message === "Invalid API key")).toBe(true);
      const done = events.at(-1) as Record<string, unknown>;
      expect(done.failure).toMatchObject({ class: "auth" });
      expect(run.calls).toHaveLength(0);
    } finally {
      run.cleanup();
    }
  });

  test("passthrough tokens refuse: the worker takes no native CLI flags", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished" })] },
      args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "x", "--", "--force"],
    });
    try {
      expect(run.status).toBe(2);
      expect(refusedOf(run.stderr)).toContain("passthrough");
    } finally {
      run.cleanup();
    }
  });

  test("resume-last refuses: the SDK backend has no most-recent conversation path", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId, sends: [sendOf({ status: "finished" })] },
      args: ["run", "cursor", "--json", "--questions", "none", "--resume-last", "--prompt", "x"],
    });
    try {
      expect(run.status).toBe(2);
      expect(refusedOf(run.stderr)).toContain("resumeLast");
    } finally {
      run.cleanup();
    }
  });
});

describe("hcn session cursor (built CLI, fake SDK worker)", () => {
  const sessionArgs = ["session", "cursor", "--json", "--questions", "ask"];

  test("a sequenced second send opens its own turn; the session announces the SDK agent id", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [
              { delta: { type: "text-delta", text: "MEM" } },
              { step: { type: "assistantMessage", message: { text: "MEMORIZED" } } },
            ],
          }),
          sendOf({
            status: "finished",
            events: [{ step: { type: "assistantMessage", message: { text: "violet-acorn" } } }],
          }),
        ],
      },
      args: sessionArgs,
      input: [
        {
          text: command({ op: "send", id: "one", text: "remember violet-acorn; reply MEMORIZED" }),
        },
        // Wait for the first turn's done record before the second send: a
        // real consumer sequences sends, and a raced send is the busy test
        // below.
        {
          text: command({ op: "send", id: "two", text: "what was the word?" }),
          waitFor: '"kind":"done"',
        },
        { text: command({ op: "close" }), waitFor: '"kind":"done"', occurrences: 2 },
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      expect(events[0]).toMatchObject({ kind: "session", sessionId: expect.any(String) });
      const identity = events.find((event) => event.kind === "identity") as { sessionId?: string };
      expect(identity.sessionId).toBe(agentId);
      // The session surface takes no access options: its open line carries
      // no hcn tool restriction, so the SDK's native defaults apply.
      const open = run.calls.find((call) => call.phase === "create") as {
        options?: Record<string, unknown>;
      };
      expect(open.options?.tools).toBeUndefined();
      expect(open.options?.disallowedTools).toBeUndefined();
      expect(open.options?.local).not.toHaveProperty("sandboxOptions");
      expect(events.filter((event) => event.kind === "turn")).toHaveLength(2);
      const messages = events.filter((event) => event.kind === "message");
      expect(messages.map((message) => message.text)).toEqual(["MEMORIZED", "violet-acorn"]);
      expect(
        events.filter((event) => event.kind === "disposition").map((d) => d.disposition),
      ).toEqual(["started", "started"]);
      expect(run.calls.filter((call) => call.phase === "send")).toHaveLength(2);
    } finally {
      run.cleanup();
    }
  });

  test("answer is accepted only with an open question (escalation protocol over the SDK)", async () => {
    const questionText =
      'Sure.\n```hcn-question\n{"question": "deploy?", "options": ["yes", "no"], "recommended": "no"}\n```\n';
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [{ step: { type: "assistantMessage", message: { text: questionText } } }],
          }),
          sendOf({
            status: "finished",
            events: [{ step: { type: "assistantMessage", message: { text: "deployed" } } }],
          }),
        ],
      },
      args: sessionArgs,
      input: [
        { text: command({ op: "send", id: "q1", text: "should we deploy?" }) },
        // The answer is legal only once the question is open
        // (awaiting-input) - wait for that exact state.
        {
          text: command({ op: "answer", id: "a1", text: "no" }),
          waitFor: '"cause":"awaiting-input"',
        },
        { text: command({ op: "close" }), waitFor: '"kind":"done"', occurrences: 2 },
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      const question = events.find((event) => event.kind === "question");
      expect(question).toMatchObject({
        question: "deploy?",
        options: ["yes", "no"],
        recommended: "no",
      });
      const doneCauses = events
        .filter((event) => event.kind === "done")
        .map((event) => event.cause);
      expect(doneCauses).toEqual(["awaiting-input", "clean"]);
      const secondSend = run.calls.filter((call) => call.phase === "send")[1] as {
        message?: string;
      };
      expect(secondSend.message).toContain("The user answered the question");
    } finally {
      run.cleanup();
    }
  });

  test("an interrupt during generation settles interrupted on the native cancelled turn end", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [sendOf({ holdOpen: true, events: [{ delta: { type: "text-delta", text: "w" } }] })],
      },
      args: sessionArgs,
      input: [
        { text: command({ op: "send", id: "slow", text: "write an essay" }) },
        // Interrupt once generation is live (the first token arrived).
        { text: command({ op: "interrupt", id: "i1" }), waitFor: '"kind":"token"' },
        { text: command({ op: "close" }), waitFor: '"state":"interrupted"' },
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      const interruptReceipts = events.filter((event) => event.kind === "interruption");
      expect(interruptReceipts.at(-1)).toMatchObject({ id: "i1", state: "interrupted" });
      // A cancelled session turn ends clean like every harness: the
      // interruption receipt carries the native cancellation truth.
      const doneCauses = events
        .filter((event) => event.kind === "done")
        .map((event) => event.cause);
      expect(doneCauses).toEqual(["clean"]);
      expect(run.calls.filter((call) => call.phase === "cancel")).toHaveLength(1);
    } finally {
      run.cleanup();
    }
  });

  test("a raced send forwards the native busy rejection as a disposition, not a queue", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({ holdOpen: true, events: [{ delta: { type: "text-delta", text: "w" } }] }),
          sendOf({ busy: true }),
        ],
      },
      args: sessionArgs,
      input: [
        { text: command({ op: "send", id: "slow", text: "write an essay" }) },
        {
          text: command({ op: "send", id: "raced", text: "meanwhile" }),
          waitFor: '"kind":"token"',
        },
        { text: command({ op: "interrupt", id: "i1" }), waitFor: '"reason":"native-rejected"' },
        { text: command({ op: "close" }), waitFor: '"state":"interrupted"' },
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      const raced = events.find((event) => event.kind === "disposition" && event.id === "raced");
      expect(raced).toMatchObject({ disposition: "rejected", reason: "native-rejected" });
      // The SDK rejected the busy send; only the original run was cancelled.
      expect(run.calls.filter((call) => call.phase === "cancel")).toHaveLength(1);
    } finally {
      run.cleanup();
    }
  });

  test("a session opened with explicit effort pins the native parameter on the open line", async () => {
    const run = await runCliWithFakeSdk({
      script: {
        agentId,
        catalog: codexCatalog,
        sends: [
          sendOf({
            status: "finished",
            events: [{ step: { type: "assistantMessage", message: { text: "ok" } } }],
          }),
        ],
      },
      args: [...sessionArgs, "--model", "gpt-5.3-codex", "--effort", "medium"],
      input: [
        { text: command({ op: "send", id: "one", text: "hello" }) },
        { text: command({ op: "close" }), waitFor: "ok" },
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(0);
      const create = run.calls[0] as {
        phase?: string;
        options?: { model?: unknown };
      };
      expect(create.phase).toBe("create");
      expect(create.options?.model).toEqual(pinnedMedium);
    } finally {
      run.cleanup();
    }
  });

  test("resume from another process rides the open line; a missing conversation surfaces the native error", async () => {
    const ok = await runCliWithFakeSdk({
      script: {
        agentId,
        sends: [
          sendOf({
            status: "finished",
            events: [{ step: { type: "assistantMessage", message: { text: "recalled" } } }],
          }),
        ],
      },
      args: [...sessionArgs, "--resume", agentId],
      input: [
        { text: command({ op: "send", id: "one", text: "continue" }) },
        { text: command({ op: "close" }), waitFor: "recalled" },
      ],
    });
    try {
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.calls[0]).toMatchObject({ phase: "resume", agentId });
      expect(events0Of(ok.stdout)).toMatchObject({ kind: "session", origin: "resumed" });
    } finally {
      ok.cleanup();
    }
    const missing = await runCliWithFakeSdk({
      script: {
        agentId,
        resumeError: { name: "AgentNotFoundError", message: `Agent ${agentId} not found` },
      },
      args: [...sessionArgs, "--resume", agentId],
      input: [{ text: command({ op: "close" }) }],
    });
    try {
      expect(missing.status, missing.stderr).toBe(1);
      const events = ndjsonOf(missing.stdout);
      // The refused resume surfaces in the closed record's native failure.
      const closed = events.at(-1) as Record<string, unknown>;
      expect(closed.kind).toBe("closed");
      expect(String((closed.failure as Record<string, unknown>)?.message ?? "")).toContain(
        "not found",
      );
    } finally {
      missing.cleanup();
    }
  });

  test("a bare CLI UUID refuses on the session surface too", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId },
      args: [...sessionArgs, "--resume", cliUuid],
      input: [{ text: command({ op: "close" }) }],
    });
    try {
      expect(run.status).toBe(2);
      expect(refusedOf(run.stderr)).toContain("not an SDK conversation id");
    } finally {
      run.cleanup();
    }
  });

  test("an open failure closes the session with a failure, never a hang", async () => {
    const run = await runCliWithFakeSdk({
      script: { agentId, openError: { name: "AuthenticationError", message: "Invalid API key" } },
      args: sessionArgs,
      input: [
        { text: command({ op: "send", id: "one", text: "hello" }) },
        { text: command({ op: "close" }), waitFor: '"kind":"failure"' },
      ],
    });
    try {
      expect(run.status, run.stderr).toBe(1);
      const events = ndjsonOf(run.stdout);
      const failure = events.find((event) => event.kind === "failure") as Record<string, unknown>;
      expect(failure?.class).toBe("auth");
      const closed = events.at(-1) as Record<string, unknown>;
      expect(closed.kind).toBe("closed");
    } finally {
      run.cleanup();
    }
  });
});

describe("built CLI under Bun", () => {
  test("run reaches the same worker wire when the CLI itself runs under Bun", async () => {
    const run = await runCliWithFakeSdk(
      {
        script: {
          agentId,
          sends: [
            sendOf({
              status: "finished",
              events: [
                { delta: { type: "text-delta", text: "B" } },
                { step: { type: "assistantMessage", message: { text: "BUN_OK" } } },
              ],
            }),
          ],
        },
        args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
      },
      "bun",
    );
    try {
      expect(run.status, run.stderr).toBe(0);
      const events = ndjsonOf(run.stdout);
      expect(events.some((event) => event.kind === "token" && event.text === "B")).toBe(true);
      expect(events.some((event) => event.kind === "message" && event.text === "BUN_OK")).toBe(
        true,
      );
      expect((events.at(-1) as Record<string, unknown>).cause).toBe("clean");
    } finally {
      run.cleanup();
    }
  });

  test("a usage-limit run settles with cause limit under Bun", async () => {
    const run = await runCliWithFakeSdk(
      {
        script: {
          agentId,
          sends: [
            sendOf({
              status: "error",
              error: { message: "You've hit your usage limit", code: "usage_capped" },
            }),
          ],
        },
        args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
      },
      "bun",
    );
    try {
      expect(run.status, run.stderr).toBe(1);
      const done = ndjsonOf(run.stdout).at(-1) as Record<string, unknown>;
      expect(done.cause).toBe("limit");
      expect(done.failure).toMatchObject({ class: "usage-limit" });
    } finally {
      run.cleanup();
    }
  });

  test("explicit effort pins the same native parameter under Bun", async () => {
    const run = await runCliWithFakeSdk(
      {
        script: {
          agentId,
          catalog: codexCatalog,
          sends: [sendOf({ status: "finished" })],
        },
        args: [
          "run",
          "cursor",
          "--json",
          "--questions",
          "none",
          "--model",
          "gpt-5.3-codex",
          "--effort",
          "medium",
          "--prompt",
          "fixture",
        ],
      },
      "bun",
    );
    try {
      expect(run.status, run.stderr).toBe(0);
      const create = run.calls[0] as {
        phase?: string;
        options?: { model?: unknown };
      };
      expect(create.phase).toBe("create");
      expect(create.options?.model).toEqual(pinnedMedium);
    } finally {
      run.cleanup();
    }
  });
});

/** Refusal text lives on stderr interleaved with provenance lines. */
const refusedOf = (stderr: string): string => stderr;

/** The opening session record of a JSON session stream. */
const events0Of = (stdout: string): Record<string, unknown> | undefined => ndjsonOf(stdout)[0];
