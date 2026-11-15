import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { command, ndjsonOf, runCliWithFakeSdk, sendOf } from "../../test/cli/cursor-sdk-fixture.js";

// Run this proof from the main checkout, passing the built CLI to check.
// The selected binary can belong to a base-revision proof checkout.
const cliPath = resolve(process.argv[2] ?? "dist/cli.js");
const runtime = (process.argv[3] ?? "node") as "node" | "bun";
const part = process.argv[4] ?? "all";
assert(["node", "bun"].includes(runtime));
assert(["all", "run", "session", "resume", "effort"].includes(part));
const agentId = "agent-00000000-0000-4000-8000-000000000001";
const step = (text: string) => ({ step: { type: "assistantMessage", message: { text } } });
if (part === "all" || part === "run") {
  const run = await runCliWithFakeSdk(
    {
      cliPath,
      script: {
        agentId,
        sends: [
          sendOf({
            events: [
              { delta: { type: "text-delta", text: "first" } },
              step("first"),
              { stream: { type: "task", status: "completed" } },
              step("second"),
              {
                stream: {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "running",
                  args: { path: "seed" },
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "running",
                  args: { path: "seed" },
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "c1",
                  name: "read",
                  status: "completed",
                  result: { text: "seed" },
                },
              },
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
        "--access",
        "read",
        "--autonomy",
        "--prompt",
        "fixture",
      ],
    },
    runtime,
  );
  try {
    assert.equal(run.status, 0, `Cursor SDK run failed: ${run.stderr}`);
    const events = ndjsonOf(run.stdout);
    assert.deepEqual(
      events.filter((e) => e.kind === "token").map((e) => e.text),
      ["first"],
    );
    assert.deepEqual(
      events.filter((e) => e.kind === "message").map((e) => e.text),
      ["first", "second"],
    );
    assert.equal(events.filter((e) => e.kind === "tool").length, 1);
    assert.equal(events.filter((e) => e.kind === "tool-result").length, 1);
    assert.equal(events.filter((e) => e.kind === "usage").length, 1);
    assert.equal(events.at(-1)?.cause, "clean");
    const options = run.calls[0]?.options as {
      model: { id: string; params: { id: string; value: string }[] };
      tools: string[];
      disallowedTools: string[];
    };
    assert.equal(options.model.id, "grok-4.7");
    assert(options.model.params.some((p) => p.id === "reasoning_effort" && p.value === "high"));
    assert.deepEqual(options.tools, ["read", "grep", "glob", "ls", "webFetch", "webSearch"]);
    assert.deepEqual(options.disallowedTools, ["task", "mcp"]);
  } finally {
    run.cleanup();
  }
  const shellFailure = { status: "success", value: { exitCode: 7, stdout: "", stderr: "" } };
  const shellError = { status: "error", error: { message: "Command rejected" } };
  const toolErrors = await runCliWithFakeSdk(
    {
      cliPath,
      script: {
        sends: [
          sendOf({
            events: [
              {
                stream: {
                  type: "tool_call",
                  call_id: "exit-seven",
                  name: "shell",
                  status: "running",
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "exit-seven",
                  name: "shell",
                  status: "completed",
                  result: shellFailure,
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "opaque-error",
                  name: "shell",
                  status: "running",
                },
              },
              {
                stream: {
                  type: "tool_call",
                  call_id: "opaque-error",
                  name: "shell",
                  status: "error",
                  result: shellError,
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
        "--access",
        "write",
        "--prompt",
        "fixture",
      ],
    },
    runtime,
  );
  try {
    assert.equal(toolErrors.status, 0, toolErrors.stderr);
    const events = ndjsonOf(toolErrors.stdout);
    const results = events.filter((e) => e.kind === "tool-result");
    assert.deepEqual(
      results.map((e) => e.isError),
      [true, true],
    );
    assert.deepEqual(
      results.map((e) => e.result),
      [shellFailure, shellError],
    );
    assert.equal(events.filter((e) => e.kind === "tool").length, 2);
    assert.equal(events.filter((e) => e.kind === "error" && e.denial !== undefined).length, 0);
    assert.equal(events.at(-1)?.denialCount, undefined);
    assert.equal(events.at(-1)?.cause, "clean");
  } finally {
    toolErrors.cleanup();
  }
}

if (part === "all" || part === "session") {
  const question =
    '```hcn-question\n{"question":"Continue?","options":["yes","no"],"recommended":"no"}\n```';
  const session = await runCliWithFakeSdk(
    {
      cliPath,
      script: {
        agentId,
        sends: [
          sendOf({ events: [step("remembered")] }),
          sendOf({ events: [step("recalled")] }),
          sendOf({ events: [step(question)] }),
          sendOf({ events: [step("answered")] }),
          sendOf({ holdOpen: true, events: [{ delta: { type: "text-delta", text: "waiting" } }] }),
          sendOf({ busy: true }),
        ],
      },
      args: ["session", "cursor", "--json", "--model", "grok-4.7-high", "--questions", "ask"],
      input: [
        { text: command({ op: "send", id: "first", text: "remember" }) },
        { text: command({ op: "send", id: "second", text: "recall" }), waitFor: '"kind":"done"' },
        {
          text: command({ op: "send", id: "question", text: "ask" }),
          waitFor: '"kind":"done"',
          occurrences: 2,
        },
        {
          text: command({ op: "answer", id: "answer", text: "no" }),
          waitFor: '"cause":"awaiting-input"',
        },
        {
          text: command({ op: "send", id: "long", text: "essay" }),
          waitFor: '"kind":"done"',
          occurrences: 4,
        },
        {
          text: command({ op: "send", id: "busy", text: "meanwhile" }),
          waitFor: '"text":"waiting"',
        },
        { text: command({ op: "interrupt", id: "stop" }), waitFor: '"reason":"native-rejected"' },
        { text: command({ op: "close" }), waitFor: '"state":"interrupted"' },
      ],
    },
    runtime,
  );
  try {
    assert.equal(session.status, 0, `Cursor SDK session failed: ${session.stderr}`);
    const events = ndjsonOf(session.stdout);
    assert.equal(events.find((e) => e.kind === "identity")?.sessionId, agentId);
    assert.equal(events.filter((e) => e.kind === "done").length, 5);
    assert(events.some((e) => e.kind === "question"));
    assert(events.some((e) => e.kind === "interruption" && e.state === "interrupted"));
    assert(
      events.some(
        (e) => e.kind === "disposition" && e.id === "busy" && e.reason === "native-rejected",
      ),
    );
    assert.equal(events.at(-1)?.kind, "closed");
  } finally {
    session.cleanup();
  }
}

if (part === "all" || part === "resume") {
  for (const access of ["read", "write"] as const) {
    const resumed = await runCliWithFakeSdk(
      {
        cliPath,
        script: { agentId, sends: [sendOf({ events: [step("resumed")] })] },
        args: [
          "run",
          "cursor",
          "--json",
          "--resume",
          agentId,
          "--access",
          access,
          "--prompt",
          "resume",
        ],
      },
      runtime,
    );
    try {
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(resumed.calls[0]?.phase, "resume");
      assert.equal(resumed.calls[0]?.agentId, agentId);
      const options = resumed.calls[0]?.options as {
        tools?: string[];
        disallowedTools?: string[];
        local: { sandboxOptions?: { enabled: boolean } };
      };
      if (access === "read") {
        assert.deepEqual(options.tools, ["read", "grep", "glob", "ls", "webFetch", "webSearch"]);
        assert.deepEqual(options.disallowedTools, ["task", "mcp"]);
      } else {
        assert.equal(options.tools, undefined);
        assert.equal(options.local.sandboxOptions?.enabled, false);
      }
      assert.equal(ndjsonOf(resumed.stdout).at(-1)?.cause, "clean");
    } finally {
      resumed.cleanup();
    }
  }
}
if (part === "all" || part === "effort") {
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../test/fixtures/cursor-sdk-1.0.38/models.full.snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  for (const mode of ["run", "session", "resume"] as const) {
    const session = mode === "session";
    const checked = await runCliWithFakeSdk(
      {
        cliPath,
        script: { catalog, agentId, sends: [sendOf({})] },
        args: [
          session ? "session" : "run",
          "cursor",
          "--json",
          "--questions",
          "none",
          "--model",
          "gpt-5.3-codex",
          "--effort",
          "medium",
          ...(mode === "resume" ? ["--resume", agentId] : []),
          ...(session ? [] : ["--prompt", "fixture"]),
        ],
        ...(session
          ? {
              input: [
                { text: command({ op: "send", id: "effort", text: "fixture" }) },
                { text: command({ op: "close" }), waitFor: '"kind":"done"' },
              ],
            }
          : {}),
      },
      runtime,
    );
    try {
      assert.equal(checked.status, 0, `${mode}: ${checked.stderr}\n${checked.stdout}`);
      assert.equal(checked.calls[0]?.phase, mode === "resume" ? "resume" : "create");
      if (mode === "resume") assert.equal(checked.calls[0]?.agentId, agentId);
      const options = checked.calls[0]?.options as {
        model: { id: string; params: { id: string; value: string }[] };
      };
      assert.equal(options.model.id, "gpt-5.3-codex");
      assert.deepEqual(options.model.params, [
        { id: "reasoning", value: "medium" },
        { id: "fast", value: "false" },
      ]);
    } finally {
      checked.cleanup();
    }
  }
}
console.log(JSON.stringify({ cliPath, runtime, checked: part, status: "passed" }));
